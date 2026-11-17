import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { errorMessage, gql } from "./preorders.server";

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
// ---------------------------------------------------------------------------

export class FreebieError extends Error {}

export const MF_NAMESPACE = "oh_freebie";
export const MF_KEY = "offers";
const MAX_IMAGE = 4 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const appUrl = () => (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
export const imageUrlOf = (f) => (f?.imageId ? `${appUrl()}/freebie-image/${f.imageId}` : null);

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
  showing: f.active && f.stock > 0 && products.length > 0,
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

export async function saveFreebie(shop, admin, { id = null, title, description, sku, barcode, stock, active }, user) {
  const t = clean(title, 200);
  if (!t) throw new FreebieError("Give the freebie a name.");
  const left = Number(stock);
  if (!Number.isInteger(left) || left < 0) throw new FreebieError("Stock has to be a whole number, 0 or more.");
  const data = {
    title: t,
    description: clean(description),
    sku: clean(sku, 100),
    barcode: clean(barcode, 100),
    stock: left,
    active: active !== false,
  };
  let f;
  if (id) {
    const was = await db.freebie.findFirst({ where: { shop, id: Number(id) } });
    if (!was) throw new FreebieError("That freebie isn't there anymore.");
    f = await db.freebie.update({ where: { id: was.id }, data });
  } else {
    f = await db.freebie.create({ data: { shop, ...data, createdBy: user?.name ?? null } });
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
  if (!links.length) return [];
  const already = await db.freebieGrant.findMany({ where: { shop, orderId } });
  const given = [];
  const emptied = new Set();
  for (const l of links) {
    if (already.some((g) => g.freebieId === l.freebieId && g.productId === l.productId)) continue;
    const n = await takeStock(l.freebieId, bought[l.productId]);
    if (!n) continue;
    try {
      await db.freebieGrant.create({
        data: { shop, freebieId: l.freebieId, orderId, orderName: payload.name ?? null, customerId: payload.customer?.admin_graphql_api_id ?? null, productId: l.productId, quantity: n },
      });
      given.push({ freebieId: l.freebieId, productId: l.productId, quantity: n });
    } catch (e) {
      // Another delivery of the same webhook got there first: put the units back
      await giveBack(l.freebieId, n);
      if (!/unique/i.test(errorMessage(e))) throw e;
    }
    const f = await db.freebie.findUnique({ where: { id: l.freebieId } });
    if (f && f.stock <= 0) emptied.add(f.id);
  }
  // Ran out: off the product pages
  for (const id of emptied) await syncOffersFor(shop, admin, { freebieId: id }).catch((e) => console.error(`[freebies] offers ${id}:`, errorMessage(e)));
  if (given.length) {
    await refreshFreebieLines(shop, orderId);
    await writeOrderGifts(shop, admin, orderId);
  }
  return given;
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
    await giveBack(g.freebieId, g.quantity);
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
