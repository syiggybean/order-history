import { randomUUID } from "node:crypto";
import db from "./db.server";
import { errorMessage, gql } from "./preorders.server";
import { listBins } from "./batches.server";

// ---------------------------------------------------------------------------
// Stock: bins plus live stock numbers, and counting.
//
// Each item shows Available, Committed and On hand at one location, straight
// from Shopify. Counts are entered in the browser, reviewed, then submitted
// together: each count becomes the item's On hand at that location
// (inventorySetQuantities, "on_hand"). Committed is left alone, so Available
// becomes count − committed.
//
// Safety:
//   - Before writing, every item is read again from Shopify. If its On hand
//     changed since the person counted it (an order shipped, someone else
//     adjusted it), it's skipped and reported, so a stale count never wins.
//   - The write itself uses changeFromQuantity, so a change in the last
//     moment is refused by Shopify too.
//   - Products in a pre-order countdown with a sales limit are skipped: the
//     countdown manages their stock.
// Every submission is logged (StockCount) with before and after numbers.
// ---------------------------------------------------------------------------

export class StockError extends Error {}

const MAX_ROWS = 300;
const MAX_COUNT = 100000;
const norm = (s) => String(s ?? "").trim().toLowerCase();
const binOrder = (a, b) => {
  if (a.bin && !b.bin) return -1;
  if (!a.bin && b.bin) return 1;
  return (
    (a.bin ?? "").localeCompare(b.bin ?? "", undefined, { numeric: true, sensitivity: "base" }) ||
    String(a.title).localeCompare(String(b.title), undefined, { numeric: true }) ||
    (a.variantTitle ?? "").localeCompare(b.variantTitle ?? "", undefined, { numeric: true })
  );
};

const LOCATIONS = `#graphql
  query StockLocations { locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`;

export async function stockLocations(admin) {
  const nodes = (await gql(admin, LOCATIONS))?.locations?.nodes ?? [];
  return nodes.filter((l) => l.isActive).map((l) => ({ id: l.id, name: l.name, online: Boolean(l.fulfillsOnlineOrders) }));
}

export const defaultLocation = (locations) => (locations.find((l) => l.online) ?? locations[0])?.id ?? null;

const LEVELS = `#graphql
  query StockLevels($ids: [ID!]!, $location: ID!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        sku
        barcode
        title
        product { id title }
        image { url(transform: { maxWidth: 80 }) }
        inventoryItem {
          id
          tracked
          inventoryLevel(locationId: $location) { quantities(names: ["available", "committed", "on_hand"]) { name quantity } }
        }
      }
    }
  }`;

const FIND = `#graphql
  query StockFind($q: String!) {
    productVariants(first: 25, query: $q) { nodes { id } }
  }`;

// variantId -> { inventoryItemId, tracked, stocked, available, committed, onHand, ... }
async function readLevels(admin, variantIds, locationId) {
  const out = new Map();
  for (let i = 0; i < variantIds.length; i += 100) {
    const data = await gql(admin, LEVELS, { ids: variantIds.slice(i, i + 100), location: locationId });
    for (const v of data?.nodes ?? []) {
      if (!v?.id) continue;
      const level = v.inventoryItem?.inventoryLevel;
      const q = (name) => level?.quantities?.find((x) => x.name === name)?.quantity ?? 0;
      out.set(v.id, {
        variantId: v.id,
        productId: v.product?.id ?? null,
        title: v.product?.title ?? null,
        variantTitle: v.title && v.title !== "Default Title" ? v.title : null,
        sku: v.sku ?? null,
        barcode: v.barcode ?? null,
        imageUrl: v.image?.url ?? null,
        inventoryItemId: v.inventoryItem?.id ?? null,
        tracked: v.inventoryItem?.tracked !== false,
        stocked: Boolean(level),
        available: level ? q("available") : null,
        committed: level ? q("committed") : null,
        onHand: level ? q("on_hand") : null,
      });
    }
  }
  return out;
}

// Products whose stock a pre-order countdown manages (sales limit)
async function limitedProducts(shop) {
  const rows = await db.preorderWindow.findMany({ where: { shop, limits: { not: null } }, select: { productId: true } });
  return new Set(rows.map((r) => r.productId));
}

// The list: items with a bin (optionally only bins starting with `bin`), items on
// open orders, and (when searching) anything in Shopify that matches.
export async function listStock(shop, admin, { q = "", bin = "", missing = false, locationId } = {}) {
  if (!locationId) throw new StockError("Choose a location.");
  const needle = norm(q);
  const prefix = norm(bin);
  const items = new Map();
  // Items on open orders, and every saved bin
  for (const i of await listBins(shop, { q: "", missing: false })) items.set(i.variantId, { ...i });
  const saved = await db.productBin.findMany({ where: { shop } });
  for (const b of saved) {
    const it = items.get(b.variantId) ?? { variantId: b.variantId, productId: b.productId, title: b.title ?? "(unknown item)", variantTitle: null, sku: b.sku, barcode: b.barcode, imageUrl: null, units: 0 };
    items.set(b.variantId, { ...it, bin: b.bin });
  }
  // Searching: also look in Shopify, so anything can be counted
  if (needle) {
    const term = String(q).trim().replace(/["\\]/g, "");
    const found = (await gql(admin, FIND, { q: `sku:"${term}" OR barcode:"${term}" OR title:*${term.split(/\s+/)[0]}*` }))?.productVariants?.nodes ?? [];
    for (const v of found) if (!items.has(v.id)) items.set(v.id, { variantId: v.id, title: "", fromSearch: true });
  }
  let list = [...items.values()];
  if (prefix) list = list.filter((i) => norm(i.bin).startsWith(prefix));
  if (missing) list = list.filter((i) => !i.bin);
  // Text filter on what we know; Shopify search results always stay
  if (needle) list = list.filter((i) => i.fromSearch || [i.title, i.variantTitle, i.sku, i.barcode, i.bin].some((v) => norm(v).includes(needle)));
  const total = list.length;
  list = list.sort(binOrder).slice(0, MAX_ROWS);

  const levels = await readLevels(admin, list.map((i) => i.variantId), locationId);
  const limited = await limitedProducts(shop);
  const rows = list
    .map((i) => {
      const l = levels.get(i.variantId);
      if (!l) return null; // deleted in Shopify
      return {
        ...i,
        ...l,
        title: l.title ?? i.title,
        imageUrl: l.imageUrl ?? i.imageUrl ?? null,
        bin: i.bin ?? null,
        units: i.units ?? 0,
        preorderLimited: limited.has(l.productId),
      };
    })
    .filter(Boolean)
    .sort(binOrder);
  return { rows, total, capped: total > MAX_ROWS };
}

// ---------------------------------------------------------------------------
// Submitting counts
// ---------------------------------------------------------------------------

const SET = `#graphql
  mutation StockCountSet($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }`;

const ACTIVATE = `#graphql
  mutation StockActivate($item: ID!, $location: ID!, $onHand: Int!) {
    inventoryActivate(inventoryItemId: $item, locationId: $location, onHand: $onHand) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }`;

export const COUNT_URI_PREFIX = "gid://order-history/StockCount/";

async function setOnHand(admin, locationId, list, countId) {
  const data = await gql(admin, SET, {
    key: randomUUID(),
    input: {
      name: "on_hand",
      reason: "cycle_count_available",
      referenceDocumentUri: `${COUNT_URI_PREFIX}${countId}`,
      quantities: list.map((x) => ({ inventoryItemId: x.inventoryItemId, locationId, quantity: x.counted, changeFromQuantity: x.before })),
    },
  });
  return data?.inventorySetQuantities?.userErrors ?? [];
}

// counts: [{ variantId, seen (On hand shown when counted, null if not stocked there), count }]
export async function applyCounts(shop, admin, { locationId, locationName = null, counts }, user) {
  if (!locationId) throw new StockError("Choose a location.");
  const list = (Array.isArray(counts) ? counts : []).filter((c) => c && typeof c.variantId === "string");
  if (!list.length) throw new StockError("Enter at least one count.");
  if (list.length > 500) throw new StockError("Submit up to 500 counts at a time.");
  for (const c of list) {
    const n = Number(c.count);
    if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) throw new StockError("Counts must be whole numbers, 0 or more.");
  }

  // Fresh numbers from Shopify, and what the countdowns manage
  const fresh = await readLevels(admin, [...new Set(list.map((c) => c.variantId))], locationId);
  const limited = await limitedProducts(shop);
  const binOf = new Map((await db.productBin.findMany({ where: { shop, variantId: { in: list.map((c) => c.variantId) } } })).map((b) => [b.variantId, b.bin]));

  const results = list.map((c) => {
    const f = fresh.get(c.variantId);
    const base = {
      variantId: c.variantId,
      title: f ? (f.variantTitle ? `${f.title} – ${f.variantTitle}` : f.title) : "(deleted item)",
      sku: f?.sku ?? null,
      bin: binOf.get(c.variantId) ?? null,
      inventoryItemId: f?.inventoryItemId ?? null,
      seen: c.seen ?? null,
      before: f?.onHand ?? null,
      counted: Number(c.count),
    };
    if (!f) return { ...base, status: "skipped", error: "No longer in Shopify." };
    if (!f.tracked) return { ...base, status: "skipped", error: "Doesn't track stock in Shopify." };
    if (limited.has(f.productId)) return { ...base, status: "skipped", error: "Managed by a pre-order countdown with a sales limit. Change its stock there." };
    const seen = c.seen === null || c.seen === undefined ? null : Number(c.seen);
    if ((f.stocked ? f.onHand : null) !== seen) {
      return { ...base, status: "changed", error: `On hand changed from ${seen ?? "not stocked"} to ${f.stocked ? f.onHand : "not stocked"} since you counted. Check it and count again.` };
    }
    if (f.stocked && f.onHand === base.counted) return { ...base, status: "unchanged" };
    return { ...base, status: f.stocked ? "pending" : "activate" };
  });

  const log = await db.stockCount.create({
    data: { shop, locationId, locationName, userName: user?.name ?? null, items: "[]" },
  });

  // Not stocked at this location yet: start stocking it with the count
  for (const r of results.filter((x) => x.status === "activate")) {
    try {
      const d = await gql(admin, ACTIVATE, { item: r.inventoryItemId, location: locationId, onHand: r.counted });
      const errs = d?.inventoryActivate?.userErrors ?? [];
      if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
      Object.assign(r, { status: "applied", before: 0 });
    } catch (e) {
      Object.assign(r, { status: "failed", error: errorMessage(e) });
    }
  }
  // Stocked: set On hand, 25 at a time; if Shopify refuses a group, retry one by one to find which
  const todo = results.filter((x) => x.status === "pending");
  for (let i = 0; i < todo.length; i += 25) {
    const part = todo.slice(i, i + 25);
    let errs;
    try {
      errs = await setOnHand(admin, locationId, part, log.id);
    } catch (e) {
      errs = [{ message: errorMessage(e) }];
    }
    if (!errs.length) {
      for (const r of part) r.status = "applied";
      continue;
    }
    for (const r of part) {
      try {
        const one = await setOnHand(admin, locationId, [r], log.id);
        if (one.length) throw new Error(one.map((e) => e.message).join("; "));
        r.status = "applied";
      } catch (e) {
        const msg = errorMessage(e);
        Object.assign(r, { status: /change|stale|compare/i.test(msg) ? "changed" : "failed", error: /change|stale|compare/i.test(msg) ? "On hand changed in Shopify just now. Check it and count again." : msg });
      }
    }
  }

  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => ["failed", "changed", "skipped"].includes(r.status)).length;
  await db.stockCount.update({
    where: { id: log.id },
    data: { items: JSON.stringify(results.map(({ inventoryItemId, ...r }) => r)), applied, failed },
  });
  return { countId: log.id, applied, unchanged: results.filter((r) => r.status === "unchanged").length, failed, results };
}

export async function recentCounts(shop, take = 8) {
  const rows = await db.stockCount.findMany({ where: { shop }, orderBy: { id: "desc" }, take });
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    userName: r.userName,
    locationName: r.locationName,
    applied: r.applied,
    failed: r.failed,
    items: JSON.parse(r.items || "[]"),
  }));
}
