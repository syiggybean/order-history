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
const OFFERS_KEY = "offers";
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

// Amount off per audience column: [{ col: "everyone" | tier id, value }].
// Older sales had one amount for everyone or for their tiers.
export function ratesOf(sale) {
  if (sale.kind === "earlyAccess") return [];
  const r = json(sale.rates, null);
  if (Array.isArray(r) && r.length) return r;
  if (sale.audience === "tiers") return json(sale.tiers, []).map((col) => ({ col, value: sale.value }));
  return [{ col: "everyone", value: sale.value }];
}

// The tier tags the sale is for (members recognised by these). Empty when it's
// only for everyone.
function tagsFor(sale, program) {
  const ids = sale.kind === "earlyAccess" ? (sale.audience === "tiers" ? json(sale.tiers, []) : []) : ratesOf(sale).map((r) => r.col);
  return program.tiers.filter((t) => ids.includes(t.id)).map((t) => tierTagOf(program, t));
}
const forEveryone = (sale) => sale.kind !== "earlyAccess" && ratesOf(sale).some((r) => r.col === "everyone");

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
    rates: ratesOf(s),
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
    discountCount: Object.keys(json(s.discounts, {})).length || (s.discountId ? 1 : 0),
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

const money2 = (v) => Math.round(Number(v) * 100) / 100;
const pickList = (v) =>
  (Array.isArray(v) ? v : json(v, []))
    .filter((x) => x && /^gid:\/\/shopify\/(Product|Collection)\/\d+$/.test(String(x.id)))
    .slice(0, 250)
    .map((x) => ({
      id: String(x.id),
      title: clean(x.title, 200) ?? "",
      image: /^https:\/\//.test(String(x.image ?? "")) ? String(x.image).slice(0, 500) : null,
      price: Number.isFinite(Number(x.price)) && x.price !== null && x.price !== "" ? money2(x.price) : null,
      // Per audience column; missing = the column's amount
      values: Object.fromEntries(
        Object.entries(x.values && typeof x.values === "object" ? x.values : {})
          .filter(([, v]) => v !== "" && v != null && Number.isFinite(Number(v)))
          .map(([k, v]) => [String(k).slice(0, 40), money2(v)]),
      ),
    }));

export async function saveSale(shop, admin, input, user) {
  const name = clean(input.name, 120);
  if (!name) throw new SaleError("Give the sale a name (members see it at checkout).");
  if (!KINDS[input.kind]) throw new SaleError("Choose what kind of sale it is.");
  const sameName = await db.sale.findFirst({ where: { shop, name, endsAt: { gt: new Date() }, active: true, ...(input.id ? { id: { not: Number(input.id) } } : {}) } });
  if (sameName) throw new SaleError(`Another sale that hasn't finished is already called “${name}”. Shopify needs each sale's name to be different; pick another, or wait for that one to finish.`);
  const startsAt = fromStoreInput(input.starts);
  const endsAt = fromStoreInput(input.ends);
  if (!startsAt || !endsAt) throw new SaleError(input.kind === "earlyAccess" ? "Set when members can buy, and when everyone can." : "Set when the sale starts and ends.");
  if (endsAt <= startsAt) throw new SaleError(input.kind === "earlyAccess" ? "Everyone has to be able to buy after members can." : "The sale has to end after it starts.");
  const program = await getProgram(shop);
  const tierIds = new Set(program.tiers.map((t) => t.id));
  let audience;
  let tiers;
  let rates = [];
  if (input.kind === "earlyAccess") {
    audience = "tiers";
    tiers = (Array.isArray(input.tiers) ? input.tiers : json(input.tiers, [])).filter((id) => tierIds.has(id));
    if (!tiers.length) throw new SaleError("Choose which loyalty tiers get early access.");
  } else {
    // Who gets what: everyone and/or chosen tiers, each with its own amount
    const seen = new Set();
    rates = (Array.isArray(input.rates) ? input.rates : json(input.rates, []))
      .filter((r) => r && (r.col === "everyone" || tierIds.has(r.col)) && !seen.has(r.col) && seen.add(r.col))
      .map((r) => ({ col: r.col, value: r.value === "" || r.value == null ? 0 : money2(r.value) }));
    if (!rates.length) throw new SaleError("Choose who gets it: everyone, or which loyalty tiers.");
    audience = rates.some((r) => r.col === "everyone") ? "everyone" : "tiers";
    tiers = rates.filter((r) => r.col !== "everyone").map((r) => r.col);
  }
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
    tiers: JSON.stringify(tiers),
    rates: JSON.stringify(rates),
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
    const check = (v, what) => {
      if (v < 0) throw new SaleError(`${what} can't be below 0.`);
      if (valueType === "percentage" && v > 100) throw new SaleError(`${what}: a percentage can't be over 100.`);
    };
    const colName = (col) => (col === "everyone" ? "Everyone" : program.tiers.find((t) => t.id === col)?.name ?? "A tier");
    for (const r of rates) check(r.value, colName(r.col));
    if (data.scope === "products") {
      for (const p of products) for (const [col, v] of Object.entries(p.values)) if (rates.some((r) => r.col === col)) check(v, `${p.title} (${colName(col)})`);
      if (!products.some((p) => rates.some((r) => (p.values[r.col] ?? r.value) > 0))) throw new SaleError("Set how much off: no product has an amount above 0.");
    } else if (!rates.some((r) => r.value > 0)) throw new SaleError("Set how much off.");
    const min = input.minSubtotal === "" || input.minSubtotal == null ? null : money2(input.minSubtotal);
    if (min !== null && !(min > 0)) throw new SaleError("The minimum order has to be more than $0, or left empty.");
    Object.assign(data, { valueType, value: Math.max(0, ...rates.map((r) => r.value)), minSubtotal: input.kind === "order" ? min : null });
  }
  let sale;
  let was = null;
  if (input.id) {
    was = await db.sale.findFirst({ where: { shop, id: Number(input.id) } });
    if (!was) throw new SaleError("That sale isn't there anymore.");
    // A discount can't change kind in Shopify: start fresh ones
    if (was.kind !== data.kind) {
      for (const id of discountIdsOf(was)) await deleteDiscount(admin, id);
      Object.assign(data, { discountId: null, discounts: null });
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
  for (const did of discountIdsOf(s)) await deleteDiscount(admin, did);
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

// The Shopify discounts a sale is made of: one per audience column and amount
// (Shopify's own automatic discounts have one amount and one audience each).
// A sale with Silver 15% and Gold 25%, or with products at different amounts,
// is several discounts that start and end together.
export function groupsOf(sale, program) {
  const groups = [];
  const products = json(sale.products, []);
  const shape = sale.kind === "order" || sale.scope === "all" ? "all" : sale.scope;
  for (const r of ratesOf(sale)) {
    const tier = r.col === "everyone" ? null : program.tiers.find((t) => t.id === r.col);
    if (r.col !== "everyone" && !tier) continue; // tier removed in Loyalty
    const base = { col: r.col, tag: tier ? tierTagOf(program, tier) : null, tierName: tier?.name ?? null, shape };
    if (shape === "products") {
      const byValue = new Map();
      for (const p of products) {
        const v = p.values?.[r.col] ?? r.value;
        if (!(v > 0)) continue;
        if (!byValue.has(v)) byValue.set(v, []);
        byValue.get(v).push(p.id);
      }
      for (const [value, items] of byValue) groups.push({ ...base, key: `${r.col}:${value}:products`, value, items });
    } else if (r.value > 0) {
      groups.push({ ...base, key: `${r.col}:${r.value}:${shape}`, value: r.value, items: shape === "collections" ? json(sale.collections, []).map((c) => c.id) : [] });
    }
  }
  for (const g of groups) g.several = groups.filter((x) => x.col === g.col).length > 1;
  return groups;
}

// Shopify wants every automatic discount's title to be different: tier and,
// when an audience has more than one amount, the amount go in the title
export function titleOf(sale, g) {
  const parts = [g.tierName ? `${g.tierName} members` : null, g.several ? `${sale.valueType === "fixed" ? `$${g.value}` : `${g.value}%`} off` : null].filter(Boolean);
  return parts.length ? `${sale.name} (${parts.join(", ")})` : sale.name;
}

export const discountIdsOf = (sale) => [...new Set([...Object.values(json(sale.discounts, {})).map((d) => d.id), ...(sale.discountId ? [sale.discountId] : [])])];

export function discountInput(sale, g, segmentIds, { was = null, removeSegments = [], several = false } = {}) {
  const value =
    sale.valueType === "fixed"
      ? { discountAmount: { amount: String(g.value), appliesOnEachItem: sale.kind === "items" && g.shape !== "all" } }
      : { percentage: Math.min(g.value, 100) / 100 };
  const removeItems = (was?.items ?? []).filter((id) => !g.items.includes(id));
  const addItems = was ? g.items.filter((id) => !(was.items ?? []).includes(id)) : g.items;
  const items =
    g.shape === "all"
      ? { all: true }
      : g.shape === "collections"
        ? { collections: { add: addItems, ...(removeItems.length ? { remove: removeItems } : {}) } }
        : { products: { productsToAdd: addItems, ...(removeItems.length ? { productsToRemove: removeItems } : {}) } };
  return {
    title: g.title ?? titleOf(sale, g),
    startsAt: sale.startsAt.toISOString(),
    endsAt: sale.endsAt.toISOString(),
    // The sale's own discounts always work together (one per item at most:
    // Shopify gives each item the best); "can be used with other discounts"
    // opens it to the rest
    combinesWith: sale.combine
      ? { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true }
      : { productDiscounts: sale.kind === "items" && several, orderDiscounts: false, shippingDiscounts: true },
    context: g.tag ? { customerSegments: { add: segmentIds, ...(removeSegments.length ? { remove: removeSegments } : {}) } } : { all: "ALL" },
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
      for (const id of discountIdsOf(sale)) await deleteDiscount(admin, id);
      await db.sale.update({ where: { id: sale.id }, data: { discountId: null, discounts: null } });
    } else {
      const groups = groupsOf(sale, program);
      if (!groups.length) throw new SaleError("Nothing in this sale has an amount off.");
      const had = json(sale.discounts, {});
      // A discount from before sales had several: reuse it for the first group
      if (sale.discountId && !Object.values(had).some((d) => d.id === sale.discountId) && !had[groups[0].key])
        had[groups[0].key] = { id: sale.discountId, tag: json(sale.syncedTags, [])[0] ?? null, items: null };
      const now = {};
      const segCache = new Map();
      let cleared = false;
      const seg = async (tag) => {
        if (!segCache.has(tag)) segCache.set(tag, await segmentFor(admin, tag));
        return segCache.get(tag);
      };
      // An amount that changed keeps its discount: reuse one of the same
      // audience that's no longer needed
      const newKeys = new Set(groups.map((g) => g.key));
      const spare = Object.entries(had).filter(([k]) => !newKeys.has(k));
      const prevFor = (g) => {
        if (had[g.key]) return had[g.key];
        const i = spare.findIndex(([k]) => k.startsWith(`${g.col}:`) && k.endsWith(`:${g.shape}`));
        if (i < 0) return null;
        const [[k, d]] = spare.splice(i, 1);
        delete had[k];
        return d;
      };
      for (const g of groups) {
        const segmentIds = g.tag ? [await seg(g.tag)] : [];
        const prev = prevFor(g);
        if (prev?.title && prev.title.replace(/ #\d+$/, "") === titleOf(sale, g)) g.title = prev.title;
        let id = prev?.id ?? null;
        if (id) {
          // Tier renamed in Loyalty: swap the segment; items: add and take away
          const removeSegments = prev.tag && prev.tag !== g.tag ? [await seg(prev.tag)] : [];
          const r = await gql(admin, UPDATE, { id, d: discountInput(sale, g, segmentIds, { was: prev.items ? prev : null, removeSegments, several: groups.length > 1 }) });
          const e = r?.discountAutomaticBasicUpdate?.userErrors ?? [];
          if (e.length) {
            // Deleted in Shopify, made the old way, or can't be changed that way: make it again
            await deleteDiscount(admin, id);
            id = null;
          }
        }
        if (!id) {
          // Finished sales' discounts still sit in Shopify (expired) until
          // they're cleared, and hold their titles: clear them first
          if (!cleared) {
            cleared = true;
            await clearFinished(shop, admin);
          }
          // Still taken (a discount made in Shopify itself): number it
          const base = titleOf(sale, g);
          for (let n = 1; n <= 9 && !id; n++) {
            g.title = n === 1 ? base : `${base} #${n}`;
            const r = await gql(admin, CREATE, { d: discountInput(sale, g, segmentIds, { several: groups.length > 1 }) });
            const e = r?.discountAutomaticBasicCreate?.userErrors ?? [];
            if (e.length && e.every((x) => /title/i.test(x.message) && /unique/i.test(x.message)) && n < 9) continue;
            errs(r?.discountAutomaticBasicCreate);
            id = r?.discountAutomaticBasicCreate?.automaticDiscountNode?.id;
          }
          if (!id) throw new SaleError("Shopify didn't make the discount.");
        }
        now[g.key] = { id, tag: g.tag, items: g.items, title: g.title ?? titleOf(sale, g) };
        // Saved as it goes, so a failure part way doesn't leave strays
        await db.sale.update({ where: { id: sale.id }, data: { discounts: JSON.stringify({ ...had, ...now }), discountId: null } });
      }
      // Amounts or audiences no longer in the sale
      for (const [key, d] of Object.entries(had)) if (!now[key] && !Object.values(now).some((x) => x.id === d.id)) await deleteDiscount(admin, d.id);
      await db.sale.update({ where: { id: sale.id }, data: { discounts: JSON.stringify(now), discountId: Object.values(now)[0]?.id ?? null } });
    }
    await db.sale.update({ where: { id: sale.id }, data: { syncedTags: JSON.stringify(tags), syncError: null, syncedAt: new Date() } });
  } catch (e) {
    await db.sale.update({ where: { id: sale.id }, data: { syncError: errorMessage(e).slice(0, 500), syncedAt: new Date() } });
    throw e instanceof SaleError ? e : new SaleError(errorMessage(e));
  } finally {
    // Product-page prices and front-page tabs
    await syncTabs(shop, admin).catch((e) => console.error(`[sales] ${shop}: tabs:`, errorMessage(e)));
  }
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
    tags: forEveryone(s) ? [] : tagsFor(s, program),
  }));
  const offers = await offersFor(shop, program);
  const ownerId = (await gql(admin, SHOP_ID, {}))?.shop?.id;
  if (!ownerId) return;
  const set = [];
  const del = [];
  (tabs.length ? set : del).push({ key: TABS_KEY, value: tabs });
  (offers.length ? set : del).push({ key: OFFERS_KEY, value: offers });
  if (set.length) errs((await gql(admin, MF_SET, { metafields: set.map((m) => ({ ownerId, namespace: EA_NS, key: m.key, type: "json", value: JSON.stringify(m.value) })) }))?.metafieldsSet);
  if (del.length) await gql(admin, MF_DELETE, { metafields: del.map((m) => ({ ownerId, namespace: EA_NS, key: m.key })) }).catch(() => {});
}

// Item sales for the product page's "Sale price" block (shop metafield
// oh_sales.offers): the theme shows each shopper the best price they get, with
// the original crossed out and a countdown to the end.
//   { n: name, s/e: start/end (unix seconds), t: "p" % | "f" $ off each,
//     scope: "all" | "c" (collections: c = numeric ids) | "p" (products),
//     r: [["*" (everyone) | tier tag, amount], …], p: { productId: [same] } }
export async function offersFor(shop, program) {
  const rows = await db.sale.findMany({ where: { shop, kind: "items", active: true, endsAt: { gt: new Date() } }, orderBy: { startsAt: "asc" } });
  const num = (gid) => Number(String(gid).split("/").pop());
  const out = [];
  for (const s of rows) {
    const keyOf = new Map();
    for (const r of ratesOf(s)) {
      if (r.col === "everyone") keyOf.set(r.col, "*");
      else {
        const tier = program.tiers.find((t) => t.id === r.col);
        if (tier) keyOf.set(r.col, tierTagOf(program, tier));
      }
    }
    const ratesMap = (values) => {
      const m = [];
      for (const r of ratesOf(s)) {
        const v = values ? (values[r.col] ?? r.value) : r.value;
        if (keyOf.has(r.col) && v > 0) m.push([keyOf.get(r.col), v]);
      }
      return m;
    };
    const o = { n: s.name, s: Math.floor(s.startsAt.getTime() / 1000), e: Math.floor(s.endsAt.getTime() / 1000), t: s.valueType === "fixed" ? "f" : "p" };
    if (s.scope === "products") {
      o.scope = "p";
      o.p = {};
      for (const p of json(s.products, [])) {
        const m = ratesMap(p.values ?? {});
        if (m.length) o.p[String(num(p.id))] = m;
      }
      if (!Object.keys(o.p).length) continue;
    } else {
      o.r = ratesMap(null);
      if (!o.r.length) continue;
      if (s.scope === "collections") {
        o.scope = "c";
        o.c = json(s.collections, []).map((c) => num(c.id));
      } else o.scope = "all";
    }
    out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

const FIND_PRODUCTS = `#graphql
  query SaleFindProducts($q: String!) {
    products(first: 10, query: $q) {
      nodes { id title status featuredImage { url(transform: { maxWidth: 160 }) } priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } } }
    }
  }`;
const FIND_COLLECTIONS = `#graphql
  query SaleFindCollections($q: String!) {
    collections(first: 8, query: $q) { nodes { id title image { url(transform: { maxWidth: 160 }) } } }
  }`;

export async function findTargets(admin, q) {
  const t = String(q ?? "").trim().slice(0, 80).replace(/["\\]/g, " ");
  if (t.length < 2) return { products: [], collections: [] };
  // Archived products can't be sold, so they're left out
  const [products, collections] = await Promise.all([gql(admin, FIND_PRODUCTS, { q: `title:*${t}* -status:archived` }), gql(admin, FIND_COLLECTIONS, { q: `title:*${t}*` })]);
  const d = { products: products?.products, collections: collections?.collections };
  return {
    products: (d?.products?.nodes ?? []).filter((p) => p.status !== "ARCHIVED").map((p) => ({
      id: p.id,
      title: p.title,
      image: p.featuredImage?.url ?? null,
      price: p.priceRangeV2?.minVariantPrice?.amount != null ? Number(p.priceRangeV2.minVariantPrice.amount) : null,
      priceVaries: p.priceRangeV2 ? p.priceRangeV2.minVariantPrice.amount !== p.priceRangeV2.maxVariantPrice.amount : false,
    })),
    collections: (d?.collections?.nodes ?? []).map((c) => ({ id: c.id, title: c.title, image: c.image?.url ?? null })),
  };
}

// ---------------------------------------------------------------------------
// Every minute: early access moves from locked → members → open, and sales
// whose tiers changed (renamed in Loyalty) are re-sent
// ---------------------------------------------------------------------------

// Finished sales' discounts come out of Shopify (expired ones stay listed
// there otherwise, and keep their titles taken)
async function clearFinished(shop, admin) {
  const finished = (await db.sale.findMany({ where: { shop, kind: { in: ["items", "order"] }, OR: [{ endsAt: { lte: new Date() } }, { active: false }] } })).filter((s) => s.discounts || s.discountId);
  for (const s of finished) {
    try {
      for (const id of discountIdsOf(s)) await deleteDiscount(admin, id);
      await db.sale.update({ where: { id: s.id }, data: { discounts: null, discountId: null, syncedAt: new Date() } });
    } catch (e) {
      console.error(`[sales] ${shop} ${s.name}: clearing finished sale:`, errorMessage(e));
    }
  }
}

export async function tick(shop, admin) {
  const program = await getProgram(shop);
  const early = await db.sale.findMany({ where: { shop, kind: "earlyAccess", active: true, endsAt: { gt: new Date() } } });
  const renamed = early.filter((s) => JSON.stringify(tagsFor(s, program)) !== (s.syncedTags ?? "[]"));
  await syncEarlyAccess(shop, admin, { force: renamed.length > 0 });
  for (const s of renamed) await db.sale.update({ where: { id: s.id }, data: { syncedTags: JSON.stringify(tagsFor(s, program)) } });
  const sales = await db.sale.findMany({ where: { shop, kind: { in: ["items", "order"] }, active: true, endsAt: { gt: new Date() } } });
  for (const s of sales) {
    const missing = !s.discountId && (!s.syncError || !s.syncedAt || Date.now() - s.syncedAt.getTime() > 15 * 60_000);
    if (JSON.stringify(tagsFor(s, program)) !== (s.syncedTags ?? "[]") || missing) await syncSale(shop, admin, s, program).catch((e) => console.error(`[sales] ${shop} ${s.name}:`, errorMessage(e)));
  }
  // Finished sales: their discounts come out of Shopify (the sale stays in
  // MonkeyBean, on the Finished tab)
  await clearFinished(shop, admin);
  // Ended sales' tabs and product-page prices drop off
  const lastTab = await db.sale.findFirst({ where: { shop, OR: [{ tabEnabled: true }, { kind: "items" }], endsAt: { lte: new Date(), gt: new Date(Date.now() - 2 * 60_000) } } });
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
