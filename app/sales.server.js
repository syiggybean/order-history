// Sales: scheduled sales made in MonkeyBean, run by Shopify.
//
// Kinds
//   items        % or $ off items (everything, chosen collections or products)
//   order        % or $ off the order, optionally over a minimum subtotal
//   earlyAccess  members of chosen tiers can buy chosen products from the start
//                time; everyone else from the end time (before the start, nobody)
//
// Audience: everyone, or only loyalty members of chosen tiers ("secret sales").
// Members are recognised at checkout by their tier tag (e.g. "VIP Gold"), which
// Loyalty keeps on the customer. A member has to be signed in.
//
// How it reaches Shopify
//   items / order  a Shopify automatic discount (Shopify's own kind, so it works
//                  on any plan) with the sale's start and end times; Shopify
//                  starts and stops it. Members-only sales are limited to a
//                  customer segment per tier ("MonkeyBean: VIP Gold" = customers
//                  tagged VIP Gold), made the first time it's needed.
//   earlyAccess    a checkout rule (the "early-access" function, turned on once
//                  under Settings → Checkout → Checkout rules) that reads each
//                  product's oh_sales.early_access metafield. MonkeyBean sets
//                  that metafield as the sale moves from locked → members only →
//                  open (checked every minute) and removes it when it opens.
//   Front-page tab a shop metafield (oh_sales.tabs) read by the "Member sale tab"
//                  theme embed, which shows each live sale's tab only to the
//                  customers it's for.
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { errorMessage, gql } from "./preorders.server";
import { fromStoreInput, toStoreInput } from "./preorder-windows.server";
import { getProgram, tierTagOf } from "./loyalty.server";

export class SaleError extends Error {}

export const KINDS = { items: "% or $ off items", order: "Order discount", earlyAccess: "Early access" };
const EA_NS = "oh_sales";
const EA_KEY = "early_access";
const TABS_KEY = "tabs";
const STORE_TZ = "America/Los_Angeles";

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const clean = (s, max = 200) => {
  const t = String(s ?? "").trim();
  return t ? t.slice(0, max) : null;
};
const pretty = (d) => new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: STORE_TZ }) + " PT";

// Where a sale is in its schedule
export function statusOf(s, now = Date.now()) {
  if (!s.active) return "off";
  if (now < new Date(s.startsAt).getTime()) return "scheduled";
  if (now >= new Date(s.endsAt).getTime()) return "ended";
  return "live";
}

// Early access: before the start nobody can buy, then members, then everyone
export function earlyPhaseOf(s, now = Date.now()) {
  if (!s.active) return "open";
  if (now < new Date(s.startsAt).getTime()) return s.lockBefore === false ? "open" : "locked";
  if (now < new Date(s.endsAt).getTime()) return "members";
  return "open";
}

// The tags (= tier_tag metafield values) of the sale's tiers
function tagsFor(sale, program) {
  if (sale.audience !== "tiers") return [];
  const ids = json(sale.tiers, []);
  return program.tiers.filter((t) => ids.includes(t.id)).map((t) => tierTagOf(program, t));
}

const view = (s, program) => {
  const ids = json(s.tiers, []);
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    kindLabel: KINDS[s.kind] ?? s.kind,
    audience: s.audience,
    tiers: ids,
    tierNames: program.tiers.filter((t) => ids.includes(t.id)).map((t) => t.name),
    valueType: s.valueType,
    value: s.value,
    scope: s.scope,
    collections: json(s.collections, []),
    products: json(s.products, []),
    minSubtotal: s.minSubtotal,
    combine: s.combine,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    startsInput: toStoreInput(s.startsAt),
    endsInput: toStoreInput(s.endsAt),
    active: s.active,
    status: statusOf(s),
    lockBefore: s.lockBefore !== false,
    tabEnabled: s.tabEnabled,
    tabLabel: s.tabLabel,
    tabUrl: s.tabUrl,
    discountId: s.discountId,
    syncError: s.syncError,
    syncedAt: s.syncedAt?.toISOString() ?? null,
    createdBy: s.createdBy,
  };
};

export async function listSales(shop) {
  const [rows, program] = await Promise.all([db.sale.findMany({ where: { shop }, orderBy: { startsAt: "desc" } }), getProgram(shop)]);
  return {
    sales: rows.map((s) => view(s, program)),
    tiers: program.tiers.map((t) => ({ id: t.id, name: t.name, tag: tierTagOf(program, t) })),
  };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

const pickList = (v) =>
  (Array.isArray(v) ? v : json(v, []))
    .filter((x) => x && /^gid:\/\/shopify\/(Product|Collection)\/\d+$/.test(String(x.id)))
    .slice(0, 100)
    .map((x) => ({ id: String(x.id), title: clean(x.title, 200) ?? "" }));

export async function saveSale(shop, admin, input, user) {
  const name = clean(input.name, 120);
  if (!name) throw new SaleError("Give the sale a name (members see it at checkout).");
  if (!KINDS[input.kind]) throw new SaleError("Choose what kind of sale it is.");
  const startsAt = fromStoreInput(input.starts);
  const endsAt = fromStoreInput(input.ends);
  if (!startsAt || !endsAt) throw new SaleError(input.kind === "earlyAccess" ? "Set when members can buy, and when everyone can." : "Set when the sale starts and ends.");
  if (endsAt <= startsAt) throw new SaleError(input.kind === "earlyAccess" ? "Everyone has to be able to buy after members can." : "The sale has to end after it starts.");
  const audience = input.audience === "tiers" ? "tiers" : "everyone";
  const program = await getProgram(shop);
  const tiers = (Array.isArray(input.tiers) ? input.tiers : json(input.tiers, [])).filter((id) => program.tiers.some((t) => t.id === id));
  if (audience === "tiers" && !tiers.length) throw new SaleError("Choose which loyalty tiers get it.");
  if (input.kind === "earlyAccess" && audience !== "tiers") throw new SaleError("Early access is for chosen loyalty tiers.");
  const scope = ["all", "collections", "products"].includes(input.scope) ? input.scope : "all";
  const collections = pickList(input.collections).filter((x) => x.id.includes("/Collection/"));
  const products = pickList(input.products).filter((x) => x.id.includes("/Product/"));
  if (input.kind === "earlyAccess" && scope === "all") throw new SaleError("Choose the products (or collections) members get early.");
  if (input.kind !== "order" && scope === "collections" && !collections.length) throw new SaleError("Choose at least one collection.");
  if (input.kind !== "order" && scope === "products" && !products.length) throw new SaleError("Choose at least one product.");
  const data = {
    name,
    kind: input.kind,
    audience,
    tiers: JSON.stringify(audience === "tiers" ? tiers : []),
    scope: input.kind === "order" ? "all" : scope,
    collections: JSON.stringify(input.kind !== "order" && scope === "collections" ? collections : []),
    products: JSON.stringify(input.kind !== "order" && scope === "products" ? products : []),
    combine: input.combine === true || input.combine === "true",
    startsAt,
    endsAt,
    active: input.active !== false && input.active !== "false",
    tabEnabled: input.tabEnabled === true || input.tabEnabled === "true",
    tabLabel: clean(input.tabLabel, 40),
    tabUrl: clean(input.tabUrl, 300),
  };
  if (data.tabEnabled && !data.tabLabel) throw new SaleError("Give the front-page tab a label.");
  if (data.tabUrl && !/^(\/|https:\/\/)/.test(data.tabUrl)) throw new SaleError("The tab's link has to start with / (a page on the store) or https://.");
  if (input.kind === "earlyAccess") {
    Object.assign(data, { valueType: "percentage", value: 0, minSubtotal: null, combine: false, lockBefore: !(input.lockBefore === false || input.lockBefore === "false") });
  } else {
    const valueType = input.valueType === "fixed" ? "fixed" : "percentage";
    const value = Math.round(Number(input.value) * 100) / 100;
    if (!(value > 0)) throw new SaleError("Set how much off.");
    if (valueType === "percentage" && value > 100) throw new SaleError("A percentage can't be over 100.");
    const min = input.minSubtotal === "" || input.minSubtotal == null ? null : Math.round(Number(input.minSubtotal) * 100) / 100;
    if (min !== null && !(min > 0)) throw new SaleError("The minimum order has to be more than $0, or left empty.");
    Object.assign(data, { valueType, value, minSubtotal: input.kind === "order" ? min : null });
  }
  let sale;
  let was = null;
  if (input.id) {
    was = await db.sale.findFirst({ where: { shop, id: Number(input.id) } });
    if (!was) throw new SaleError("That sale isn't there anymore.");
    // A discount can't change kind in Shopify: start a fresh one
    if (was.kind !== data.kind && was.discountId) {
      await deleteDiscount(admin, was.discountId);
      data.discountId = null;
    }
    sale = await db.sale.update({ where: { id: was.id }, data });
  } else {
    sale = await db.sale.create({ data: { shop, ...data, createdBy: user?.name ?? null } });
  }
  await syncSale(shop, admin, sale, program);
  // Products taken out of an early-access sale (or a sale that's no longer
  // early access) go back to normal
  if (was?.kind === "earlyAccess") await syncEarlyAccess(shop, admin, { also: was });
  return view(await db.sale.findFirst({ where: { id: sale.id } }), program);
}

export async function deleteSale(shop, admin, id) {
  const s = await db.sale.findFirst({ where: { shop, id: Number(id) } });
  if (!s) throw new SaleError("That sale isn't there anymore.");
  if (s.discountId) await deleteDiscount(admin, s.discountId);
  await db.sale.delete({ where: { id: s.id } });
  if (s.kind === "earlyAccess") await syncEarlyAccess(shop, admin, { also: s });
  await syncTabs(shop, admin);
}

// ---------------------------------------------------------------------------
// Shopify: the automatic discount
// ---------------------------------------------------------------------------

const CREATE = `#graphql
  mutation SaleCreate($d: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicCreate(automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field message } }
  }`;
const UPDATE = `#graphql
  mutation SaleUpdate($id: ID!, $d: DiscountAutomaticBasicInput!) {
    discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) { automaticDiscountNode { id } userErrors { field message } }
  }`;
const DELETE = `#graphql
  mutation SaleDelete($id: ID!) {
    discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } }
  }`;
const SEGMENT_FIND = `#graphql
  query SaleSegment($q: String!) { segments(first: 5, query: $q) { nodes { id name query } } }`;
const SEGMENT_CREATE = `#graphql
  mutation SaleSegmentCreate($name: String!, $query: String!) {
    segmentCreate(name: $name, query: $query) { segment { id } userErrors { field message } }
  }`;
const MF_SET = `#graphql
  mutation SaleMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;
const MF_DELETE = `#graphql
  mutation SaleMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

const errs = (r) => {
  const e = r?.userErrors ?? [];
  if (e.length) throw new SaleError(`Shopify: ${e.map((x) => x.message).join("; ")}`);
};

async function deleteDiscount(admin, id) {
  try {
    const data = await gql(admin, DELETE, { id });
    const e = data?.discountAutomaticDelete?.userErrors ?? [];
    // Already gone (deleted in Shopify) is fine
    if (e.length && !e.some((x) => /not found|does not exist/i.test(x.message))) throw new SaleError(`Shopify: ${e.map((x) => x.message).join("; ")}`);
  } catch (e) {
    if (!/not found|does not exist/i.test(errorMessage(e))) throw e;
  }
}

// A customer segment per loyalty tier ("MonkeyBean: VIP Gold" = customers
// tagged VIP Gold; Loyalty keeps the tags up to date). Made once, then reused.
const segmentName = (tag) => `MonkeyBean: ${tag}`;
const segmentQuery = (tag) => `customer_tags CONTAINS '${tag.replace(/'/g, "\\'")}'`;
async function segmentFor(admin, tag) {
  const name = segmentName(tag);
  const found = await gql(admin, SEGMENT_FIND, { q: `name:'${name.replace(/'/g, "\\'")}'` });
  const hit = (found?.segments?.nodes ?? []).find((n) => n.name === name);
  if (hit) return hit.id;
  const r = await gql(admin, SEGMENT_CREATE, { name, query: segmentQuery(tag) });
  errs(r?.segmentCreate);
  const id = r?.segmentCreate?.segment?.id;
  if (!id) throw new SaleError(`Shopify didn't make the customer segment for ${tag}.`);
  return id;
}

// The sale as a Shopify automatic discount (Shopify's own kind, so it works
// on any plan)
export function discountInput(sale, segmentIds, { previousSegmentIds = [], update = false } = {}) {
  const fixed = sale.valueType === "fixed";
  const value = fixed
    ? { discountAmount: { amount: String(sale.value), appliesOnEachItem: sale.kind === "items" } }
    : { percentage: Math.min(sale.value, 100) / 100 };
  const items =
    sale.kind === "order" || sale.scope === "all"
      ? { all: true }
      : sale.scope === "collections"
        ? { collections: { add: json(sale.collections, []).map((c) => c.id) } }
        : { products: { productsToAdd: json(sale.products, []).map((p) => p.id) } };
  const remove = previousSegmentIds.filter((id) => !segmentIds.includes(id));
  return {
    title: sale.name,
    startsAt: sale.startsAt.toISOString(),
    endsAt: sale.endsAt.toISOString(),
    combinesWith: sale.combine ? { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true } : { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true },
    context: sale.audience === "tiers" ? { customerSegments: { add: segmentIds, ...(update && remove.length ? { remove } : {}) } } : { all: "ALL" },
    customerGets: { value, items },
    minimumRequirement: sale.kind === "order" && sale.minSubtotal ? { subtotal: { greaterThanOrEqualToSubtotal: String(sale.minSubtotal) } } : null,
  };
}

export async function syncSale(shop, admin, sale, program = null) {
  program ??= await getProgram(shop);
  const tags = tagsFor(sale, program);
  try {
    if (sale.kind === "earlyAccess") {
      await syncEarlyAccess(shop, admin, { force: true });
    } else if (!sale.active || statusOf(sale) === "ended") {
      // Off or over: nothing in Shopify
      if (sale.discountId) await deleteDiscount(admin, sale.discountId);
      await db.sale.update({ where: { id: sale.id }, data: { discountId: null } });
    } else {
      const segmentIds = [];
      for (const tag of tags) segmentIds.push(await segmentFor(admin, tag));
      const before = [];
      for (const tag of json(sale.syncedTags, [])) if (!tags.includes(tag)) before.push(await segmentFor(admin, tag));
      let discountId = sale.discountId;
      if (discountId) {
        const r = await gql(admin, UPDATE, { id: discountId, d: discountInput(sale, segmentIds, { previousSegmentIds: before, update: true }) });
        const e = r?.discountAutomaticBasicUpdate?.userErrors ?? [];
        // Deleted in Shopify meanwhile (or made the old way): make it again
        if (e.some((x) => /not found|does not exist|invalid id/i.test(x.message))) {
          await deleteDiscount(admin, discountId);
          discountId = null;
        } else errs(r?.discountAutomaticBasicUpdate);
      }
      if (!discountId) {
        const r = await gql(admin, CREATE, { d: discountInput(sale, segmentIds) });
        errs(r?.discountAutomaticBasicCreate);
        discountId = r?.discountAutomaticBasicCreate?.automaticDiscountNode?.id;
        if (!discountId) throw new SaleError("Shopify didn't make the discount.");
      }
      await db.sale.update({ where: { id: sale.id }, data: { discountId } });
    }
    await db.sale.update({ where: { id: sale.id }, data: { syncedTags: JSON.stringify(tags), syncError: null, syncedAt: new Date() } });
  } catch (e) {
    await db.sale.update({ where: { id: sale.id }, data: { syncError: errorMessage(e).slice(0, 500), syncedAt: new Date() } });
    throw e instanceof SaleError ? e : new SaleError(errorMessage(e));
  }
  await syncTabs(shop, admin).catch((e) => console.error(`[sales] ${shop}: tabs:`, errorMessage(e)));
}

// ---------------------------------------------------------------------------
// Early access: product metafields the checkout rule reads
// ---------------------------------------------------------------------------

const COLLECTION_PRODUCTS = `#graphql
  query SaleCollectionProducts($id: ID!, $after: String) {
    collection(id: $id) { products(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { id } } }
  }`;

async function productsOf(admin, sale) {
  if (sale.scope === "products") return json(sale.products, []).map((p) => p.id);
  const ids = new Set();
  for (const c of json(sale.collections, [])) {
    let after = null;
    for (let page = 0; page < 8; page++) {
      const d = await gql(admin, COLLECTION_PRODUCTS, { id: c.id, after });
      for (const n of d?.collection?.products?.nodes ?? []) ids.add(n.id);
      if (!d?.collection?.products?.pageInfo?.hasNextPage) break;
      after = d.collection.products.pageInfo.endCursor;
    }
  }
  return [...ids];
}

// What each product's metafield should say across every early-access sale.
// Members-only beats locked (members can already buy); open = no metafield.
export async function syncEarlyAccess(shop, admin, { force = false, also = null, now = Date.now() } = {}) {
  const sales = await db.sale.findMany({ where: { shop, kind: "earlyAccess" } });
  const changed = sales.filter((s) => earlyPhaseOf(s, now) !== (s.phase ?? null));
  if (!force && !changed.length && !also) return { written: 0 };
  const program = await getProgram(shop);
  const want = new Map(); // productId -> value | null
  for (const s of [...sales, ...(also ? [{ ...also, active: false }] : [])]) {
    const phase = earlyPhaseOf(s, now);
    for (const pid of await productsOf(admin, s)) {
      const had = want.get(pid) ?? null;
      if (phase === "open") {
        if (!want.has(pid)) want.set(pid, null);
        continue;
      }
      const tags = tagsFor(s, program);
      const names = program.tiers.filter((t) => json(s.tiers, []).includes(t.id)).map((t) => t.name);
      const next =
        phase === "members"
          ? { phase: "members", tags, tiers: names.join(", "), opens: pretty(s.endsAt) }
          : { phase: "locked", tags: [], tiers: names.join(", "), opens: pretty(s.startsAt) };
      if (!had || had.phase === "locked") {
        if (had?.phase === "members" || (had && next.phase === "locked")) continue;
        want.set(pid, next);
      } else if (had.phase === "members" && next.phase === "members") {
        had.tags = [...new Set([...had.tags, ...next.tags])];
        had.tiers = [had.tiers, next.tiers].filter(Boolean).join(", ");
      }
    }
  }
  const set = [...want].filter(([, v]) => v).map(([ownerId, v]) => ({ ownerId, namespace: EA_NS, key: EA_KEY, type: "json", value: JSON.stringify(v) }));
  const del = [...want].filter(([, v]) => !v).map(([ownerId]) => ({ ownerId, namespace: EA_NS, key: EA_KEY }));
  for (let i = 0; i < set.length; i += 25) errs((await gql(admin, MF_SET, { metafields: set.slice(i, i + 25) }))?.metafieldsSet);
  for (let i = 0; i < del.length; i += 25) {
    const r = (await gql(admin, MF_DELETE, { metafields: del.slice(i, i + 25) }))?.metafieldsDelete;
    const e = (r?.userErrors ?? []).filter((x) => !/not found|does not exist/i.test(x.message));
    if (e.length) throw new SaleError(`Shopify: ${e.map((x) => x.message).join("; ")}`);
  }
  for (const s of sales) {
    const phase = earlyPhaseOf(s, now);
    if (phase !== s.phase) await db.sale.update({ where: { id: s.id }, data: { phase, syncError: null, syncedAt: new Date() } });
  }
  return { written: set.length + del.length };
}

// ---------------------------------------------------------------------------
// The front-page tab: live sales' tabs, for the theme embed
// ---------------------------------------------------------------------------

const SHOP_ID = `#graphql
  query SaleShopId { shop { id } }`;

export async function syncTabs(shop, admin) {
  const program = await getProgram(shop);
  const rows = await db.sale.findMany({ where: { shop, active: true, tabEnabled: true, endsAt: { gt: new Date() } }, orderBy: { startsAt: "asc" } });
  const tabs = rows.map((s) => ({
    label: s.tabLabel ?? s.name,
    url: s.tabUrl ?? "/",
    // Unix seconds: Liquid compares them with 'now'
    starts: Math.floor(s.startsAt.getTime() / 1000),
    ends: Math.floor(s.endsAt.getTime() / 1000),
    // Empty: everyone
    tags: tagsFor(s, program),
  }));
  const ownerId = (await gql(admin, SHOP_ID, {}))?.shop?.id;
  if (!ownerId) return;
  if (tabs.length) errs((await gql(admin, MF_SET, { metafields: [{ ownerId, namespace: EA_NS, key: TABS_KEY, type: "json", value: JSON.stringify(tabs) }] }))?.metafieldsSet);
  else await gql(admin, MF_DELETE, { metafields: [{ ownerId, namespace: EA_NS, key: TABS_KEY }] }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

const FIND = `#graphql
  query SaleFind($q: String!) {
    products(first: 8, query: $q) { nodes { id title } }
    collections(first: 8, query: $q) { nodes { id title } }
  }`;

export async function findTargets(admin, q) {
  const t = String(q ?? "").trim().slice(0, 80).replace(/["\\]/g, " ");
  if (t.length < 2) return { products: [], collections: [] };
  const d = await gql(admin, FIND, { q: `title:*${t}*` });
  return { products: d?.products?.nodes ?? [], collections: d?.collections?.nodes ?? [] };
}

// ---------------------------------------------------------------------------
// Every minute: early access moves from locked → members → open, and sales
// whose tiers changed (renamed in Loyalty) are re-sent
// ---------------------------------------------------------------------------

export async function tick(shop, admin) {
  const program = await getProgram(shop);
  const early = await db.sale.findMany({ where: { shop, kind: "earlyAccess", active: true, endsAt: { gt: new Date() } } });
  const renamed = early.filter((s) => JSON.stringify(tagsFor(s, program)) !== (s.syncedTags ?? "[]"));
  await syncEarlyAccess(shop, admin, { force: renamed.length > 0 });
  for (const s of renamed) await db.sale.update({ where: { id: s.id }, data: { syncedTags: JSON.stringify(tagsFor(s, program)) } });
  const sales = await db.sale.findMany({ where: { shop, kind: { in: ["items", "order"] }, active: true, endsAt: { gt: new Date() } } });
  for (const s of sales) {
    if (JSON.stringify(tagsFor(s, program)) !== (s.syncedTags ?? "[]") || !s.discountId) await syncSale(shop, admin, s, program).catch((e) => console.error(`[sales] ${shop} ${s.name}:`, errorMessage(e)));
  }
  // Ended sales' tabs drop off
  const lastTab = await db.sale.findFirst({ where: { shop, tabEnabled: true, endsAt: { lte: new Date(), gt: new Date(Date.now() - 2 * 60_000) } } });
  if (lastTab) await syncTabs(shop, admin).catch(() => {});
}

if (!globalThis.__salesTimer && process.env.NODE_ENV !== "test") {
  const run = async () => {
    const shops = await db.sale.findMany({ distinct: ["shop"], select: { shop: true } });
    for (const { shop } of shops) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        await tick(shop, admin);
      } catch (e) {
        console.error(`[sales] ${shop}:`, errorMessage(e));
      }
    }
  };
  globalThis.__salesTimer = setInterval(() => run().catch(() => {}), 60 * 1000);
}
