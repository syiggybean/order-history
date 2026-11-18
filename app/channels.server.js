import db from "./db.server";
import { unauthenticated } from "./shopify.server";

// ---------------------------------------------------------------------------
// Sales channel changes, for the inventory history: a product added to or
// removed from Online Store, Shop, POS, Google & YouTube, etc.
//
// Shopify keeps no record of which channel a product left, so the app keeps
// its own: the channels each product is on (ProductChannel), compared again
//   1. right after every product notification (exact time), and
//   2. in a full check of every channel every half hour (catches anything
//      Shopify didn't notify about; the time is then "between" two checks).
// Who did it comes from Shopify's event log (a product's "published" and
// "unpublished" entries), matched up by product and time. That log also
// gives a year of earlier changes, though without the channel unless
// Shopify's own wording names it.
//
// Reading channels needs the read_publications permission. Without it, only
// Shopify's log is used (who and when, usually not which channel).
// ---------------------------------------------------------------------------

export const SUBJECT = "channel";
const PRODUCT = "gid://shopify/Product/";
const SWEEP_EVERY_MS = 30 * 60 * 1000;
const NEW_PRODUCT_MS = 15 * 60 * 1000; // a channel added as a product is created is part of creating it
const MATCH_MS = 10 * 60 * 1000;
const RECENT_EVENT_MS = 30 * 60 * 1000;
const SCOPE_RECHECK_MS = 6 * 3600 * 1000;
const BACKFILL_DAYS = 365;

const clean = (s) => (s == null || String(s).trim() === "" ? null : String(s).trim());
const gid = (v) => (v == null ? null : String(v).startsWith("gid://") ? String(v) : `${PRODUCT}${v}`);

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const body = await res.json();
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    const err = new Error(msg);
    err.denied = /access denied|read_publications|not approved|scope/i.test(msg);
    throw err;
  }
  return body.data;
}

// One thing at a time per shop, so a notification and a full check never
// both record the same change
const chains = new Map();
function serial(shop, fn) {
  const prev = chains.get(shop) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(shop, next);
  next.finally(() => chains.get(shop) === next && chains.delete(shop)).catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

const SCOPES = `#graphql
  query ChannelScopes { currentAppInstallation { accessScopes { handle } } }`;

async function canReadChannels(shop, admin) {
  const s = await db.channelSync.upsert({ where: { shop }, create: { shop }, update: {} });
  if (s.scopeOk != null && s.scopeCheckedAt && Date.now() - s.scopeCheckedAt.getTime() < SCOPE_RECHECK_MS) return s.scopeOk;
  let ok = false;
  try {
    const data = await gql(admin, SCOPES, {});
    const handles = (data?.currentAppInstallation?.accessScopes ?? []).map((x) => x.handle);
    ok = handles.includes("read_publications") || handles.includes("write_publications");
  } catch {
    ok = Boolean(s.scopeOk);
  }
  await db.channelSync.update({ where: { shop }, data: { scopeOk: ok, scopeCheckedAt: new Date() } });
  return ok;
}

// For the inventory page: can it show which channel?
export async function channelStatus(shop) {
  const s = await db.channelSync.findUnique({ where: { shop } });
  if (!s || s.scopeOk == null) return { state: "starting" };
  if (!s.scopeOk) return { state: "noScope" };
  const started = await db.salesChannel.findFirst({ where: { shop, baselineAt: { not: null } }, orderBy: { baselineAt: "asc" } });
  return { state: started ? "on" : "starting", since: started?.baselineAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// The channels
// ---------------------------------------------------------------------------

const CHANNELS = `#graphql
  query SalesChannels($after: String) {
    publications(first: 50, after: $after, catalogType: APP) {
      nodes { id name catalog { title } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const nameOf = (p) => clean(p?.name) ?? clean(p?.catalog?.title) ?? null;

async function readChannels(shop, admin) {
  const found = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const data = await gql(admin, CHANNELS, { after });
    const conn = data?.publications;
    for (const p of conn?.nodes ?? []) if (p?.id) found.push({ id: p.id, name: nameOf(p) });
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const ids = new Set(found.map((c) => c.id));
  for (const c of found) {
    await db.salesChannel.upsert({
      where: { shop_publicationId: { shop, publicationId: c.id } },
      create: { shop, publicationId: c.id, name: c.name },
      update: { name: c.name ?? undefined, goneAt: null },
    });
  }
  // A channel that's gone (app uninstalled): stop comparing against it
  const known = await db.salesChannel.findMany({ where: { shop, goneAt: null } });
  for (const k of known) {
    if (ids.has(k.publicationId)) continue;
    await db.salesChannel.update({ where: { shop_publicationId: { shop, publicationId: k.publicationId } }, data: { goneAt: new Date() } });
  }
  return db.salesChannel.findMany({ where: { shop, goneAt: null } });
}

// ---------------------------------------------------------------------------
// One product: which channels is it on now, compared with last time
// ---------------------------------------------------------------------------

const PRODUCT_CHANNELS = `#graphql
  query ProductChannels($id: ID!) {
    product(id: $id) {
      id title createdAt
      variantsCount { count }
      variants(first: 1) { nodes { sku inventoryItem { id } } }
      resourcePublicationsV2(first: 50, catalogType: APP) {
        nodes { isPublished publication { id name catalog { title } } }
      }
    }
  }`;

// After a product notification (time is exact) or during a full check
// (the change happened between the last check and now)
export function checkProduct(shop, productId, opts = {}) {
  return serial(shop, () => checkProductNow(shop, productId, opts));
}

async function checkProductNow(shop, productId, { admin = null, at = new Date(), earliest = null } = {}) {
  productId = gid(productId);
  if (!productId) return [];
  const client = admin ?? (await unauthenticated.admin(shop)).admin;
  if (!(await canReadChannels(shop, client))) return [];
  const channels = await db.salesChannel.findMany({ where: { shop, goneAt: null } });
  const counted = new Map(channels.filter((c) => c.baselineAt).map((c) => [c.publicationId, c]));
  if (!counted.size) return [];

  const data = await gql(client, PRODUCT_CHANNELS, { id: productId });
  const p = data?.product;
  const had = await db.productChannel.findMany({ where: { shop, productId } });
  if (!p) {
    // Deleted: that's in the history already as a deletion
    await db.productChannel.deleteMany({ where: { shop, productId } });
    return [];
  }
  const now = new Set();
  for (const n of p.resourcePublicationsV2?.nodes ?? []) {
    const id = n?.publication?.id;
    if (!id || !n.isPublished) continue;
    now.add(id);
    // A channel we haven't seen yet: learn its name for next time
    if (!channels.some((c) => c.publicationId === id)) {
      await db.salesChannel.upsert({
        where: { shop_publicationId: { shop, publicationId: id } },
        create: { shop, publicationId: id, name: nameOf(n.publication) },
        update: {},
      });
    }
  }
  const before = new Set(had.map((h) => h.publicationId));
  const changes = [];
  for (const [id, c] of counted) {
    if (now.has(id) && !before.has(id)) changes.push({ id, name: c.name, action: "added" });
    if (!now.has(id) && before.has(id)) changes.push({ id, name: c.name, action: "removed" });
  }
  for (const ch of changes) {
    if (ch.action === "added") {
      await db.productChannel.upsert({
        where: { shop_productId_publicationId: { shop, productId, publicationId: ch.id } },
        create: { shop, productId, publicationId: ch.id, since: at },
        update: {},
      });
    } else {
      await db.productChannel.deleteMany({ where: { shop, productId, publicationId: ch.id } });
    }
  }
  if (!changes.length) return [];

  const single = (p.variantsCount?.count ?? 0) === 1 ? p.variants?.nodes?.[0] : null;
  const created = p.createdAt ? new Date(p.createdAt) : null;
  // Created just now, or (found by a full check) since the last check
  const isNew = created && (at - created <= NEW_PRODUCT_MS || (earliest && created >= earliest));
  // Already recorded from Shopify's log (e.g. while the app was offline): give it the channel
  const fresh = [];
  for (const ch of changes) {
    const logged = await db.catalogEvent.findFirst({
      where: {
        shop,
        subject: SUBJECT,
        productId,
        action: ch.action,
        source: "events",
        OR: [{ channelId: null }, { channelId: ch.id }],
        occurredAt: { gte: new Date((earliest ?? at).getTime() - MATCH_MS), lte: new Date(at.getTime() + MATCH_MS) },
      },
    });
    if (logged) {
      if (!logged.channelId) await db.catalogEvent.update({ where: { id: logged.id }, data: { channelId: ch.id, channel: ch.name } });
    } else fresh.push(ch);
  }
  const rows = fresh.map((ch) => ({
    shop,
    subject: SUBJECT,
    subjectId: `${productId}|${ch.id}|${at.getTime()}`,
    action: ch.action,
    productId,
    productTitle: clean(p.title),
    sku: clean(single?.sku),
    inventoryItemId: single?.inventoryItem?.id ?? null,
    channelId: ch.id,
    channel: ch.name,
    earliest,
    source: earliest ? "check" : "webhook",
    // Put on its channels as it was created: part of creating it
    hidden: Boolean(isNew && ch.action === "added"),
    occurredAt: at,
  }));
  if (rows.length) await db.catalogEvent.createMany({ data: rows, skipDuplicates: true });
  return rows;
}

// ---------------------------------------------------------------------------
// Full check: every product on every channel
// ---------------------------------------------------------------------------

const CHANNEL_PRODUCTS = `#graphql
  query ChannelProducts($id: ID!, $after: String) {
    publication(id: $id) {
      products(first: 250, after: $after) {
        nodes { id }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

async function productsOn(admin, publicationId) {
  const ids = new Set();
  let after = null;
  for (let page = 0; page < 400; page++) {
    const data = await gql(admin, CHANNEL_PRODUCTS, { id: publicationId, after });
    const conn = data?.publication?.products;
    for (const n of conn?.nodes ?? []) if (n?.id) ids.add(n.id);
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return ids;
}

export function sweep(shop, admin, { force = false } = {}) {
  return serial(shop, () => sweepNow(shop, admin, { force }));
}

async function sweepNow(shop, admin, { force }) {
  const s = await db.channelSync.upsert({ where: { shop }, create: { shop }, update: {} });
  if (!force && s.lastSweepAt && Date.now() - s.lastSweepAt.getTime() < SWEEP_EVERY_MS) return { skipped: true };
  if (!(await canReadChannels(shop, admin))) return { noScope: true };
  await db.channelSync.update({ where: { shop }, data: { lastSweepAt: new Date() } });

  const channels = await readChannels(shop, admin);
  const toCheck = new Map(); // productId -> earliest
  let baselined = 0;
  for (const c of channels) {
    const started = new Date();
    const live = await productsOn(admin, c.publicationId);
    const key = { shop_publicationId: { shop, publicationId: c.publicationId } };
    if (!c.baselineAt) {
      // First read of this channel: what's on it now is the starting point
      await db.productChannel.deleteMany({ where: { shop, publicationId: c.publicationId } });
      const rows = [...live].map((productId) => ({ shop, productId, publicationId: c.publicationId, since: started }));
      for (let i = 0; i < rows.length; i += 1000) await db.productChannel.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
      await db.salesChannel.update({ where: key, data: { baselineAt: started, sweptAt: started } });
      baselined++;
      continue;
    }
    const known = new Set((await db.productChannel.findMany({ where: { shop, publicationId: c.publicationId }, select: { productId: true } })).map((r) => r.productId));
    const since = c.sweptAt ?? c.baselineAt;
    for (const id of live) if (!known.has(id)) toCheck.set(id, since);
    for (const id of known) if (!live.has(id)) toCheck.set(id, since);
    await db.salesChannel.update({ where: key, data: { sweptAt: started } });
  }
  // Each difference is confirmed by reading that product (and recorded there)
  let found = 0;
  for (const [productId, earliest] of toCheck) {
    try {
      found += (await checkProductNow(shop, productId, { admin, at: new Date(), earliest })).length;
    } catch (e) {
      console.error(`[channels] ${shop} ${productId}:`, e?.message ?? e);
    }
  }
  return { baselined, found };
}

// ---------------------------------------------------------------------------
// Shopify's event log: who, and earlier history
// ---------------------------------------------------------------------------

const EVENTS = `#graphql
  query ChannelEvents($q: String!, $after: String) {
    events(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
      nodes {
        id createdAt action message
        ... on BasicEvent { subjectId subjectType author appTitle attributeToApp attributeToUser arguments additionalData }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const PRODUCT_TITLE = `#graphql
  query ChannelProductTitle($id: ID!) { product(id: $id) { title variantsCount { count } variants(first: 1) { nodes { sku inventoryItem { id } } } } }`;

function plain(message) {
  return String(message ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// Who did it, as Shopify tells it
export function whoOf(ev) {
  const text = plain(ev?.message);
  const app = ev?.attributeToApp ? clean(ev.appTitle) : null;
  const fromText = ev?.attributeToUser ? text.match(/^(.+?) (published|unpublished|hid|removed|made)\b/i)?.[1] ?? null : null;
  const staff = clean(ev?.author) ?? clean(fromText);
  return { staffName: staff, appName: staff && app === staff ? null : app };
}

// The channel, when Shopify's wording or extra data names one we know
export function channelIn(ev, channels) {
  const hay = `${plain(ev?.message)} ${JSON.stringify(ev?.arguments ?? "")} ${JSON.stringify(ev?.additionalData ?? "")}`.toLowerCase();
  const named = channels
    .filter((c) => c.name && hay.includes(c.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length); // "Online Store" before "Store"
  if (named[0]) return named[0];
  const pubId = hay.match(/gid:\/\/shopify\/publication\/\d+/i)?.[0];
  if (pubId) return channels.find((c) => c.publicationId.toLowerCase() === pubId) ?? null;
  return null;
}

export function syncEvents(shop, admin) {
  return serial(shop, () => syncEventsNow(shop, admin));
}

async function syncEventsNow(shop, admin) {
  const s = await db.channelSync.upsert({ where: { shop }, create: { shop }, update: {} });
  const from = s.eventsCursor
    ? new Date(new Date(s.eventsCursor).getTime() - 2 * 60 * 1000).toISOString()
    : new Date(Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000).toISOString();
  let newest = s.eventsCursor ?? null;
  let stored = 0;
  const channels = await db.salesChannel.findMany({ where: { shop } });
  for (const verb of ["published", "unpublished"]) {
    const q = `subject_type:PRODUCT action:${verb} created_at:>='${from}'`;
    let after = null;
    for (let page = 0; page < 200; page++) {
      const data = await gql(admin, EVENTS, { q, after });
      const conn = data?.events;
      for (const ev of conn?.nodes ?? []) {
        if (!ev?.subjectId || (ev.subjectType && ev.subjectType !== "PRODUCT") || (ev.action && ev.action !== verb)) continue;
        if (await storeEvent(shop, admin, verb, ev, channels)) stored++;
        if (!newest || ev.createdAt > newest) newest = ev.createdAt;
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  }
  if (newest) await db.channelSync.update({ where: { shop }, data: { eventsCursor: newest } });
  return stored;
}

async function storeEvent(shop, admin, verb, ev, channels) {
  // Read before: an earlier read already used it
  if (await db.catalogEvent.findFirst({ where: { shop, subject: SUBJECT, eventId: ev.id } })) return false;
  const productId = gid(ev.subjectId);
  const action = verb === "published" ? "added" : "removed";
  const at = new Date(ev.createdAt);
  const who = whoOf(ev);
  const fill = { ...who, message: plain(ev.message).slice(0, 1000) || null, eventId: ev.id };

  const match = async () => {
    const rows = await db.catalogEvent.findMany({
      where: { shop, subject: SUBJECT, productId, action, eventId: null },
      orderBy: { occurredAt: "asc" },
    });
    return rows.filter((r) =>
      r.earliest ? at >= new Date(r.earliest.getTime() - MATCH_MS) && at <= new Date(r.occurredAt.getTime() + MATCH_MS) : Math.abs(r.occurredAt - at) <= MATCH_MS,
    );
  };

  let rows = await match();
  // Recent, and nothing noticed yet: look at the product now
  if (!rows.length && Date.now() - at.getTime() < RECENT_EVENT_MS) {
    try {
      await checkProductNow(shop, productId, { admin, at });
    } catch {
      // Recorded from the log below instead
    }
    rows = await match();
  }
  if (rows.length) {
    // One entry in Shopify's log can cover several channels changed at once
    for (const r of rows) {
      await db.catalogEvent.update({
        where: { id: r.id },
        data: { ...fill, eventId: r === rows[0] ? ev.id : `${ev.id}#${r.id}`, ...(r.earliest ? { occurredAt: at, earliest: null } : {}) },
      });
    }
    return true;
  }
  // Already shown from another entry made at the same moment (one per channel)
  const twin = await db.catalogEvent.findFirst({
    where: { shop, subject: SUBJECT, productId, action, occurredAt: { gte: new Date(at.getTime() - 2 * 60 * 1000), lte: new Date(at.getTime() + 2 * 60 * 1000) } },
  });
  if (twin) return false;

  // From the log alone (before the app was watching, or no permission to read channels)
  const ch = channelIn(ev, channels);
  let info = await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId } } });
  let title = clean(info?.title);
  let single = null;
  if (!title) {
    try {
      const d = await gql(admin, PRODUCT_TITLE, { id: productId });
      title = clean(d?.product?.title);
      if ((d?.product?.variantsCount?.count ?? 0) === 1) single = d.product.variants?.nodes?.[0] ?? null;
    } catch {
      // Name filled in later if it turns up
    }
  }
  const created = await db.catalogEvent.findFirst({ where: { shop, subject: "product", subjectId: productId, action: "created" } });
  const createdAt = created?.occurredAt ?? info?.createdAt ?? null;
  const isNew = createdAt && Math.abs(at - createdAt) <= NEW_PRODUCT_MS;
  await db.catalogEvent.createMany({
    data: [
      {
        shop,
        subject: SUBJECT,
        subjectId: `${productId}|${ch?.publicationId ?? "?"}|${at.getTime()}`,
        action,
        productId,
        productTitle: title,
        sku: clean(single?.sku),
        inventoryItemId: single?.inventoryItem?.id ?? null,
        channelId: ch?.publicationId ?? null,
        channel: ch?.name ?? null,
        source: "events",
        hidden: Boolean(isNew && action === "added"),
        occurredAt: at,
        ...fill,
      },
    ],
    skipDuplicates: true,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

const running = new Map();

// With the inventory history's own reading (notifications and page opens)
export function runChannels(shop, admin = null) {
  if (running.has(shop)) return running.get(shop);
  const p = (async () => {
    const client = admin ?? (await unauthenticated.admin(shop)).admin;
    try {
      await sweep(shop, client);
      await syncEvents(shop, client);
      await db.channelSync.update({ where: { shop }, data: { lastError: null } });
    } catch (e) {
      console.error(`[channels] ${shop}:`, e?.message ?? e);
      await db.channelSync
        .upsert({ where: { shop }, create: { shop, lastError: String(e?.message ?? e).slice(0, 500) }, update: { lastError: String(e?.message ?? e).slice(0, 500) } })
        .catch(() => {});
    }
  })().finally(() => running.delete(shop));
  running.set(shop, p);
  return p;
}

// A product notification: compare its channels now, while the time is exact
export function productChannelsChanged(shop, productId) {
  if (process.env.NODE_ENV === "test") return Promise.resolve([]);
  return checkProduct(shop, productId).catch((e) => {
    console.error(`[channels] product ${productId}:`, e?.message ?? e);
    return [];
  });
}

if (!globalThis.__channelTimer && process.env.NODE_ENV !== "test") {
  const tick = async () => {
    const sessions = await db.session.findMany({ where: { isOnline: false }, select: { shop: true } });
    for (const shop of new Set(sessions.map((x) => x.shop))) await runChannels(shop).catch(() => {});
  };
  globalThis.__channelTimer = setInterval(() => tick().catch(() => {}), 10 * 60 * 1000);
  setTimeout(() => tick().catch(() => {}), 90 * 1000);
}
