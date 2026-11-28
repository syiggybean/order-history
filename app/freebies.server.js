import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { dayInStore, errorMessage, gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Freebies: a free gift attached to one or more products.
//
// - While a freebie is on and has stock left, the product page shows it (photo,
//   title and description) through the "Freebie" theme block, from the
//   product's oh_freebie.offers metafield, which the app keeps up to date.
// - Every unit bought of an attached product gets one, while stock lasts
//   (orders/create). It's not a Shopify product: nothing changes at checkout.
// - The gift rides along with the order's box in the shipping hub
//   (Shipment.freebieLines), so it's on the pick list, the packing screen and
//   the packing slip. A cancelled order gives its freebies back to the stock.
//
// Two more kinds work per order instead of per product, during a time window,
// and only for orders with at least one in-stock item (not a pre-order: no
// future release date and no GT tag, the same rule Shipping uses):
// - firstOrders: the first N such orders get one
// - minSpend: such orders with a subtotal (after discounts, before shipping
//   and tax) of $X or more get one
// One gift per order per offer; every offer an order qualifies for applies, so
// they stack with each other and with product freebies. It goes in the box with
// the in-stock item.
//
// The gift itself is either the freebie's own count ("left to give away"), or a
// product from the store (one variant): then each gift takes one from that
// variant's available Shopify stock (the main location, or wherever there is
// some), a cancelled order puts it back, and both show in the inventory
// history as the order's free gift. Name, photo, SKU and barcode come from the
// product, so it's scanned at packing like any item.
// ---------------------------------------------------------------------------

import { fromStoreInput, toStoreInput } from "./preorder-windows.server";

export class FreebieError extends Error {}
export const KINDS = ["product", "firstOrders", "minSpend"];
const ORDER_KINDS = ["firstOrders", "minSpend"];

export const MF_NAMESPACE = "oh_freebie";
export const MF_KEY = "offers";
const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const appUrl = () => (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
// An uploaded photo, else the store product's own
export const imageUrlOf = (f) => (f?.imageId ? `${appUrl()}/freebie-image/${f.imageId}` : f?.sourceImageUrl ?? null);
// Inventory adjustments for gifts point back here (inventory history)
export const FREEBIE_URI_PREFIX = "gid://order-history/FreebieGrant/";

const METAFIELDS_SET = `#graphql
  mutation ($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;
const METAFIELDS_DELETE = `#graphql
  mutation ($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;
const PRODUCTS = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id title handle featuredMedia { preview { image { url(transform: { maxWidth: 120 }) } } } }
    }
  }`;

const clean = (s, max = 2000) => {
  const t = String(s ?? "").trim();
  return t ? t.slice(0, max) : null;
};
const gid = (n) => (String(n).startsWith("gid://") ? String(n) : `gid://shopify/Product/${n}`);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const view = (f, products = [], recent = []) => ({
  id: f.id,
  title: f.title,
  description: f.description,
  imageUrl: imageUrlOf(f),
  sku: f.sku,
  barcode: f.barcode,
  stock: f.stock,
  given: f.given,
  active: f.active,
  kind: f.kind ?? "product",
  startsAt: f.startsAt ? f.startsAt.toISOString() : null,
  endsAt: f.endsAt ? f.endsAt.toISOString() : null,
  startsInput: f.startsAt ? toStoreInput(f.startsAt) : "",
  endsInput: f.endsAt ? toStoreInput(f.endsAt) : "",
  maxOrders: f.maxOrders ?? null,
  minSubtotal: f.minSubtotal ?? null,
  ordersGranted: f.ordersGranted ?? 0,
  phase: phaseOf(f),
  // The store product it is, if any (stock is then Shopify's)
  source: f.variantId ? { variantId: f.variantId, productId: f.sourceProductId, title: f.sourceTitle, imageUrl: f.sourceImageUrl } : null,
  showing: ORDER_KINDS.includes(f.kind) ? f.active && f.stock > 0 && phaseOf(f) === "live" && !(f.kind === "firstOrders" && f.ordersGranted >= (f.maxOrders ?? 0)) : f.active && f.stock > 0 && products.length > 0,
  createdBy: f.createdBy,
  updatedAt: f.updatedAt.toISOString(),
  products: products.map((p) => ({ productId: p.productId, title: p.title, handle: p.handle, imageUrl: p.imageUrl })),
  recent,
});

export async function listFreebies(shop) {
  const [rows, links, grants] = await Promise.all([
    db.freebie.findMany({ where: { shop }, orderBy: [{ active: "desc" }, { title: "asc" }] }),
    db.freebieProduct.findMany({ where: { shop }, orderBy: { title: "asc" } }),
    db.freebieGrant.findMany({ where: { shop, returnedAt: null }, orderBy: { createdAt: "desc" }, take: 300 }),
  ]);
  return rows.map((f) =>
    view(
      f,
      links.filter((l) => l.freebieId === f.id),
      grants
        .filter((g) => g.freebieId === f.id)
        .slice(0, 8)
        .map((g) => ({ orderName: g.orderName, quantity: g.quantity, at: g.createdAt.toISOString() })),
    ),
  );
}

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

// Where an order offer's window is: upcoming, live or over
export function phaseOf(f, now = Date.now()) {
  if (!ORDER_KINDS.includes(f.kind)) return null;
  if (f.startsAt && now < new Date(f.startsAt).getTime()) return "upcoming";
  if (f.endsAt && now >= new Date(f.endsAt).getTime()) return "over";
  return "live";
}

// ---------------------------------------------------------------------------
// A product from the store as the gift
// ---------------------------------------------------------------------------

const VARIANT = `#graphql
  query FreebieVariant($id: ID!) {
    productVariant(id: $id) {
      id title sku barcode
      image { url(transform: { maxWidth: 400 }) }
      product { id title status featuredMedia { preview { image { url(transform: { maxWidth: 400 }) } } } }
      inventoryItem { id tracked }
    }
  }`;
const LEVELS = `#graphql
  query FreebieLevels($id: ID!) {
    inventoryItem(id: $id) {
      tracked
      inventoryLevels(first: 25) { nodes { location { id } quantities(names: ["available"]) { name quantity } } }
    }
    location { id }
  }`;
const ADJUST = `#graphql
  mutation FreebieStock($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }`;
const FIND_VARIANTS = `#graphql
  query FreebieFindVariants($q: String!) {
    products(first: 8, query: $q) {
      nodes {
        id title status
        featuredMedia { preview { image { url(transform: { maxWidth: 120 }) } } }
        variants(first: 20) { nodes { id title sku barcode inventoryQuantity image { url(transform: { maxWidth: 120 }) } inventoryItem { tracked } } }
      }
    }
  }`;

const variantName = (productTitle, variantTitle) => (variantTitle && variantTitle !== "Default Title" ? `${productTitle} – ${variantTitle}` : productTitle);

// What linking to this variant sets on the freebie
async function variantSource(admin, variantId) {
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) throw new FreebieError("Pick a product from the list.");
  const v = (await gql(admin, VARIANT, { id: variantId }))?.productVariant;
  if (!v) throw new FreebieError("That product isn't in Shopify anymore.");
  if (v.product.status === "ARCHIVED") throw new FreebieError(`${v.product.title} is archived. Unarchive it in Shopify, or pick another product.`);
  if (!v.inventoryItem?.tracked) throw new FreebieError(`Shopify doesn't track stock for ${variantName(v.product.title, v.title)}. Turn on "Track quantity" for it in Shopify first.`);
  const levels = await readLevels(admin, v.inventoryItem.id);
  return {
    variantId: v.id,
    inventoryItemId: v.inventoryItem.id,
    sourceProductId: v.product.id,
    sourceTitle: variantName(v.product.title, v.title),
    sourceImageUrl: v.image?.url ?? v.product.featuredMedia?.preview?.image?.url ?? null,
    sku: clean(v.sku, 100),
    barcode: clean(v.barcode, 100),
    stock: Math.max(0, levels.total),
  };
}

// Available stock by location, and the store's main location
async function readLevels(admin, inventoryItemId) {
  const d = await gql(admin, LEVELS, { id: inventoryItemId });
  const levels = (d?.inventoryItem?.inventoryLevels?.nodes ?? []).map((l) => ({ locationId: l.location.id, available: l.quantities.find((q) => q.name === "available")?.quantity ?? 0 }));
  return { levels, primary: d?.location?.id ?? null, total: levels.reduce((n, l) => n + Math.max(0, l.available), 0) };
}

// The store's products and their variants, for picking a gift (not archived ones)
export async function searchGiftVariants(admin, q) {
  const t = String(q ?? "").trim().slice(0, 80).replace(/["\\()]/g, " ");
  if (t.length < 2) return [];
  const d = await gql(admin, FIND_VARIANTS, { q: `(title:*${t}* OR sku:*${t}*) -status:archived` });
  const out = [];
  for (const p of d?.products?.nodes ?? []) {
    if (p.status === "ARCHIVED") continue;
    for (const v of p.variants?.nodes ?? []) {
      out.push({
        variantId: v.id,
        productId: p.id,
        title: variantName(p.title, v.title),
        sku: v.sku || null,
        imageUrl: v.image?.url ?? p.featuredMedia?.preview?.image?.url ?? null,
        available: v.inventoryQuantity ?? 0,
        tracked: Boolean(v.inventoryItem?.tracked),
      });
    }
  }
  return out.slice(0, 30);
}

// One adjustment of available stock, retried if the count moved meanwhile
async function adjustAvailable(admin, { inventoryItemId, locationId, delta, reason, grantId, key }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { levels } = await readLevels(admin, inventoryItemId);
    const from = levels.find((l) => l.locationId === locationId)?.available;
    if (from === undefined) return { error: "That location doesn't stock it anymore." };
    if (delta < 0 && from + delta < 0) return { error: "Not enough stock.", short: true };
    const d = await gql(admin, ADJUST, {
      key: `${key}-${attempt}`,
      input: { name: "available", reason, referenceDocumentUri: `${FREEBIE_URI_PREFIX}${grantId}`, changes: [{ delta, inventoryItemId, locationId, changeFromQuantity: from }] },
    });
    const err = d?.inventoryAdjustQuantities?.userErrors?.[0];
    if (!err) return { ok: true };
    if (!(err.code === "CHANGE_FROM_QUANTITY_STALE" || /stale|changed/i.test(err.message))) return { error: err.message };
  }
  return { error: "The stock kept changing. Try again." };
}

// Takes up to n of a store product as gifts and records them. Returns how many.
async function giveFromShopify(admin, f, n, grant) {
  if (!f.active || !admin) return 0;
  const { levels, primary, total } = await readLevels(admin, f.inventoryItemId);
  const main = levels.find((l) => l.locationId === primary && l.available > 0);
  const at = main ?? [...levels].sort((a, b) => b.available - a.available).find((l) => l.available > 0);
  const want = at ? Math.min(n, at.available) : 0;
  if (!want) {
    if (f.stock !== Math.max(0, total)) await db.freebie.update({ where: { id: f.id }, data: { stock: Math.max(0, total) } });
    return 0;
  }
  // The record first: a second delivery of the same order stops here
  let row;
  try {
    row = await db.freebieGrant.create({ data: { ...grant, quantity: want, locationId: at.locationId } });
  } catch (e) {
    if (/unique/i.test(errorMessage(e))) return 0;
    throw e;
  }
  const r = await adjustAvailable(admin, { inventoryItemId: f.inventoryItemId, locationId: at.locationId, delta: -want, reason: "promotion", grantId: row.id, key: `freebie-take-${row.id}` });
  if (!r.ok) {
    console.error(`[freebies] ${f.title} for ${grant.orderName}: stock not taken: ${r.error}`);
    await db.freebieGrant.delete({ where: { id: row.id } });
    return 0;
  }
  const fresh = await db.freebie.findUnique({ where: { id: f.id } });
  await db.freebie.update({ where: { id: f.id }, data: { stock: Math.max(0, total - want), given: (fresh?.given ?? 0) + want } });
  return want;
}

// The gift for one order: from the freebie's count or from Shopify stock.
// Returns how many were given (0: none left, or already given).
async function give(admin, f, n, grant) {
  if (f.inventoryItemId) return giveFromShopify(admin, f, n, grant);
  const got = await takeStock(f.id, n);
  if (!got) return 0;
  try {
    await db.freebieGrant.create({ data: { ...grant, quantity: got } });
    return got;
  } catch (e) {
    // Another delivery of the same webhook got there first: put the units back
    await giveBack(f.id, got);
    if (!/unique/i.test(errorMessage(e))) throw e;
    return 0;
  }
}

// A store product's stock moved (inventory webhook): keep its freebies' count,
// and the product pages, in step
export async function freebieStockMoved(shop, inventoryItemId) {
  const item = /^\d+$/.test(String(inventoryItemId ?? "")) ? `gid://shopify/InventoryItem/${inventoryItemId}` : String(inventoryItemId ?? "");
  if (!item) return;
  const linked = await db.freebie.findMany({ where: { shop, inventoryItemId: item } });
  if (!linked.length) return;
  const { admin } = await unauthenticated.admin(shop);
  const { total } = await readLevels(admin, item);
  for (const f of linked) {
    if (f.stock === total) continue;
    await db.freebie.update({ where: { id: f.id }, data: { stock: Math.max(0, total) } });
    // Ran out, or back: on or off the product pages
    if ((f.stock > 0) !== (total > 0)) await syncOffersFor(shop, admin, { freebieId: f.id }).catch((e) => console.error(`[freebies] offers ${f.id}:`, errorMessage(e)));
  }
}

export async function saveFreebie(shop, admin, { id = null, title, description, sku, barcode, stock, active, kind = undefined, starts, ends, maxOrders, minSubtotal, variantId = undefined }, user) {
  const was = id ? await db.freebie.findFirst({ where: { shop, id: Number(id) } }) : null;
  if (id && !was) throw new FreebieError("That freebie isn't there anymore.");
  // A store product as the gift: "" unlinks it, undefined leaves it as it is
  const linkTo = variantId === undefined ? (was?.variantId ?? null) : String(variantId).trim() || null;
  const source = linkTo ? await variantSource(admin, linkTo) : null;
  const t = clean(title, 200) ?? source?.sourceTitle ?? null;
  if (!t) throw new FreebieError("Give the freebie a name.");
  const left = Number(stock);
  if (!source && (!Number.isInteger(left) || left < 0)) throw new FreebieError("Stock has to be a whole number, 0 or more.");
  const data = {
    title: t,
    description: clean(description),
    sku: clean(sku, 100),
    barcode: clean(barcode, 100),
    stock: source ? source.stock : left,
    active: active !== false,
    variantId: null,
    inventoryItemId: null,
    sourceProductId: null,
    sourceTitle: null,
    sourceImageUrl: null,
  };
  if (source) {
    const { stock: _s, ...rest } = source;
    Object.assign(data, rest);
  }
  // Who gets it
  if (kind !== undefined) {
    if (!KINDS.includes(kind)) throw new FreebieError("Choose who gets the freebie.");
    data.kind = kind;
    if (ORDER_KINDS.includes(kind)) {
      const s = fromStoreInput(starts);
      const e = fromStoreInput(ends);
      if (!s || !e) throw new FreebieError("Set when the offer starts and ends.");
      if (e <= s) throw new FreebieError("The offer has to end after it starts.");
      data.startsAt = s;
      data.endsAt = e;
      if (kind === "firstOrders") {
        const n = Number(maxOrders);
        if (!Number.isInteger(n) || n < 1) throw new FreebieError("Set how many orders get one (1 or more).");
        data.maxOrders = n;
        data.minSubtotal = null;
      } else {
        const m = Math.round(Number(minSubtotal) * 100) / 100;
        if (!(m > 0)) throw new FreebieError("Set the order amount (more than $0).");
        data.minSubtotal = m;
        data.maxOrders = null;
      }
    } else {
      Object.assign(data, { startsAt: null, endsAt: null, maxOrders: null, minSubtotal: null });
    }
  }
  let f;
  if (was) {
    f = await db.freebie.update({ where: { id: was.id }, data });
  } else {
    f = await db.freebie.create({ data: { shop, ...data, ordersGranted: 0, createdBy: user?.name ?? null } });
  }
  await syncOffersFor(shop, admin, { freebieId: f.id });
  return f;
}

export async function setImage(shop, admin, id, file) {
  const f = await db.freebie.findFirst({ where: { shop, id: Number(id) } });
  if (!f) throw new FreebieError("That freebie isn't there anymore.");
  if (!file || typeof file.arrayBuffer !== "function" || !file.size) throw new FreebieError("Choose a photo to upload.");
  if (!IMAGE_TYPES.includes(file.type)) throw new FreebieError("The photo has to be a JPEG, PNG, WebP or GIF.");
  if (file.size > MAX_IMAGE) throw new FreebieError("That photo is over 4 MB. Use a smaller one.");
  const img = await db.freebieImage.create({ data: { shop, contentType: file.type, data: Buffer.from(await file.arrayBuffer()) } });
  await db.freebie.update({ where: { id: f.id }, data: { imageId: img.id } });
  if (f.imageId) await db.freebieImage.deleteMany({ where: { shop, id: f.imageId } });
  await syncOffersFor(shop, admin, { freebieId: f.id });
  return imageUrlOf({ imageId: img.id });
}

export async function getImage(id) {
  return db.freebieImage.findUnique({ where: { id: Number(id) } });
}

export async function attachProducts(shop, admin, id, productIds) {
  const f = await db.freebie.findFirst({ where: { shop, id: Number(id) } });
  if (!f) throw new FreebieError("That freebie isn't there anymore.");
  const ids = [...new Set(productIds.map(gid))].filter((x) => /^gid:\/\/shopify\/Product\/\d+$/.test(x));
  if (!ids.length) throw new FreebieError("Pick a product.");
  const data = await gql(admin, PRODUCTS, { ids });
  for (const p of data?.nodes ?? []) {
    if (!p?.id) continue;
    const row = { title: p.title, handle: p.handle, imageUrl: p.featuredMedia?.preview?.image?.url ?? null };
    const had = await db.freebieProduct.findFirst({ where: { freebieId: f.id, productId: p.id } });
    if (had) await db.freebieProduct.update({ where: { id: had.id }, data: row });
    else await db.freebieProduct.create({ data: { shop, freebieId: f.id, productId: p.id, ...row } });
  }
  await syncOffers(shop, admin, ids);
}

export async function detachProduct(shop, admin, id, productId) {
  await db.freebieProduct.deleteMany({ where: { shop, freebieId: Number(id), productId: String(productId) } });
  await syncOffers(shop, admin, [String(productId)]);
}

// Gone for good. Orders it was already given to keep it on their boxes.
export async function deleteFreebie(shop, admin, id) {
  const f = await db.freebie.findFirst({ where: { shop, id: Number(id) } });
  if (!f) return;
  const links = await db.freebieProduct.findMany({ where: { shop, freebieId: f.id } });
  await db.freebieProduct.deleteMany({ where: { shop, freebieId: f.id } });
  await db.freebie.delete({ where: { id: f.id } });
  await syncOffers(shop, admin, links.map((l) => l.productId));
}

// ---------------------------------------------------------------------------
// The product page: what each product offers right now
// ---------------------------------------------------------------------------

// Offers for these products, written to (or removed from) their metafield
export async function syncOffers(shop, admin, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return;
  const links = await db.freebieProduct.findMany({ where: { shop, productId: { in: ids } } });
  const freebies = links.length ? await db.freebie.findMany({ where: { shop, id: { in: [...new Set(links.map((l) => l.freebieId))] } } }) : [];
  const set = [];
  const remove = [];
  for (const productId of ids) {
    const offers = links
      .filter((l) => l.productId === productId)
      .map((l) => freebies.find((f) => f.id === l.freebieId))
      .filter((f) => f && f.active && f.stock > 0)
      .map((f) => ({ id: f.id, title: f.title, description: f.description ?? "", image: imageUrlOf(f) }));
    if (offers.length) set.push({ ownerId: productId, namespace: MF_NAMESPACE, key: MF_KEY, type: "json", value: JSON.stringify(offers) });
    else remove.push({ ownerId: productId, namespace: MF_NAMESPACE, key: MF_KEY });
  }
  for (let i = 0; i < set.length; i += 25) {
    const data = await gql(admin, METAFIELDS_SET, { metafields: set.slice(i, i + 25) });
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new FreebieError(errs.map((e) => e.message).join("; "));
  }
  for (let i = 0; i < remove.length; i += 25) {
    const data = await gql(admin, METAFIELDS_DELETE, { metafields: remove.slice(i, i + 25) });
    const errs = data?.metafieldsDelete?.userErrors ?? [];
    if (errs.length) throw new FreebieError(errs.map((e) => e.message).join("; "));
  }
}

async function syncOffersFor(shop, admin, { freebieId }) {
  const links = await db.freebieProduct.findMany({ where: { shop, freebieId } });
  await syncOffers(shop, admin, links.map((l) => l.productId));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// Takes up to n from the stock, safely when orders land at once. Returns how many.
async function takeStock(freebieId, n) {
  for (let attempt = 0; attempt < 5 && n > 0; attempt++) {
    const f = await db.freebie.findUnique({ where: { id: freebieId } });
    if (!f || !f.active || f.stock <= 0) return 0;
    const want = Math.min(n, f.stock);
    const r = await db.freebie.updateMany({ where: { id: f.id, stock: f.stock }, data: { stock: f.stock - want, given: (f.given ?? 0) + want } });
    if (r.count) return want;
  }
  return 0;
}

// A new order (orders/create payload): one freebie per unit of an attached
// product, while stock lasts. Safe to run twice (Shopify retries webhooks).
export async function grantFreebies(shop, admin, payload) {
  const orderId = payload?.admin_graphql_api_id;
  if (!orderId || payload?.cancelled_at) return [];
  const bought = {};
  for (const li of payload.line_items ?? []) {
    if (!li?.product_id || !(li.quantity > 0)) continue;
    const pid = gid(li.product_id);
    bought[pid] = (bought[pid] ?? 0) + Number(li.quantity);
  }
  const productIds = Object.keys(bought);
  if (!productIds.length) return [];
  const links = await db.freebieProduct.findMany({ where: { shop, productId: { in: productIds } } });
  const already = await db.freebieGrant.findMany({ where: { shop, orderId } });
  const given = [];
  const emptied = new Set();
  for (const l of links) {
    if (already.some((g) => g.freebieId === l.freebieId && g.productId === l.productId)) continue;
    const f = await db.freebie.findUnique({ where: { id: l.freebieId } });
    if (!f || !f.active) continue;
    const grant = { shop, freebieId: l.freebieId, orderId, orderName: payload.name ?? null, customerId: payload.customer?.admin_graphql_api_id ?? null, productId: l.productId };
    const n = await give(admin, f, bought[l.productId], grant);
    if (n) given.push({ freebieId: l.freebieId, productId: l.productId, quantity: n });
    const after = await db.freebie.findUnique({ where: { id: l.freebieId } });
    if (after && after.stock <= 0) emptied.add(after.id);
  }
  // Ran out: off the product pages
  for (const id of emptied) await syncOffersFor(shop, admin, { freebieId: id }).catch((e) => console.error(`[freebies] offers ${id}:`, errorMessage(e)));
  given.push(...(await grantOrderOffers(shop, admin, payload, orderId, already)));
  if (given.length) {
    await refreshFreebieLines(shop, orderId);
    await writeOrderGifts(shop, admin, orderId);
  }
  return given;
}

// Order offers (first N orders, spend over $X) live when the order was placed
async function grantOrderOffers(shop, admin, payload, orderId, already) {
  const at = new Date(payload.created_at ?? Date.now()).getTime();
  const offers = (await db.freebie.findMany({ where: { shop, active: true, kind: { in: ORDER_KINDS }, stock: { gt: 0 } }, orderBy: { id: "asc" } })).filter(
    (f) => phaseOf(f, at) === "live" && !already.some((g) => g.freebieId === f.id),
  );
  if (!offers.length) return [];
  // The order's in-stock items: shipped products that aren't pre-orders
  const shipped = [...new Set((payload.line_items ?? []).filter((li) => li?.product_id && li.quantity > 0 && li.requires_shipping !== false && !li.gift_card).map((li) => gid(li.product_id)))];
  if (!shipped.length) return [];
  let info;
  try {
    const { loadProductInfo } = await import("./shipping.server");
    info = await loadProductInfo(admin, shipped);
  } catch (e) {
    // Can't tell what's a pre-order: no order offers rather than wrong ones
    console.error(`[freebies] order offers for ${payload.name}:`, errorMessage(e));
    return [];
  }
  const today = dayInStore(new Date(at));
  const inStock = shipped.filter((pid) => !(info[pid]?.release && info[pid].release > today) && !info[pid]?.gtTag);
  if (!inStock.length) return [];
  const subtotal = Number(payload.current_subtotal_price ?? payload.subtotal_price ?? 0);
  const given = [];
  const emptied = new Set();
  for (const f of offers) {
    if (f.kind === "minSpend" && !(subtotal >= (f.minSubtotal ?? Infinity))) continue;
    if (f.kind === "firstOrders" && !(await claimPlace(f.id))) continue;
    const grant = { shop, freebieId: f.id, orderId, orderName: payload.name ?? null, customerId: payload.customer?.admin_graphql_api_id ?? null, productId: inStock[0] };
    const n = await give(admin, f, 1, grant);
    if (!n) {
      if (f.kind === "firstOrders") await releasePlace(f.id);
      continue;
    }
    given.push({ freebieId: f.id, productId: inStock[0], quantity: 1 });
    const after = await db.freebie.findUnique({ where: { id: f.id } });
    if (after && after.stock <= 0) emptied.add(f.id);
  }
  return given;
}

// First N orders: take a place, safely when orders land at once
async function claimPlace(freebieId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await db.freebie.findUnique({ where: { id: freebieId } });
    if (!f || (f.ordersGranted ?? 0) >= (f.maxOrders ?? 0)) return false;
    const r = await db.freebie.updateMany({ where: { id: f.id, ordersGranted: f.ordersGranted ?? 0 }, data: { ordersGranted: (f.ordersGranted ?? 0) + 1 } });
    if (r.count) return true;
  }
  return false;
}
async function releasePlace(freebieId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await db.freebie.findUnique({ where: { id: freebieId } });
    if (!f) return;
    const r = await db.freebie.updateMany({ where: { id: f.id, ordersGranted: f.ordersGranted ?? 0 }, data: { ordersGranted: Math.max(0, (f.ordersGranted ?? 0) - 1) } });
    if (r.count) return;
  }
}

async function giveBack(freebieId, n) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const f = await db.freebie.findUnique({ where: { id: freebieId } });
    if (!f) return;
    const r = await db.freebie.updateMany({ where: { id: f.id, stock: f.stock }, data: { stock: f.stock + n, given: Math.max(0, (f.given ?? 0) - n) } });
    if (r.count) return;
  }
}

// A cancelled order: its freebies go back to the stock (once)
export async function returnFreebies(shop, admin, orderId) {
  const grants = await db.freebieGrant.findMany({ where: { shop, orderId, returnedAt: null } });
  if (!grants.length) return 0;
  const back = new Set();
  for (const g of grants) {
    const r = await db.freebieGrant.updateMany({ where: { id: g.id, returnedAt: null }, data: { returnedAt: new Date() } });
    if (!r.count) continue;
    if (g.locationId) {
      // A store product: back into its Shopify stock where it came from
      const f0 = await db.freebie.findUnique({ where: { id: g.freebieId } });
      if (!admin) admin = await unauthenticated.admin(shop).then((x) => x.admin).catch(() => null);
      const item = f0?.inventoryItemId;
      const res = item && admin ? await adjustAvailable(admin, { inventoryItemId: item, locationId: g.locationId, delta: g.quantity, reason: "restock", grantId: g.id, key: `freebie-back-${g.id}` }) : { error: "no product" };
      if (!res.ok) {
        console.error(`[freebies] ${g.orderName}: gift not put back in stock: ${res.error}`);
        // Try again on the next cancellation update rather than lose it
        await db.freebieGrant.update({ where: { id: g.id }, data: { returnedAt: null } });
        continue;
      }
      if (f0) {
        const { total } = await readLevels(admin, item);
        await db.freebie.update({ where: { id: f0.id }, data: { stock: Math.max(0, total), given: Math.max(0, (f0.given ?? 0) - g.quantity) } });
      }
    } else {
      await giveBack(g.freebieId, g.quantity);
    }
    // First N orders: a cancelled order frees its place for the next order
    const f = await db.freebie.findUnique({ where: { id: g.freebieId } });
    if (f?.kind === "firstOrders") await releasePlace(f.id);
    back.add(g.freebieId);
  }
  // Back in stock: on the product pages again
  if (back.size && !admin) admin = await unauthenticated.admin(shop).then((r) => r.admin).catch(() => null);
  if (admin) for (const id of back) await syncOffersFor(shop, admin, { freebieId: id }).catch((e) => console.error(`[freebies] offers ${id}:`, errorMessage(e)));
  await refreshFreebieLines(shop, orderId);
  if (admin) await writeOrderGifts(shop, admin, orderId);
  return grants.length;
}

// ---------------------------------------------------------------------------
// Boxes: which of the order's shipments carries each gift
// ---------------------------------------------------------------------------

const lineProducts = (s) => {
  try {
    return new Set(JSON.parse(s.lines ?? "[]").map((l) => l.productId));
  } catch {
    return new Set();
  }
};

// The order's gifts go in the box with the product they came with (the first
// such part if the order ships in parts). Not touched once a box is packed.
export async function refreshFreebieLines(shop, orderId) {
  const [grants, shipments] = await Promise.all([
    db.freebieGrant.findMany({ where: { shop, orderId, returnedAt: null } }),
    db.shipment.findMany({ where: { shop, orderId }, orderBy: [{ partIndex: "asc" }, { id: "asc" }] }),
  ]);
  if (!shipments.length) return;
  const freebies = grants.length ? await db.freebie.findMany({ where: { id: { in: [...new Set(grants.map((g) => g.freebieId))] } } }) : [];
  const boxes = new Map(shipments.map((s) => [s.id, []]));
  for (const g of grants) {
    const s = shipments.find((x) => lineProducts(x).has(g.productId));
    if (!s) continue;
    const f = freebies.find((x) => x.id === g.freebieId);
    const lines = boxes.get(s.id);
    const key = `freebie:${g.freebieId}`;
    const hit = lines.find((l) => l.variantId === key);
    if (hit) hit.quantity += g.quantity;
    else
      lines.push({
        variantId: key,
        productId: null,
        title: `Free gift: ${f?.title ?? "Freebie"}`,
        variantTitle: null,
        sku: f?.sku ?? null,
        barcode: f?.barcode ?? null,
        imageUrl: imageUrlOf(f),
        quantity: g.quantity,
        tracked: false,
        freebie: true,
      });
  }
  for (const s of shipments) {
    if (!["waiting", "ready", "batched"].includes(s.state)) continue;
    const lines = boxes.get(s.id);
    const value = lines.length ? JSON.stringify(lines) : null;
    if (value !== (s.freebieLines ?? null)) await db.shipment.update({ where: { id: s.id }, data: { freebieLines: value } });
  }
}

// ---------------------------------------------------------------------------
// The customer's view: their order's gifts
// ---------------------------------------------------------------------------

// The order's gifts, one entry per freebie
export async function giftsOfOrder(shop, orderId, { customerId = undefined } = {}) {
  const where = { shop, orderId, returnedAt: null, ...(customerId !== undefined ? { customerId } : {}) };
  const grants = await db.freebieGrant.findMany({ where, orderBy: { id: "asc" } });
  if (!grants.length) return [];
  const freebies = await db.freebie.findMany({ where: { id: { in: [...new Set(grants.map((g) => g.freebieId))] } } });
  const out = new Map();
  for (const g of grants) {
    const f = freebies.find((x) => x.id === g.freebieId);
    const had = out.get(g.freebieId);
    if (had) had.quantity += g.quantity;
    else out.set(g.freebieId, { title: f?.title ?? "Free gift", description: f?.description ?? "", imageUrl: imageUrlOf(f), quantity: g.quantity });
  }
  return [...out.values()];
}

const ORDER_METAFIELD_SET = METAFIELDS_SET;

// Also on the order in Shopify (oh_freebie.gifts), so staff see it in the admin
async function writeOrderGifts(shop, admin, orderId) {
  try {
    const gifts = await giftsOfOrder(shop, orderId);
    if (gifts.length) {
      await gql(admin, ORDER_METAFIELD_SET, {
        metafields: [{ ownerId: orderId, namespace: MF_NAMESPACE, key: "gifts", type: "json", value: JSON.stringify(gifts.map(({ title, quantity, imageUrl }) => ({ title, quantity, image: imageUrl }))) }],
      });
    } else {
      await gql(admin, METAFIELDS_DELETE, { metafields: [{ ownerId: orderId, namespace: MF_NAMESPACE, key: "gifts" }] });
    }
  } catch (e) {
    console.error(`[freebies] order ${orderId}:`, errorMessage(e));
  }
}

// For the customer's account: gifts on this order, only if it's theirs
export async function customerGifts({ shop, customerId }, orderId) {
  const gid = /^\d+$/.test(String(orderId)) ? `gid://shopify/Order/${orderId}` : String(orderId ?? "");
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(gid)) return [];
  return giftsOfOrder(shop, gid, { customerId });
}
