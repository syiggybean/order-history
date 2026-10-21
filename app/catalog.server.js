import db from "./db.server";
import { unauthenticated } from "./shopify.server";

// ---------------------------------------------------------------------------
// Product and variant creations and deletions, for the inventory history.
//
// Two sources, merged into one row per (thing, action):
//   1. Shopify's product notifications: instant, but they don't say who.
//      - products/create         → product created
//      - products/update         → variants added or removed (compared with
//                                  the variants we saw last time)
//      - products/delete         → product deleted
//   2. Shopify's event log (GraphQL `events`): who did it (staff or app),
//      and up to a year of past creations and deletions. Read shortly after
//      each notification and whenever the inventory page opens.
//
// A last-known copy of every product (CatalogProduct + CatalogVariant) is
// kept from the same notifications plus a one-time read of all products, so
// a deleted product or variant can still be described.
//
// Deleted variants Shopify won't name are worked out from, in order:
// what we stored, Shopify's stock report (variant name + SKU), the product
// the same person was editing at that moment, and past orders (by SKU).
//
// A variant created or deleted together with its whole product is hidden,
// so a new 20-variant product is one line, not 21.
// ---------------------------------------------------------------------------

const PRODUCT = "gid://shopify/Product/";
const VARIANT = "gid://shopify/ProductVariant/";
const ITEM = "gid://shopify/InventoryItem/";
const gid = (prefix, v) => (v == null ? null : String(v).startsWith("gid://") ? String(v) : `${prefix}${v}`);
const clean = (s) => (s == null || String(s).trim() === "" ? null : String(s).trim());

// Products/update payloads can be cut short for products with very many
// variants; a shortened list would look like deletions, so don't compare those
const MAX_COMPARE = 99;
const CASCADE_MS = 5 * 60 * 1000;
const BACKFILL_DAYS = 365; // Shopify keeps events for a year
const PAGE_THROTTLE_MS = 5 * 60 * 1000;

const variantRows = (shop, payload, productId) =>
  (Array.isArray(payload?.variants) ? payload.variants : []).map((v) => ({
    shop,
    variantId: gid(VARIANT, v.admin_graphql_api_id ?? v.id),
    productId,
    productTitle: clean(payload.title),
    variantTitle: clean(v.title),
    sku: clean(v.sku),
    inventoryItemId: gid(ITEM, v.inventory_item_id),
    price: clean(v.price),
    barcode: clean(v.barcode),
    position: Number.isFinite(Number(v.position)) ? Number(v.position) : null,
    source: "webhook",
  }));

// The product's last-known copy, from a notification payload
async function saveProductCopy(shop, productId, payload) {
  const data = {
    title: clean(payload.title),
    handle: clean(payload.handle),
    vendor: clean(payload.vendor),
    productType: clean(payload.product_type),
    tags: clean(Array.isArray(payload.tags) ? payload.tags.join(", ") : payload.tags),
    status: clean(payload.status),
    imageUrl: clean(payload.image?.src ?? payload.images?.[0]?.src ?? payload.featuredMedia?.preview?.image?.url),
    variantCount: Array.isArray(payload.variants) ? payload.variants.length : null,
    createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
  };
  await db.catalogProduct.upsert({
    where: { shop_productId: { shop, productId } },
    create: { shop, productId, ...data },
    update: { ...data, deletedAt: null },
  });
}

async function saveVariants(rows) {
  for (const r of rows) {
    const { shop, variantId, ...data } = r;
    await db.catalogVariant.upsert({
      where: { shop_variantId: { shop, variantId } },
      create: r,
      update: { ...data, deletedAt: null },
    });
  }
}

async function addEvents(rows) {
  if (!rows.length) return 0;
  const { count } = await db.catalogEvent.createMany({ data: rows, skipDuplicates: true });
  return count;
}

// products/create and products/update
export async function productNotified(shop, topic, payload) {
  const productId = gid(PRODUCT, payload?.admin_graphql_api_id ?? payload?.id);
  if (!productId) return { recorded: 0 };
  const now = new Date();
  const current = variantRows(shop, payload, productId);
  const created = /create/i.test(String(topic ?? ""));
  await saveProductCopy(shop, productId, payload);

  if (created) {
    const n = await addEvents([
      {
        shop,
        subject: "product",
        subjectId: productId,
        action: "created",
        productId,
        productTitle: clean(payload.title),
        sku: current.length === 1 ? current[0].sku : null,
        inventoryItemId: current.length === 1 ? current[0].inventoryItemId : null,
        occurredAt: payload.created_at ? new Date(payload.created_at) : now,
      },
    ]);
    await saveVariants(current);
    scheduleSync(shop);
    return { recorded: n };
  }

  // An edit: which variants came and went since last time?
  const known = await db.catalogVariant.findMany({ where: { shop, productId, deletedAt: null } });
  const comparable = Array.isArray(payload?.variants) && payload.variants.length < MAX_COMPARE && known.length > 0;
  const events = [];
  if (comparable) {
    const now2 = payload.updated_at ? new Date(payload.updated_at) : now;
    const ids = new Set(current.map((v) => v.variantId));
    const had = new Set(known.map((v) => v.variantId));
    for (const v of current) {
      if (!had.has(v.variantId)) {
        // Previously seen and deleted, then back? Variant IDs aren't reused, so this is new.
        const before = await db.catalogVariant.findUnique({ where: { shop_variantId: { shop, variantId: v.variantId } } });
        if (!before) events.push(variantEvent(v, "created", now2));
      }
    }
    const gone = known.filter((v) => !ids.has(v.variantId));
    for (const v of gone) events.push(variantEvent(v, "deleted", now2));
    if (gone.length) {
      await db.catalogVariant.updateMany({ where: { shop, variantId: { in: gone.map((v) => v.variantId) } }, data: { deletedAt: now2 } });
    }
  }
  await saveVariants(current);
  const n = await addEvents(events);
  if (n) scheduleSync(shop);
  return { recorded: n };
}

const variantEvent = (v, action, at) => ({
  shop: v.shop,
  subject: "variant",
  subjectId: v.variantId,
  action,
  productId: v.productId,
  productTitle: v.productTitle,
  variantTitle: v.variantTitle,
  sku: v.sku,
  inventoryItemId: v.inventoryItemId,
  occurredAt: at,
});

// products/delete (the payload is just the ID)
export async function productDeleted(shop, payload) {
  const productId = gid(PRODUCT, payload?.admin_graphql_api_id ?? payload?.id);
  if (!productId) return { recorded: 0 };
  const name = await productName(shop, productId);
  const variants = await db.catalogVariant.findMany({ where: { shop, productId, deletedAt: null } });
  const n = await addEvents([
    {
      shop,
      subject: "product",
      subjectId: productId,
      action: "deleted",
      productId,
      productTitle: name,
      sku: variants.length === 1 ? variants[0].sku : null,
      inventoryItemId: variants.length === 1 ? variants[0].inventoryItemId : null,
      occurredAt: new Date(),
    },
  ]);
  await db.catalogVariant.updateMany({ where: { shop, productId, deletedAt: null }, data: { deletedAt: new Date() } });
  await db.catalogProduct.updateMany({ where: { shop, productId }, data: { deletedAt: new Date() } });
  scheduleSync(shop);
  return { recorded: n };
}

// The product's title from anything we've stored about it
async function productName(shop, productId) {
  const c = await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId } } });
  if (c?.title) return c.title;
  const v = await db.catalogVariant.findFirst({ where: { shop, productId, productTitle: { not: null } }, orderBy: { updatedAt: "desc" } });
  if (v?.productTitle) return v.productTitle;
  const i = await db.inventoryItemInfo.findFirst({ where: { shop, productId, productTitle: { not: null } } });
  if (i?.productTitle) return i.productTitle;
  const e = await db.catalogEvent.findFirst({ where: { shop, productId, productTitle: { not: null } } });
  return e?.productTitle ?? null;
}

// Everything the app has stored about a variant, even one that's gone:
// our variant list, item names, live stock notifications, stock history
async function variantInfo(shop, variantId) {
  const v = await db.catalogVariant.findUnique({ where: { shop_variantId: { shop, variantId } } });
  if (v?.productTitle) return v;
  const fromInfo = (i) => (i ? { productId: i.productId, productTitle: i.productTitle, variantTitle: i.variantTitle, sku: i.sku, inventoryItemId: i.inventoryItemId } : null);
  let found = fromInfo(await db.inventoryItemInfo.findFirst({ where: { shop, variantId } }));
  if (!found?.productTitle) {
    const e = await db.inventoryEvent.findFirst({ where: { shop, variantId, productTitle: { not: null } }, orderBy: { occurredAt: "desc" } });
    if (e) found = { productId: e.productId, productTitle: e.productTitle, variantTitle: e.variantTitle, sku: e.sku, inventoryItemId: e.inventoryItemId };
  }
  if (!found?.productTitle) {
    const a = await db.inventoryAdjustment.findFirst({ where: { shop, variantId }, orderBy: { occurredAt: "desc" } });
    if (a?.inventoryItemId) {
      const i = fromInfo(await db.inventoryItemInfo.findFirst({ where: { shop, inventoryItemId: a.inventoryItemId } }));
      found = i?.productTitle ? i : { productId: a.productId, productTitle: null, variantTitle: null, sku: a.sku, inventoryItemId: a.inventoryItemId };
    }
  }
  if (!found && !v) return null;
  // Fill gaps in our own list from whatever else was found
  return { ...(found ?? {}), ...Object.fromEntries(Object.entries(v ?? {}).filter(([, x]) => x != null)) };
}

// Names inside the event's extra data (Shopify varies what it includes)
function namesFromDetails(ev) {
  const out = { strings: [] };
  const walk = (x, key = "") => {
    if (x == null) return;
    if (typeof x === "string") {
      if (/product.*title|^product$|product_name/i.test(key)) out.product ??= x;
      else if (/variant.*title|^variant$|variant_name/i.test(key)) out.variant ??= x;
      else if (/sku/i.test(key)) out.sku ??= x;
      if (!x.startsWith("gid://") && !/^\d+$/.test(x)) out.strings.push(x);
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  for (const k of ["arguments", "additionalData"]) {
    let v = ev?.[k];
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        // plain text
      }
    }
    walk(v, k);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shopify's event log: who, and history from before the app was watching
// ---------------------------------------------------------------------------

const EVENTS = `#graphql
  query CatalogEvents($q: String!, $after: String) {
    events(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
      nodes {
        id
        createdAt
        action
        message
        ... on BasicEvent { subjectId subjectType author appTitle attributeToApp attributeToUser arguments additionalData secondaryMessage }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

// "Steve created a new product: <a href=…>Lore Vol. 1</a>." → { who, title }
export function readMessage(message) {
  const text = String(message ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  const colon = text.indexOf(": ");
  const title = colon >= 0 ? text.slice(colon + 2).replace(/\.$/, "").trim() || null : null;
  const who = text.match(/^(.+?) (created|deleted|added|removed|destroyed)\b/i)?.[1] ?? null;
  return { text, title, who };
}

const STREAMS = [
  ["PRODUCT", "create"],
  ["PRODUCT", "destroy"],
  ["PRODUCT_VARIANT", "create"],
  ["PRODUCT_VARIANT", "destroy"],
];

const running = new Map(); // shop -> promise
const timers = new Map(); // shop -> [timeouts]
const lastPageKick = new Map();

// After a notification: look for the event a little later (Shopify writes
// it a moment after the change), and once more in case it was slow
export function scheduleSync(shop) {
  if (process.env.NODE_ENV === "test") return;
  if (timers.has(shop)) return;
  const t1 = setTimeout(() => runSync(shop).catch(() => {}), 20_000);
  const t2 = setTimeout(() => {
    timers.delete(shop);
    runSync(shop).catch(() => {});
  }, 3 * 60_000);
  t1.unref?.();
  t2.unref?.();
  timers.set(shop, [t1, t2]);
}

// When the inventory page opens (at most every few minutes)
export function kickCatalog(shop) {
  const last = lastPageKick.get(shop) ?? 0;
  if (Date.now() - last < PAGE_THROTTLE_MS) return;
  lastPageKick.set(shop, Date.now());
  runSync(shop).catch(() => {});
}

export function runSync(shop, admin = null) {
  if (running.has(shop)) return running.get(shop);
  const p = (async () => {
    try {
      const client = admin ?? (await unauthenticated.admin(shop)).admin;
      const n = await syncEvents(shop, client);
      await db.catalogSync.upsert({ where: { shop }, create: { shop, lastRunAt: new Date() }, update: { lastRunAt: new Date(), lastError: null } });
      return n;
    } catch (e) {
      console.error(`[catalog] ${shop}: event log read failed:`, e?.message ?? e);
      await db.catalogSync
        .upsert({ where: { shop }, create: { shop, lastError: String(e?.message ?? e).slice(0, 500) }, update: { lastError: String(e?.message ?? e).slice(0, 500) } })
        .catch(() => {});
      throw e;
    } finally {
      running.delete(shop);
    }
  })();
  running.set(shop, p);
  return p;
}

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

export async function syncEvents(shop, admin) {
  const state = await db.catalogSync.upsert({ where: { shop }, create: { shop }, update: {} });
  let cursors = state.cursors ? JSON.parse(state.cursors) : {};
  // Bumped when reading gets better, so past rows are read again once
  const VERSION = 2;
  if (cursors.v !== VERSION) cursors = { v: VERSION };
  const backfillFrom = new Date(Date.now() - BACKFILL_DAYS * 24 * 3600 * 1000).toISOString();
  let stored = 0;

  for (const [type, action] of STREAMS) {
    const key = `${type}:${action}`;
    // Re-read a couple of minutes back in case events arrive out of order
    const from = cursors[key] ? new Date(new Date(cursors[key]).getTime() - 2 * 60 * 1000).toISOString() : backfillFrom;
    const q = `subject_type:${type} action:${action} created_at:>='${from}'`;
    let after = null;
    let newest = cursors[key] ?? null;
    for (let page = 0; page < 200; page++) {
      const data = await gql(admin, EVENTS, { q, after });
      const conn = data?.events;
      for (const ev of conn?.nodes ?? []) {
        if (!ev?.subjectId) continue;
        // Guard against the search matching loosely
        if (ev.subjectType && ev.subjectType !== type) continue;
        if (ev.action && ev.action !== action) continue;
        if (await storeEvent(shop, type, action, ev)) stored++;
        if (!newest || ev.createdAt > newest) newest = ev.createdAt;
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    if (newest) cursors[key] = newest;
    await db.catalogSync.update({ where: { shop }, data: { cursors: JSON.stringify(cursors) } });
  }
  await nameVariantsFromShopify(shop, admin);
  await fillNames(shop, admin);
  await resolveDeletedVariants(shop, admin);
  await collapseCascades(shop);
  await pairRecreations(shop);
  await fillWho(shop, admin);
  await seedProducts(shop, admin);
  return stored;
}

async function storeEvent(shop, type, action, ev) {
  const subject = type === "PRODUCT" ? "product" : "variant";
  const act = action === "create" ? "created" : "deleted";
  const subjectId = gid(type === "PRODUCT" ? PRODUCT : VARIANT, ev.subjectId);
  const msg = readMessage(ev.message);
  const extra = namesFromDetails(ev);
  // The author is the person whenever Shopify names one; an app gets its title
  const appName = ev.attributeToApp ? clean(ev.appTitle) : null;
  // A name read from the message only when Shopify says a person did it
  const staffName = clean(ev.author) ?? (ev.attributeToUser ? msg.who : null);
  const detailsJson = (() => {
    const d = { arguments: ev.arguments ?? null, additionalData: ev.additionalData ?? null, secondaryMessage: ev.secondaryMessage ?? null };
    const j = JSON.stringify(d);
    return j === '{"arguments":null,"additionalData":null,"secondaryMessage":null}' ? null : j.slice(0, 4000);
  })();
  const who = { staffName, appName: staffName && appName === staffName ? null : appName, message: msg.text.slice(0, 1000) || null, details: detailsJson, eventId: ev.id };

  let info;
  if (subject === "product") {
    info = { productId: subjectId, productTitle: extra.product ?? msg.title ?? (await productName(shop, subjectId)) };
  } else {
    const v = await variantInfo(shop, subjectId);
    info = {
      productId: v?.productId ?? null,
      productTitle: v?.productTitle ?? extra.product ?? null,
      variantTitle: v?.variantTitle ?? extra.variant ?? msg.title ?? null,
      sku: v?.sku ?? extra.sku ?? null,
      inventoryItemId: v?.inventoryItemId ?? null,
    };
  }

  const existing = await db.catalogEvent.findUnique({ where: { shop_subjectId_action: { shop, subjectId, action: act } } });
  if (existing) {
    if (existing.eventId && existing.productTitle && (existing.staffName || existing.appName)) return false;
    // Keep what the notification knew; fill in the rest
    const fill = Object.fromEntries(Object.entries(info).filter(([k, x]) => x != null && existing[k] == null));
    await db.catalogEvent.update({ where: { id: existing.id }, data: { ...who, ...fill, occurredAt: new Date(ev.createdAt) } });
    return true;
  }
  await db.catalogEvent.createMany({
    data: [{ shop, subject, subjectId, action: act, ...info, ...who, source: "events", occurredAt: new Date(ev.createdAt) }],
    skipDuplicates: true,
  });
  return true;
}

// Rows still without a product name: look again (more may be known now),
// then ask Shopify for products that still exist
export async function fillNames(shop, admin) {
  const rows = await db.catalogEvent.findMany({ where: { shop, productTitle: null }, take: 500 });
  const stillMissing = new Map(); // productId -> [rowIds]
  for (const r of rows) {
    const info = r.subject === "product" ? { productTitle: await productName(shop, r.subjectId) } : (await variantInfo(shop, r.subjectId)) ?? {};
    const fill = Object.fromEntries(
      ["productId", "productTitle", "variantTitle", "sku", "inventoryItemId"].filter((k) => info[k] != null && r[k] == null).map((k) => [k, info[k]]),
    );
    if (Object.keys(fill).length) await db.catalogEvent.update({ where: { id: r.id }, data: fill });
    const pid = fill.productId ?? r.productId;
    if (!fill.productTitle && pid) stillMissing.set(pid, [...(stillMissing.get(pid) ?? []), r.id]);
  }
  if (admin && stillMissing.size) {
    const ids = [...stillMissing.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const data = await gql(admin, PRODUCT_NAMES, { ids: ids.slice(i, i + 100) });
        for (const n of data?.nodes ?? []) {
          if (n?.id && n.title) await db.catalogEvent.updateMany({ where: { id: { in: stillMissing.get(n.id) ?? [] } }, data: { productTitle: n.title } });
        }
      } catch (e) {
        console.error("[catalog] product names:", e?.message ?? e);
      }
    }
  }
}

const VARIANT_NAMES = `#graphql
  query CatalogVariantNames($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant { id title sku inventoryItem { id } product { id title } } }
  }`;

// The product's own activity around a moment: who was editing it
const PRODUCT_ACTIVITY = `#graphql
  query CatalogProductActivity($id: ID!, $q: String!) {
    product(id: $id) {
      events(first: 20, query: $q, sortKey: CREATED_AT) {
        nodes { createdAt message ... on BasicEvent { author appTitle attributeToApp attributeToUser } }
      }
    }
  }`;

// Variants that still exist: ask Shopify which product they belong to
async function nameVariantsFromShopify(shop, admin) {
  const rows = await db.catalogEvent.findMany({ where: { shop, subject: "variant", OR: [{ productId: null }, { productTitle: null }] }, take: 500 });
  const ids = [...new Set(rows.map((r) => r.subjectId))];
  for (let i = 0; i < ids.length; i += 100) {
    let data;
    try {
      data = await gql(admin, VARIANT_NAMES, { ids: ids.slice(i, i + 100) });
    } catch (e) {
      console.error("[catalog] variant names:", e?.message ?? e);
      return;
    }
    for (const n of data?.nodes ?? []) {
      if (!n?.id || !n.product?.id) continue;
      const info = { productId: n.product.id, productTitle: n.product.title ?? null, variantTitle: n.title ?? null, sku: n.sku ?? null, inventoryItemId: n.inventoryItem?.id ?? null };
      for (const r of rows.filter((x) => x.subjectId === n.id)) {
        const fill = Object.fromEntries(Object.entries(info).filter(([k, x]) => x != null && r[k] == null));
        if (Object.keys(fill).length) await db.catalogEvent.update({ where: { id: r.id }, data: fill });
      }
      // Remember it, so a later deletion can be named too
      await db.catalogVariant.upsert({
        where: { shop_variantId: { shop, variantId: n.id } },
        create: { shop, variantId: n.id, ...info },
        update: { productTitle: info.productTitle, variantTitle: info.variantTitle, sku: info.sku, inventoryItemId: info.inventoryItemId },
      });
    }
  }
}

// Rows with no person or app: Shopify's variant entries often don't say.
// Borrow it from (1) the product's own activity within a few minutes, or
// (2) a stock change to the same item made right then.
export async function fillWho(shop, admin) {
  const rows = await db.catalogEvent.findMany({
    where: {
      shop,
      hidden: false,
      staffName: null,
      appName: null,
      occurredAt: { lt: new Date(Date.now() - 60_000) },
      // Once is enough, except recent rows (Shopify may still be writing its log)
      OR: [{ whoCheckedAt: null }, { occurredAt: { gte: new Date(Date.now() - 3600_000) }, whoCheckedAt: { lt: new Date(Date.now() - 4 * 60_000) } }],
    },
    orderBy: { occurredAt: "desc" },
    take: 200,
  });
  const WINDOW = 3 * 60 * 1000;
  for (const r of rows) {
    let who = null;
    if (admin && r.productId && !(r.subject === "product" && r.action === "deleted")) {
      const from = new Date(r.occurredAt.getTime() - WINDOW).toISOString();
      const to = new Date(r.occurredAt.getTime() + WINDOW).toISOString();
      try {
        const data = await gql(admin, PRODUCT_ACTIVITY, { id: r.productId, q: `created_at:>='${from}' created_at:<='${to}'` });
        const near = (data?.product?.events?.nodes ?? [])
          .map((e) => ({ e, gap: Math.abs(new Date(e.createdAt) - r.occurredAt) }))
          .filter(({ e, gap }) => gap <= WINDOW && (clean(e.author) || (e.attributeToApp && clean(e.appTitle)) || (e.attributeToUser && readMessage(e.message).who)))
          .sort((a, b) => a.gap - b.gap)[0]?.e;
        if (near) {
          const app = near.attributeToApp ? clean(near.appTitle) : null;
          const staff = clean(near.author) ?? (near.attributeToUser ? readMessage(near.message).who : null);
          who = { staffName: staff, appName: staff && app === staff ? null : app };
        }
      } catch (e) {
        console.error("[catalog] product activity:", e?.message ?? e);
      }
    }
    if (!who && r.inventoryItemId) {
      const a = await db.inventoryAdjustment.findFirst({
        where: {
          shop,
          inventoryItemId: r.inventoryItemId,
          OR: [{ staffName: { not: null } }, { appName: { not: null } }],
          occurredAt: { gte: new Date(r.occurredAt.getTime() - 10 * 60 * 1000), lte: new Date(r.occurredAt.getTime() + 10 * 60 * 1000) },
        },
        orderBy: { occurredAt: "asc" },
      });
      if (a) who = { staffName: a.staffName, appName: a.appName };
    }
    await db.catalogEvent.update({ where: { id: r.id }, data: { ...(who && (who.staffName || who.appName) ? who : {}), whoCheckedAt: new Date() } });
  }
}

const PRODUCT_NAMES = `#graphql
  query CatalogProductNames($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title } } }`;

// A product deleted and another created within moments: re-created (often
// by an app or sync gone wrong). Names must agree when both are known, or the
// two must share a SKU. One-to-one, closest in time first.
const RECREATE_MS = 2 * 60 * 1000;
const norm = (t) => (t ? String(t).trim().toLowerCase().replace(/\s+/g, " ") : null);

export async function pairRecreations(shop) {
  const deletions = await db.catalogEvent.findMany({ where: { shop, subject: "product", action: "deleted", pairId: null } });
  if (!deletions.length) return 0;
  const times = deletions.map((d) => d.occurredAt.getTime());
  const creations = await db.catalogEvent.findMany({
    where: {
      shop,
      subject: "product",
      action: "created",
      pairId: null,
      occurredAt: { gte: new Date(Math.min(...times) - RECREATE_MS), lte: new Date(Math.max(...times) + RECREATE_MS) },
    },
  });
  if (!creations.length) return 0;
  const skusOf = async (productId) =>
    new Set(
      (await db.catalogVariant.findMany({ where: { shop, productId, sku: { not: null } }, select: { sku: true } })).map((v) => norm(v.sku)),
    );
  const skuCache = new Map();
  const skus = async (pid) => {
    if (!pid) return new Set();
    if (!skuCache.has(pid)) skuCache.set(pid, await skusOf(pid));
    return skuCache.get(pid);
  };
  const candidates = [];
  for (const d of deletions) {
    for (const c of creations) {
      if (c.subjectId === d.subjectId) continue;
      const gap = Math.abs(c.occurredAt - d.occurredAt);
      if (gap > RECREATE_MS) continue;
      const a = norm(d.productTitle);
      const b = norm(c.productTitle);
      const ds = await skus(d.productId);
      const cs = await skus(c.productId);
      const skuMatch = [...ds].some((x) => cs.has(x));
      if (a && b && a !== b && !skuMatch) continue; // clearly different products
      candidates.push({ d, c, gap, strong: (a && a === b) || skuMatch });
    }
  }
  candidates.sort((x, y) => Number(y.strong) - Number(x.strong) || x.gap - y.gap);
  const used = new Set();
  let n = 0;
  for (const { d, c } of candidates) {
    if (used.has(d.id) || used.has(c.id)) continue;
    used.add(d.id);
    used.add(c.id);
    await db.catalogEvent.update({ where: { id: d.id }, data: { pairId: c.id, ...(!d.productTitle && c.productTitle ? { likelyTitle: c.productTitle } : {}) } });
    await db.catalogEvent.update({ where: { id: c.id }, data: { pairId: d.id } });
    n++;
  }
  return n;
}

// Hide variant rows that happened with their product's own creation/deletion
export async function collapseCascades(shop) {
  const variants = await db.catalogEvent.findMany({
    where: { shop, subject: "variant", hidden: false, productId: { not: null } },
    select: { id: true, productId: true, action: true, occurredAt: true },
  });
  const products = await db.catalogEvent.findMany({
    where: { shop, subject: "product", productId: { in: [...new Set(variants.map((v) => v.productId))] } },
    select: { productId: true, action: true, occurredAt: true },
  });
  const hide = variants
    .filter((v) =>
      products.some((p) => p.productId === v.productId && p.action === v.action && Math.abs(p.occurredAt - v.occurredAt) <= CASCADE_MS),
    )
    .map((v) => v.id);
  // A variant with no trace left that was created and deleted within minutes,
  // right as a product was being set up: Shopify's placeholder variant,
  // replaced when options were added. Part of creating the product.
  const orphans = await db.catalogEvent.findMany({ where: { shop, subject: "variant", hidden: false, productId: null } });
  const byVariant = new Map();
  for (const o of orphans) byVariant.set(o.subjectId, { ...byVariant.get(o.subjectId), [o.action]: o });
  for (const { created, deleted } of byVariant.values()) {
    if (!created || !deleted || deleted.occurredAt - created.occurredAt > 10 * 60 * 1000) continue;
    const setup = await db.catalogEvent.findFirst({
      where: {
        shop,
        subject: "product",
        action: "created",
        occurredAt: { gte: new Date(created.occurredAt.getTime() - CASCADE_MS), lte: new Date(created.occurredAt.getTime() + CASCADE_MS) },
      },
    });
    if (setup) hide.push(created.id, deleted.id);
  }
  if (hide.length) await db.catalogEvent.updateMany({ where: { id: { in: hide } }, data: { hidden: true } });
  return hide.length;
}


// ---------------------------------------------------------------------------
// Last-known copies: a one-time read of every current product (in chunks,
// continuing on later runs), so any later deletion can be described
// ---------------------------------------------------------------------------

const SEED = `#graphql
  query CatalogSeed($after: String) {
    products(first: 10, after: $after) {
      nodes {
        id title handle vendor productType tags status createdAt
        featuredMedia { preview { image { url } } }
        variantsCount { count }
        variants(first: 60) { nodes { id title sku barcode price position inventoryItem { id } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const SEED_PAGES_PER_RUN = 40;

export async function seedProducts(shop, admin, { pages = SEED_PAGES_PER_RUN } = {}) {
  const state = await db.catalogSync.upsert({ where: { shop }, create: { shop }, update: {} });
  if (state.seededAt) return 0;
  let after = state.seedCursor ?? null;
  let saved = 0;
  for (let page = 0; page < pages; page++) {
    const data = await gql(admin, SEED, { after });
    const conn = data?.products;
    for (const p of conn?.nodes ?? []) {
      // A notification may have saved a fresher copy already: only fill gaps
      const existing = await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId: p.id } } });
      if (!existing) {
        await db.catalogProduct.create({
          data: {
            shop,
            productId: p.id,
            title: clean(p.title),
            handle: clean(p.handle),
            vendor: clean(p.vendor),
            productType: clean(p.productType),
            tags: clean((p.tags ?? []).join(", ")),
            status: clean(p.status)?.toLowerCase() ?? null,
            imageUrl: clean(p.featuredMedia?.preview?.image?.url),
            variantCount: p.variantsCount?.count ?? p.variants?.nodes?.length ?? null,
            createdAt: p.createdAt ? new Date(p.createdAt) : null,
          },
        });
      }
      // Only a complete variant list: a partial one would make the product's
      // next edit look like variants were added
      const complete = (p.variantsCount?.count ?? 0) <= (p.variants?.nodes?.length ?? 0);
      const rows = (complete ? p.variants?.nodes ?? [] : []).map((v) => ({
        shop,
        variantId: v.id,
        productId: p.id,
        productTitle: clean(p.title),
        variantTitle: clean(v.title),
        sku: clean(v.sku),
        barcode: clean(v.barcode),
        price: clean(v.price),
        position: v.position ?? null,
        inventoryItemId: v.inventoryItem?.id ?? null,
        source: "shopify",
      }));
      if (rows.length) await db.catalogVariant.createMany({ data: rows, skipDuplicates: true });
      saved++;
    }
    after = conn?.pageInfo?.endCursor ?? after;
    const done = !conn?.pageInfo?.hasNextPage;
    await db.catalogSync.update({ where: { shop }, data: done ? { seedCursor: null, seededAt: new Date() } : { seedCursor: after } });
    if (done) break;
  }
  return saved;
}

// Variant names and SKUs from Shopify's stock report (read by the inventory
// sync). Fills gaps only; never overwrites what a notification told us.
export async function saveStockReportVariants(shop, rows) {
  let n = 0;
  const seen = [];
  for (const r of rows) {
    const variantId = gid(VARIANT, clean(r.product_variant_id));
    if (!variantId) continue;
    seen.push(variantId);
    const info = {
      inventoryItemId: gid(ITEM, clean(r.inventory_item_id)),
      sku: clean(r.product_variant_sku),
      variantTitle: clean(r.product_variant_title),
    };
    const existing = await db.catalogVariant.findUnique({ where: { shop_variantId: { shop, variantId } } });
    if (!existing) {
      await db.catalogVariant.create({ data: { shop, variantId, productId: null, ...info, source: "stock-report" } });
      n++;
    } else {
      const fill = Object.fromEntries(Object.entries(info).filter(([k, v]) => v != null && existing[k] == null));
      if (Object.keys(fill).length) {
        await db.catalogVariant.update({ where: { shop_variantId: { shop, variantId } }, data: fill });
        n++;
      }
    }
  }
  // Unnamed rows for these variants: look again now there's more to go on
  if (seen.length) {
    const { count } = await db.catalogEvent.updateMany({ where: { shop, subject: "variant", productTitle: null, subjectId: { in: seen } }, data: { nameCheckedAt: null } });
    if (count && process.env.NODE_ENV !== "test") runSync(shop).catch(() => {});
  }
  return n;
}

// Are there deleted-variant rows still missing their product? (The inventory
// sync reads the stock report's variant list only when this is true.)
export async function variantNamesWanted(shop) {
  return (await db.catalogEvent.count({ where: { shop, subject: "variant", productTitle: null } })) > 0;
}

// Is anything (product or variant) still without a name? (The inventory sync
// reads the sales report only when this is true.)
export async function namesFromSalesWanted(shop) {
  return (await db.catalogEvent.count({ where: { shop, productTitle: null } })) > 0;
}

// One page of the sales report: every product/variant ever sold, with its
// names as at the time of sale. Names deleted things that ever sold.
export async function applySalesNames(shop, rows) {
  const byProduct = new Map();
  const byVariant = new Map();
  for (const r of rows) {
    const productId = gid(PRODUCT, clean(r.product_id));
    const variantId = gid(VARIANT, clean(r.product_variant_id));
    const info = {
      productId,
      productTitle: clean(r.product_title_at_time_of_sale),
      variantTitle: clean(r.product_variant_title_at_time_of_sale),
      sku: clean(r.product_variant_sku_at_time_of_sale),
      vendor: clean(r.product_vendor_at_time_of_sale),
      productType: clean(r.product_type_at_time_of_sale),
    };
    if (!info.productTitle) continue;
    if (productId && !byProduct.has(productId)) byProduct.set(productId, info);
    if (variantId && !byVariant.has(variantId)) byVariant.set(variantId, info);
  }
  if (!byProduct.size && !byVariant.size) return 0;
  const SOURCE = "From your sales records (its name when it last sold)";
  const unnamed = await db.catalogEvent.findMany({
    where: {
      shop,
      productTitle: null,
      OR: [
        { subject: "product", subjectId: { in: [...byProduct.keys()] } },
        { subject: "variant", subjectId: { in: [...byVariant.keys()] } },
        { productId: { in: [...byProduct.keys()] } },
      ],
    },
  });
  let n = 0;
  for (const e of unnamed) {
    const info = e.subject === "variant" ? byVariant.get(e.subjectId) ?? byProduct.get(e.productId) : byProduct.get(e.subjectId) ?? byProduct.get(e.productId);
    if (!info) continue;
    const variantMatch = e.subject === "variant" && byVariant.has(e.subjectId);
    const data = { productTitle: info.productTitle, nameSource: SOURCE };
    if (!e.productId && info.productId) data.productId = info.productId;
    if (variantMatch && !e.variantTitle && info.variantTitle) data.variantTitle = info.variantTitle;
    if (variantMatch && !e.sku && info.sku) data.sku = info.sku;
    await db.catalogEvent.update({ where: { id: e.id }, data });
    n++;
    // Keep a copy for the detail view (vendor/type as they were)
    const pid = data.productId ?? e.productId;
    if (pid) {
      const existing = await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId: pid } } });
      if (!existing) {
        await db.catalogProduct.create({
          data: { shop, productId: pid, title: info.productTitle, vendor: info.vendor, productType: info.productType, ...(e.subject === "product" && e.action === "deleted" ? { deletedAt: e.occurredAt } : {}) },
        });
      }
    }
  }
  // Variants we only knew from the stock report: now we know their product too
  for (const [variantId, info] of byVariant) {
    if (!info.productId) continue;
    await db.catalogVariant.updateMany({
      where: { shop, variantId, productId: null },
      data: { productId: info.productId, productTitle: info.productTitle },
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// Working out which product a deleted variant belonged to
// ---------------------------------------------------------------------------

const PRODUCT_EVENTS_NEAR = `#graphql
  query CatalogProductEventsNear($q: String!) {
    events(first: 50, query: $q, sortKey: CREATED_AT) {
      nodes { createdAt action message ... on BasicEvent { subjectId subjectType author appTitle attributeToApp attributeToUser } }
    }
  }`;

const ORDERS_BY_SKU = `#graphql
  query CatalogOrdersBySku($q: String!) {
    orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name createdAt
        lineItems(first: 100) { nodes { sku title variantTitle vendor product { id title } } }
      }
    }
  }`;

const quoteQ = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
const fmtDay = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

export async function resolveDeletedVariants(shop, admin, { take = 100 } = {}) {
  const rows = await db.catalogEvent.findMany({
    where: {
      shop,
      subject: "variant",
      productTitle: null,
      OR: [{ nameCheckedAt: null }, { nameCheckedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } }],
    },
    orderBy: { occurredAt: "desc" },
    take,
  });
  const nearCache = new Map();
  for (const r of rows) {
    const found = { ...r };
    let source = null;

    // 1. Anything stored (incl. the stock report's name and SKU)
    const local = await variantInfo(shop, r.subjectId);
    for (const k of ["productId", "productTitle", "variantTitle", "sku", "inventoryItemId"]) if (found[k] == null && local?.[k] != null) found[k] = local[k];
    if (found.productTitle && !r.productTitle) source = "From what the app had stored about this variant";

    // 2. The event's own extra data, if Shopify put the product in it
    if (!found.productId && r.details) {
      const m = r.details.match(/gid:\/\/shopify\/Product\/\d+/);
      if (m) {
        found.productId = m[0];
        source = "From Shopify's activity log entry";
      }
    }

    // 3. The product the same person was working on at that moment
    if (!found.productId && admin) {
      const key = `${Math.floor(r.occurredAt.getTime() / 60000)}`;
      let near = nearCache.get(key);
      if (!near) {
        const from = new Date(r.occurredAt.getTime() - 2 * 60 * 1000).toISOString();
        const to = new Date(r.occurredAt.getTime() + 2 * 60 * 1000).toISOString();
        try {
          near = (await gql(admin, PRODUCT_EVENTS_NEAR, { q: `subject_type:PRODUCT created_at:>='${from}' created_at:<='${to}'` }))?.events?.nodes ?? [];
        } catch (e) {
          console.error("[catalog] activity near:", e?.message ?? e);
          near = [];
        }
        nearCache.set(key, near);
      }
      const person = r.staffName ?? null;
      const candidates = near
        .filter((e) => e.subjectId && (!e.subjectType || e.subjectType === "PRODUCT"))
        .filter((e) => !person || clean(e.author) === person || readMessage(e.message).who === person)
        .map((e) => ({ e, gap: Math.abs(new Date(e.createdAt) - r.occurredAt) }))
        .sort((a, b) => a.gap - b.gap);
      const products = [...new Set(candidates.map((c) => gid(PRODUCT, c.e.subjectId)))];
      if (products.length) {
        found.productId = products[0];
        if (!found.productTitle) found.productTitle = readMessage(candidates[0].e.message).title ?? null;
        source = `${person ?? "Someone"} was editing this product at that moment${products.length > 1 ? " (the closest of several)" : ""}`;
      }
    }

    // 4. Past orders with the same SKU
    if (!found.productTitle && found.sku && admin) {
      try {
        const data = await gql(admin, ORDERS_BY_SKU, { q: `sku:${quoteQ(found.sku)}` });
        for (const o of data?.orders?.nodes ?? []) {
          const li = (o.lineItems?.nodes ?? []).find((l) => clean(l.sku) === found.sku);
          if (li) {
            found.productTitle = clean(li.product?.title) ?? clean(li.title);
            found.productId ??= li.product?.id ?? null;
            found.variantTitle ??= clean(li.variantTitle);
            source = `From order ${o.name} (${fmtDay(o.createdAt)}), which had this SKU`;
            break;
          }
        }
      } catch (e) {
        console.error("[catalog] orders by SKU:", e?.message ?? e);
      }
    }

    // A product ID but no name yet: what we stored, or Shopify if it still exists
    if (found.productId && !found.productTitle) {
      found.productTitle = await productName(shop, found.productId);
      if (!found.productTitle && admin) {
        try {
          const n = (await gql(admin, PRODUCT_NAMES, { ids: [found.productId] }))?.nodes?.[0];
          found.productTitle = clean(n?.title);
        } catch {
          // stays unnamed
        }
      }
    }

    const data = { nameCheckedAt: new Date() };
    for (const k of ["productId", "productTitle", "variantTitle", "sku", "inventoryItemId"]) if (found[k] != null && r[k] == null) data[k] = found[k];
    if (data.productTitle && source) data.nameSource = source;
    await db.catalogEvent.update({ where: { id: r.id }, data });
  }
}

// ---------------------------------------------------------------------------
// The detail panel for one created/deleted row
// ---------------------------------------------------------------------------

export async function catalogDetail(shop, id) {
  const e = await db.catalogEvent.findFirst({ where: { shop, id: Number(id) } });
  if (!e) return null;
  const product = e.productId ? await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId: e.productId } } }) : null;
  const variants = e.productId
    ? await db.catalogVariant.findMany({ where: { shop, productId: e.productId }, orderBy: [{ position: "asc" }, { variantId: "asc" }], take: 250 })
    : [];
  const self = e.subject === "variant" ? await db.catalogVariant.findUnique({ where: { shop_variantId: { shop, variantId: e.subjectId } } }) : null;
  const iso = (d) => (d ? d.toISOString() : null);
  const variantView = (v) => ({
    id: v.variantId,
    title: v.variantTitle,
    sku: v.sku,
    barcode: v.barcode,
    price: v.price,
    inventoryItemId: v.inventoryItemId,
    deletedAt: iso(v.deletedAt),
    isThis: v.variantId === e.subjectId,
  });
  if (self && !variants.some((v) => v.variantId === self.variantId)) variants.push(self);
  return {
    id: e.id,
    subject: e.subject,
    action: e.action,
    at: iso(e.occurredAt),
    who: e.staffName && e.appName ? `${e.staffName} · ${e.appName}` : e.staffName ?? e.appName ?? null,
    shopifyMessage: e.message,
    nameSource: e.nameSource,
    productId: e.productId,
    productTitle: e.productTitle ?? product?.title ?? null,
    variantTitle: e.variantTitle && e.variantTitle !== "Default Title" ? e.variantTitle : null,
    sku: e.sku,
    product: product
      ? {
          title: product.title,
          handle: product.handle,
          vendor: product.vendor,
          productType: product.productType,
          tags: product.tags,
          status: product.status,
          imageUrl: product.imageUrl,
          variantCount: product.variantCount,
          createdAt: iso(product.createdAt),
          deletedAt: iso(product.deletedAt),
          copiedAt: iso(product.updatedAt),
        }
      : null,
    variants: variants.map(variantView),
    exists: e.productId ? !(product?.deletedAt || (e.subject === "product" && e.action === "deleted")) : null,
    lookup: e.productTitle || e.likelyTitle ? null : await lookupStatus(shop),
    likelyTitle: e.likelyTitle,
    pair: e.pairId ? await pairView(shop, e) : null,
  };
}

async function pairView(shop, e) {
  const o = await db.catalogEvent.findFirst({ where: { shop, id: e.pairId } });
  if (!o) return null;
  const still = o.action === "created" ? !(await db.catalogEvent.findFirst({ where: { shop, subjectId: o.subjectId, action: "deleted" } })) : false;
  return {
    id: o.id,
    action: o.action,
    productId: o.productId,
    title: o.productTitle ?? o.likelyTitle,
    at: o.occurredAt.toISOString(),
    seconds: Math.round((o.occurredAt - e.occurredAt) / 1000),
    who: o.staffName && o.appName ? `${o.staffName} · ${o.appName}` : o.staffName ?? o.appName ?? null,
    exists: still,
  };
}

// Where the search for a missing name stands, in words for the detail panel
async function lookupStatus(shop) {
  const s = await db.inventorySync.findUnique({ where: { shop } });
  if (!s) return { state: "waiting", text: "Waiting for the stock history to load before searching your sales records." };
  if (s.salesError) return { state: "error", text: `Shopify wouldn't return your sales records (${s.salesError}). The app tries again once a day.` };
  if (s.salesOffset > 0) return { state: "working", text: "Searching your sales records now. Check back in a few minutes." };
  if (!s.salesReadAt || !s.backfillDone) {
    return {
      state: "waiting",
      text: s.backfillDone
        ? "Queued to search your sales records. This runs in the background and usually finishes within a few minutes."
        : "Queued to search your sales records once the stock history finishes loading.",
    };
  }
  const when = s.salesReadAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
  return { state: "done", text: `Not in your sales records either (searched ${when}), so it most likely never sold. Shopify keeps no other record of its name.` };
}

// ---------------------------------------------------------------------------
// Reading, in the same shape as stock changes
// ---------------------------------------------------------------------------

const LABELS = {
  "product:created": "Product created",
  "product:deleted": "Product deleted",
  "variant:created": "Variant added",
  "variant:deleted": "Variant deleted",
};
const WHO_WAIT_MS = 10 * 60 * 1000;

export function catalogChange(e) {
  const variant = e.variantTitle && e.variantTitle !== "Default Title" ? e.variantTitle : null;
  // Nothing to name it by: say what kind of thing it was, and show Shopify's own words
  const unnamed = !e.productTitle;
  const item = e.productTitle
    ? `${e.productTitle}${variant ? ` · ${variant}` : ""}`
    : e.subject === "variant"
      ? variant
        ? `${variant} (product not recorded)`
        : e.sku
          ? `A variant, SKU ${e.sku} (product not recorded)`
          : "A variant (name not recorded)"
      : e.likelyTitle
        ? `Probably “${e.likelyTitle}”`
        : "A product (name not recorded)";
  const label = LABELS[`${e.subject}:${e.action}`];
  const lookingForWho = !e.eventId && !e.staffName && !e.appName && Date.now() - e.occurredAt.getTime() < WHO_WAIT_MS;
  return {
    key: `catalog-${e.id}`,
    catalogId: e.id,
    catalog: { subject: e.subject, action: e.action, label, recreated: Boolean(e.pairId) },
    pending: false,
    at: e.occurredAt.toISOString(),
    parts: [],
    available: null,
    staff: e.staffName,
    app: e.appName,
    who: lookingForWho ? "Checking who…" : e.staffName && e.appName ? `${e.staffName} · ${e.appName}` : e.staffName ?? e.appName ?? "Unknown",
    reason: null,
    reasonLabel: label,
    location: null,
    // Only offer the item's history for a variant that still exists
    inventoryItemId: e.inventoryItemId,
    productId: e.productId,
    item,
    note: unnamed ? e.message ?? null : null,
    variant,
    sku: e.sku,
    order: null,
    undoable: false,
  };
}

// The where clause for catalog rows matching a history filter
export function catalogWhere(shop, { productId, inventoryItemId, who, occurredAt } = {}) {
  return {
    shop,
    hidden: false,
    ...(productId ? { productId } : {}),
    ...(inventoryItemId ? { inventoryItemId } : {}),
    ...(who ? { appName: who.app ?? null, staffName: who.staff ?? null } : {}),
    ...(occurredAt ? { occurredAt } : {}),
  };
}
