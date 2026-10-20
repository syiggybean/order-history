import { randomBytes } from "node:crypto";
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { dayInStore, errorMessage, gql, toDay } from "./preorders.server";
import { isGtTag } from "./shipping.server";
import { RESTOCK_KIND, WISHLIST_SOURCE, addWishlistSubscribers, createCampaign, storeUrl } from "./preorder-notify.server";

// ---------------------------------------------------------------------------
// Customer wishlists: the hearts on the storefront, the wishlist page,
// sharing, back-in-stock emails and the "Most wished" report.
// Customers are identified by the logged_in_customer_id Shopify adds to
// app proxy requests, so only logged-in customers have a wishlist.
// ---------------------------------------------------------------------------

export const MAX_ITEMS = 250;
const PRODUCT_TTL_MS = 12 * 3600 * 1000; // product info older than this is refreshed for the report
const CUSTOMER_TTL_MS = 24 * 3600 * 1000;

export class WishlistError extends Error {}

const newToken = () => randomBytes(12).toString("base64url");
export const productGid = (id) => {
  const s = String(id ?? "");
  if (/^gid:\/\/shopify\/Product\/\d+$/.test(s)) return s;
  return /^\d+$/.test(s) ? `gid://shopify/Product/${s}` : null;
};
export const customerKey = (id) => (/^\d+$/.test(String(id ?? "")) ? String(id) : null);
const numId = (gid) => String(gid ?? "").split("/").pop();
// Handles are put into Liquid on the wishlist page, so keep them plain
export const safeHandle = (h) => {
  const s = String(h ?? "").trim();
  return s && s.length <= 255 && !/['"{}%<>\\\s]/.test(s) ? s : null;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getWishSettings(shop) {
  return db.wishlistSettings.upsert({ where: { shop }, create: { shop }, update: {} });
}

export async function saveWishSettings(shop, input) {
  const cur = await getWishSettings(shop);
  const n = (v, min, max, fb) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fb;
  };
  return db.wishlistSettings.update({
    where: { shop },
    data: {
      restockEmails: input.restockEmails !== undefined ? Boolean(input.restockEmails) : cur.restockEmails,
      preorderEmails: input.preorderEmails !== undefined ? Boolean(input.preorderEmails) : cur.preorderEmails,
      minStock: n(input.minStock, 1, 100000, cur.minStock),
      cooldownDays: n(input.cooldownDays, 0, 365, cur.cooldownDays),
    },
  });
}

// ---------------------------------------------------------------------------
// Reading products and customers from Shopify
// ---------------------------------------------------------------------------

const PRODUCTS = `#graphql
  query WishlistProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        handle
        title
        status
        totalInventory
        tracksInventory
        tags
        featuredMedia { preview { image { url } } }
        releaseDate: metafield(namespace: "app-ibp-book", key: "publication_date") { value }
      }
    }
  }`;

const BY_HANDLE = `#graphql
  query WishlistByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { id }
  }`;

const CUSTOMER = `#graphql
  query WishlistCustomer($id: ID!) {
    customer(id: $id) {
      firstName
      defaultEmailAddress { emailAddress }
    }
  }`;

const INVENTORY_PRODUCTS = `#graphql
  query WishlistInventoryItems($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem { id variant { product { id } } }
    }
  }`;

async function adminFor(shop) {
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}

export async function resolveProduct(admin, { productId, handle }) {
  const gid = productGid(productId);
  if (gid) return gid;
  const h = safeHandle(handle);
  if (!h) return null;
  const data = await gql(admin, BY_HANDLE, { handle: h });
  return data?.productByIdentifier?.id ?? null;
}

// Looks up email and first name (for emails and "Sam's wishlist")
export async function ensureCustomer(shop, admin, customerId, { force = false } = {}) {
  const key = customerKey(customerId);
  if (!key) return null;
  const where = { shop_customerId: { shop, customerId: key } };
  let row;
  try {
    row = await db.wishlistCustomer.upsert({ where, create: { shop, customerId: key }, update: {} });
  } catch (e) {
    // Two requests at once both tried to create it
    if (e?.code !== "P2002") throw e;
    row = await db.wishlistCustomer.findUnique({ where });
  }
  if (!force && row.checkedAt && Date.now() - row.checkedAt.getTime() < CUSTOMER_TTL_MS) return row;
  try {
    const data = await gql(admin, CUSTOMER, { id: `gid://shopify/Customer/${key}` });
    const c = data?.customer;
    return await db.wishlistCustomer.update({
      where: { id: row.id },
      data: {
        email: c?.defaultEmailAddress?.emailAddress?.toLowerCase() ?? row.email,
        firstName: c?.firstName ?? row.firstName,
        checkedAt: new Date(),
      },
    });
  } catch (e) {
    console.error("[wishlist] customer lookup:", errorMessage(e));
    return row;
  }
}

// Pure: what a product's stored row should say, from what Shopify returned
export function productRow(p, { minStock = 1, today = dayInStore(new Date()), hasWindow = false } = {}) {
  const tracked = p.tracksInventory !== false;
  const stock = tracked ? Number(p.totalInventory ?? 0) : null;
  const release = toDay(p.releaseDate?.value);
  const preorder = Boolean((p.tags ?? []).some(isGtTag) || (release && release > today) || hasWindow);
  return {
    handle: p.handle ?? null,
    title: p.title ?? null,
    imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    status: p.status ?? null,
    stock,
    tracked,
    inStock: p.status === "ACTIVE" && (!tracked || stock >= minStock),
    preorder,
    missing: false,
  };
}

// Back in stock = was out, now in; not a pre-order; not emailed recently
export function isRestock(prev, next, settings, now = Date.now()) {
  if (!prev || prev.inStock !== false || !next.inStock || next.preorder) return false;
  if (!settings.restockEmails) return false;
  if (prev.restockedAt && now - prev.restockedAt.getTime() < settings.cooldownDays * 86400000) return false;
  return true;
}

// Re-reads products from Shopify and stores them. Sends back-in-stock
// emails for any wished product that has come back.
export async function refreshProducts(shop, admin, productIds, { notify = true } = {}) {
  const ids = [...new Set(productIds.map(productGid).filter(Boolean))];
  if (!ids.length) return { refreshed: 0, restocked: [] };
  const settings = await getWishSettings(shop);
  const [prevRows, windows] = await Promise.all([
    db.wishlistProduct.findMany({ where: { shop, productId: { in: ids } } }),
    db.preorderWindow.findMany({ where: { shop, productId: { in: ids } }, select: { productId: true, opensAt: true, closesAt: true } }),
  ]);
  const prev = new Map(prevRows.map((r) => [r.productId, r]));
  const now = new Date();
  // A countdown that hasn't closed yet makes it a pre-order product
  const windowOpen = new Set(windows.filter((w) => !w.closesAt || w.closesAt > now).map((w) => w.productId));
  const today = dayInStore(now);
  const restocked = [];
  let refreshed = 0;

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const data = await gql(admin, PRODUCTS, { ids: chunk });
    const found = new Map((data?.nodes ?? []).filter((n) => n?.id).map((n) => [n.id, n]));
    for (const id of chunk) {
      const p = found.get(id);
      const before = prev.get(id);
      if (!p) {
        await db.wishlistProduct.upsert({
          where: { shop_productId: { shop, productId: id } },
          create: { shop, productId: id, missing: true, inStock: false, refreshedAt: now },
          update: { missing: true, inStock: false, refreshedAt: now },
        });
        continue;
      }
      const next = productRow(p, { minStock: settings.minStock, today, hasWindow: windowOpen.has(id) });
      refreshed++;
      if (notify && isRestock(before, next, settings, now.getTime())) {
        // Only one of two overlapping checks can flip it from "out", so the
        // emails can't go out twice
        const won = await db.wishlistProduct.updateMany({
          where: { shop, productId: id, inStock: false },
          data: { ...next, refreshedAt: now, restockedAt: now },
        });
        if (won.count) {
          restocked.push({ productId: id, ...next });
          continue;
        }
      }
      await db.wishlistProduct.upsert({
        where: { shop_productId: { shop, productId: id } },
        create: { shop, productId: id, ...next, refreshedAt: now },
        update: { ...next, refreshedAt: now },
      });
    }
  }

  for (const p of restocked) {
    try {
      await sendRestockEmails(shop, admin, p);
    } catch (e) {
      console.error(`[wishlist] back-in-stock emails ${p.productId}:`, errorMessage(e));
    }
  }
  return { refreshed, restocked: restocked.map((p) => p.productId) };
}

export async function sendRestockEmails(shop, admin, product) {
  const emails = await addWishlistSubscribers(shop, product.productId);
  if (!emails.length) return null;
  const base = (await storeUrl(shop, admin)).replace(/\/$/, "");
  return createCampaign(shop, {
    productId: product.productId,
    kind: RESTOCK_KIND,
    dedupeKey: `restock:${product.productId}:${Date.now()}`,
    product: { title: product.title, imageUrl: product.imageUrl },
    productUrl: `${base}/products/${product.handle}`,
    onlyEmails: emails,
  });
}

// ---------------------------------------------------------------------------
// The customer's list
// ---------------------------------------------------------------------------

export async function listItems(shop, customerId, { admin = null } = {}) {
  const key = customerKey(customerId);
  if (!key) return [];
  const items = await db.wishlistItem.findMany({ where: { shop, customerId: key }, orderBy: { createdAt: "desc" } });
  if (!items.length) return [];
  let products = await db.wishlistProduct.findMany({ where: { shop, productId: { in: items.map((i) => i.productId) } } });
  // Fill in any product we haven't read yet
  const known = new Set(products.filter((p) => p.handle || p.missing).map((p) => p.productId));
  const unknown = items.map((i) => i.productId).filter((id) => !known.has(id));
  if (unknown.length && admin) {
    try {
      await refreshProducts(shop, admin, unknown, { notify: false });
      products = await db.wishlistProduct.findMany({ where: { shop, productId: { in: items.map((i) => i.productId) } } });
    } catch (e) {
      console.error("[wishlist] product lookup:", errorMessage(e));
    }
  }
  const byId = new Map(products.map((p) => [p.productId, p]));
  return items.map((i) => {
    const p = byId.get(i.productId);
    return {
      productId: i.productId,
      id: numId(i.productId),
      handle: safeHandle(p?.handle),
      title: p?.title ?? null,
      imageUrl: p?.imageUrl ?? null,
      missing: Boolean(p?.missing),
      addedAt: i.createdAt.toISOString(),
    };
  });
}

export async function countItems(shop, customerId) {
  const key = customerKey(customerId);
  return key ? db.wishlistItem.count({ where: { shop, customerId: key } }) : 0;
}

// Adds (on = true) or removes a product. Returns { on, count, productId }.
export async function setWished(shop, admin, customerId, { productId, handle, on }) {
  const key = customerKey(customerId);
  if (!key) throw new WishlistError("Log in to use your wishlist.");
  const gid = await resolveProduct(admin, { productId, handle });
  if (!gid) throw new WishlistError("We couldn't find that product.");

  if (on) {
    const count = await db.wishlistItem.count({ where: { shop, customerId: key } });
    const exists = await db.wishlistItem.findUnique({ where: { shop_customerId_productId: { shop, customerId: key, productId: gid } } });
    if (!exists) {
      if (count >= MAX_ITEMS) throw new WishlistError(`Your wishlist is full (${MAX_ITEMS} items). Remove something to add more.`);
      const made = await db.wishlistItem.createMany({ data: [{ shop, customerId: key, productId: gid }], skipDuplicates: true });
      if (made.count) await db.wishlistEvent.create({ data: { shop, customerId: key, productId: gid, kind: "add" } });
    }
    // Product info (handle, stock) and the customer's email, without holding up the reply
    const known = await db.wishlistProduct.findUnique({ where: { shop_productId: { shop, productId: gid } } });
    const work = [
      ensureCustomer(shop, admin, key),
      !known || known.missing ? refreshProducts(shop, admin, [gid], { notify: false }) : null,
    ].filter(Boolean);
    Promise.all(work).catch((e) => console.error("[wishlist] add follow-up:", errorMessage(e)));
  } else {
    const gone = await db.wishlistItem.deleteMany({ where: { shop, customerId: key, productId: gid } });
    if (gone.count) await db.wishlistEvent.create({ data: { shop, customerId: key, productId: gid, kind: "remove" } });
    // No more emails about it because of the wishlist
    await db.notifySubscriber.deleteMany({ where: { shop, productId: gid, customerId: key, source: WISHLIST_SOURCE } });
  }
  return { on: Boolean(on), productId: gid, id: numId(gid), count: await db.wishlistItem.count({ where: { shop, customerId: key } }) };
}

export async function getCustomer(shop, customerId) {
  const key = customerKey(customerId);
  return key ? db.wishlistCustomer.findUnique({ where: { shop_customerId: { shop, customerId: key } } }) : null;
}

export async function setEmails(shop, admin, customerId, on) {
  const key = customerKey(customerId);
  if (!key) throw new WishlistError("Log in to use your wishlist.");
  await ensureCustomer(shop, admin, key);
  const row = await db.wishlistCustomer.update({
    where: { shop_customerId: { shop, customerId: key } },
    data: { emailsOn: Boolean(on), emailsSetAt: new Date() },
  });
  if (!on) {
    // Stop anything already queued from the wishlist
    const subs = await db.notifySubscriber.findMany({ where: { shop, customerId: key, source: WISHLIST_SOURCE }, select: { id: true } });
    if (subs.length) {
      await db.emailSend.updateMany({ where: { subscriberId: { in: subs.map((s) => s.id) }, status: "queued" }, data: { status: "skipped" } });
      await db.notifySubscriber.deleteMany({ where: { id: { in: subs.map((s) => s.id) } } });
    }
  }
  return { emailsOn: row.emailsOn };
}

// Turns the share link on (new or existing token) or off
export async function setSharing(shop, admin, customerId, on) {
  const key = customerKey(customerId);
  if (!key) throw new WishlistError("Log in to use your wishlist.");
  const row = await ensureCustomer(shop, admin, key);
  if (!on) {
    await db.wishlistCustomer.update({ where: { id: row.id }, data: { shareToken: null } });
    return { token: null };
  }
  if (row.shareToken) return { token: row.shareToken };
  const token = newToken();
  await db.wishlistCustomer.update({ where: { id: row.id }, data: { shareToken: token } });
  return { token };
}

export async function sharedList(shop, token, { admin = null, countView = false } = {}) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(token ?? ""))) return null;
  const owner = await db.wishlistCustomer.findUnique({ where: { shareToken: token } });
  if (!owner || owner.shop !== shop) return null;
  if (countView) await db.wishlistCustomer.update({ where: { id: owner.id }, data: { shareViews: { increment: 1 } } });
  return { firstName: owner.firstName ?? null, items: await listItems(shop, owner.customerId, { admin }) };
}

// ---------------------------------------------------------------------------
// Keeping stock up to date (webhooks)
// ---------------------------------------------------------------------------

// A product was edited: re-read it if anyone wished for it
export async function wishProductChanged(shop, productId) {
  const gid = productGid(productId);
  if (!gid) return;
  const wished = await db.wishlistItem.findFirst({ where: { shop, productId: gid }, select: { id: true } });
  if (!wished) return;
  await refreshProducts(shop, await adminFor(shop), [gid]);
}

// Stock moved: gather inventory items for a few seconds, then look up which
// products they belong to and re-read the wished ones.
const pendingItems = new Map(); // shop -> Set(inventory item gid)
const timers = new Map();
export const INVENTORY_DEBOUNCE_MS = 15000;

export function wishStockMoved(shop, inventoryItemId, ms = INVENTORY_DEBOUNCE_MS) {
  if (!inventoryItemId) return;
  const gid = String(inventoryItemId).startsWith("gid://") ? String(inventoryItemId) : `gid://shopify/InventoryItem/${inventoryItemId}`;
  if (!pendingItems.has(shop)) pendingItems.set(shop, new Set());
  pendingItems.get(shop).add(gid);
  if (timers.has(shop)) return;
  timers.set(
    shop,
    setTimeout(() => {
      timers.delete(shop);
      const items = [...(pendingItems.get(shop) ?? [])];
      pendingItems.delete(shop);
      checkInventoryItems(shop, items).catch((e) => console.error("[wishlist] stock check:", errorMessage(e)));
    }, ms),
  );
}

export async function checkInventoryItems(shop, inventoryItemIds, admin = null) {
  // Nothing wished for in this store: nothing to do (and no API calls)
  const any = await db.wishlistItem.findFirst({ where: { shop }, select: { id: true } });
  if (!any || !inventoryItemIds.length) return { checked: 0 };
  admin = admin ?? (await adminFor(shop));
  const productIds = new Set();
  for (let i = 0; i < inventoryItemIds.length; i += 100) {
    const data = await gql(admin, INVENTORY_PRODUCTS, { ids: inventoryItemIds.slice(i, i + 100) });
    for (const n of data?.nodes ?? []) if (n?.variant?.product?.id) productIds.add(n.variant.product.id);
  }
  if (!productIds.size) return { checked: 0 };
  const wished = await db.wishlistItem.findMany({
    where: { shop, productId: { in: [...productIds] } },
    distinct: ["productId"],
    select: { productId: true },
  });
  if (!wished.length) return { checked: 0 };
  const r = await refreshProducts(shop, admin, wished.map((w) => w.productId));
  return { checked: wished.length, ...r };
}

// ---------------------------------------------------------------------------
// The "Most wished" report
// ---------------------------------------------------------------------------

export async function wishlistReport(shop, { take = 100, days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const [top, recent, customers, items, recentItems, settings] = await Promise.all([
    db.wishlistItem.groupBy({ by: ["productId"], where: { shop }, _count: { _all: true }, orderBy: { _count: { productId: "desc" } }, take }),
    db.wishlistItem.groupBy({ by: ["productId"], where: { shop, createdAt: { gte: since } }, _count: { _all: true } }),
    db.wishlistItem.groupBy({ by: ["customerId"], where: { shop } }).then((r) => r.length),
    db.wishlistItem.count({ where: { shop } }),
    db.wishlistItem.count({ where: { shop, createdAt: { gte: since } } }),
    getWishSettings(shop),
  ]);
  const ids = top.map((t) => t.productId);
  const [products, bought, sends] = await Promise.all([
    db.wishlistProduct.findMany({ where: { shop, productId: { in: ids } } }),
    db.wishlistConversion.groupBy({ by: ["productId"], where: { shop, productId: { in: ids } }, _count: { _all: true }, _sum: { units: true } }),
    db.emailSend.groupBy({ by: ["productId"], where: { shop, productId: { in: ids }, kind: RESTOCK_KIND, status: "sent" }, _count: { _all: true } }),
  ]);
  const recentBy = new Map(recent.map((r) => [r.productId, r._count._all]));
  const sentBy = new Map(sends.map((r) => [r.productId, r._count._all]));
  const boughtBy = new Map(bought.map((r) => [r.productId, r._count._all]));
  const byId = new Map(products.map((p) => [p.productId, p]));
  const restockSent = await db.emailSend.count({ where: { shop, kind: RESTOCK_KIND, status: "sent" } });
  return {
    totals: { customers, items, recentItems, days, restockSent },
    settings: { restockEmails: settings.restockEmails, preorderEmails: settings.preorderEmails, minStock: settings.minStock, cooldownDays: settings.cooldownDays },
    rows: top.map((t) => {
      const p = byId.get(t.productId);
      return {
        productId: t.productId,
        title: p?.title ?? null,
        handle: p?.handle ?? null,
        imageUrl: p?.imageUrl ?? null,
        status: p?.status ?? null,
        stock: p?.stock ?? null,
        tracked: p?.tracked ?? true,
        inStock: p?.inStock ?? null,
        preorder: p?.preorder ?? false,
        missing: p?.missing ?? false,
        wished: t._count._all,
        recent: recentBy.get(t.productId) ?? 0,
        restockEmails: sentBy.get(t.productId) ?? 0,
        purchased: boughtBy.get(t.productId) ?? 0,
        lastRestock: p?.restockedAt?.toISOString() ?? null,
        refreshedAt: p?.refreshedAt?.toISOString() ?? null,
      };
    }),
  };
}

// Re-reads report products that are stale (or all of them with force)
export async function refreshReportProducts(shop, admin, { force = false, take = 250 } = {}) {
  const top = await db.wishlistItem.groupBy({ by: ["productId"], where: { shop }, orderBy: { _count: { productId: "desc" } }, take });
  const ids = top.map((t) => t.productId);
  if (!ids.length) return { refreshed: 0, restocked: [] };
  let stale = ids;
  if (!force) {
    const rows = await db.wishlistProduct.findMany({ where: { shop, productId: { in: ids } } });
    const fresh = new Set(rows.filter((r) => r.refreshedAt && Date.now() - r.refreshedAt.getTime() < PRODUCT_TTL_MS).map((r) => r.productId));
    stale = ids.filter((id) => !fresh.has(id));
  }
  return stale.length ? refreshProducts(shop, admin, stale) : { refreshed: 0, restocked: [] };
}


// ---------------------------------------------------------------------------
// Purchases of saved products (orders/create webhook)
// ---------------------------------------------------------------------------

const SAVED_WINDOW_DAYS = 180; // a save counts for orders within this many days
const EMAIL_WINDOW_DAYS = 14; // an order counts for an email sent within this many days

export async function recordWishlistOrder(shop, order) {
  const customerId = customerKey(order?.customer?.id);
  const orderId = order?.id ? `gid://shopify/Order/${order.id}` : null;
  if (!customerId || !orderId) return { recorded: 0 };
  const orderedAt = new Date(order.created_at ?? order.processed_at ?? Date.now());

  const byProduct = new Map();
  for (const li of order.line_items ?? []) {
    const pid = productGid(li.product_id);
    if (!pid) continue;
    const qty = Number(li.quantity) || 0;
    const cur = byProduct.get(pid) ?? { units: 0, revenue: 0 };
    byProduct.set(pid, { units: cur.units + qty, revenue: cur.revenue + qty * Number(li.price || 0) - Number(li.total_discount || 0) });
  }
  if (!byProduct.size) return { recorded: 0 };
  const pids = [...byProduct.keys()];

  // Saved before the order: still on the list, or added (and maybe removed) recently
  const since = new Date(orderedAt.getTime() - SAVED_WINDOW_DAYS * 86400000);
  const [items, adds] = await Promise.all([
    db.wishlistItem.findMany({ where: { shop, customerId, productId: { in: pids }, createdAt: { lte: orderedAt } } }),
    db.wishlistEvent.findMany({ where: { shop, customerId, productId: { in: pids }, kind: "add", at: { gte: since, lte: orderedAt } } }),
  ]);
  const savedAt = new Map();
  for (const r of [...items.map((i) => ({ p: i.productId, at: i.createdAt })), ...adds.map((e) => ({ p: e.productId, at: e.at }))]) {
    const cur = savedAt.get(r.p);
    if (!cur || r.at < cur) savedAt.set(r.p, r.at);
  }
  if (!savedAt.size) return { recorded: 0 };

  // Did a wishlist email lead to it?
  const cust = await db.wishlistCustomer.findUnique({ where: { shop_customerId: { shop, customerId } } });
  const emails = [...new Set([order.email, order.contact_email, order.customer?.email, cust?.email].filter(Boolean).map((e) => String(e).toLowerCase()))];
  const ref = (order.note_attributes ?? []).find((a) => a?.name === "_oh_ref")?.value ?? null;
  const subs = emails.length
    ? await db.notifySubscriber.findMany({ where: { shop, email: { in: emails }, productId: { in: [...savedAt.keys()] }, source: WISHLIST_SOURCE }, select: { id: true } })
    : [];
  const subIds = subs.map((x) => x.id);
  const emailSince = new Date(orderedAt.getTime() - EMAIL_WINDOW_DAYS * 86400000);

  const rows = [];
  for (const [productId, at] of savedAt) {
    let send = null;
    if (ref) {
      const s = await db.emailSend.findUnique({ where: { token: String(ref) } });
      if (s && s.shop === shop && s.productId === productId && (s.kind === RESTOCK_KIND || subIds.includes(s.subscriberId))) send = s;
    }
    if (!send && emails.length) {
      send = await db.emailSend.findFirst({
        where: {
          shop,
          productId,
          email: { in: emails },
          status: "sent",
          sentAt: { gte: emailSince, lte: orderedAt },
          OR: [{ kind: RESTOCK_KIND }, { subscriberId: { in: subIds.length ? subIds : [-1] } }],
        },
        orderBy: { sentAt: "desc" },
      });
    }
    const { units, revenue } = byProduct.get(productId);
    rows.push({
      shop,
      customerId,
      productId,
      orderId,
      orderName: order.name ?? null,
      units,
      revenue: Math.round(revenue * 100) / 100,
      currency: order.currency ?? null,
      savedAt: at,
      orderedAt,
      sendId: send?.id ?? null,
      viaEmail: Boolean(send),
    });
  }
  const r = await db.wishlistConversion.createMany({ data: rows, skipDuplicates: true });
  // Bought it: no more back-in-stock / pre-order emails about it from the wishlist
  await db.notifySubscriber.updateMany({
    where: { shop, customerId, productId: { in: [...savedAt.keys()] }, source: WISHLIST_SOURCE, purchasedAt: null },
    data: { purchasedAt: new Date() },
  });
  return { recorded: r.count };
}

// ---------------------------------------------------------------------------
// Numbers for the Wishlists page
// ---------------------------------------------------------------------------

const rate = (a, b) => (b ? a / b : null);

export async function wishlistMetrics(shop, { days = 30, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400000);
  const [events, conversions, sharing, wishSubs] = await Promise.all([
    db.wishlistEvent.findMany({ where: { shop, at: { gte: since } }, select: { kind: true, at: true, customerId: true } }),
    db.wishlistConversion.findMany({ where: { shop, orderedAt: { gte: since } } }),
    db.wishlistCustomer.aggregate({ where: { shop, shareToken: { not: null } }, _count: { _all: true }, _sum: { shareViews: true } }),
    db.notifySubscriber.findMany({ where: { shop, source: WISHLIST_SOURCE }, select: { id: true } }),
  ]);
  const adds = events.filter((e) => e.kind === "add");
  const removes = events.filter((e) => e.kind === "remove");

  // Wishlist emails sent in the period: back-in-stock, and countdown emails to wishlisters
  const subIds = wishSubs.map((x) => x.id);
  const sends = await db.emailSend.findMany({
    where: {
      shop,
      status: "sent",
      sentAt: { gte: since },
      kind: { not: "test" },
      OR: [{ kind: RESTOCK_KIND }, ...(subIds.length ? [{ subscriberId: { in: subIds } }] : [])],
    },
    select: { id: true, kind: true, openedAt: true, clickedAt: true },
  });
  const viaEmail = conversions.filter((c) => c.viaEmail);
  const convSends = viaEmail.length
    ? await db.emailSend.findMany({ where: { id: { in: viaEmail.map((c) => c.sendId).filter(Boolean) } }, select: { id: true, kind: true } })
    : [];
  const sendKind = new Map(convSends.map((x) => [x.id, x.kind]));
  const emailGroup = (label, list, conv) => ({
    label,
    sent: list.length,
    opened: list.filter((x) => x.openedAt).length,
    clicked: list.filter((x) => x.clickedAt).length,
    orders: new Set(conv.map((c) => c.orderId)).size,
    revenue: conv.reduce((t, c) => t + c.revenue, 0),
  });
  const restockSends = sends.filter((x) => x.kind === RESTOCK_KIND);
  const preSends = sends.filter((x) => x.kind !== RESTOCK_KIND);
  const restockConv = viaEmail.filter((c) => sendKind.get(c.sendId) === RESTOCK_KIND);
  const preConv = viaEmail.filter((c) => sendKind.get(c.sendId) !== RESTOCK_KIND);

  // Day by day (store time)
  const series = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const day = dayInStore(new Date(now.getTime() - i * 86400000));
    if (index.has(day)) continue;
    index.set(day, series.length);
    series.push({ day, saves: 0, removes: 0, purchases: 0 });
  }
  const bump = (at, key) => {
    const i = index.get(dayInStore(at));
    if (i !== undefined) series[i][key]++;
  };
  adds.forEach((e) => bump(e.at, "saves"));
  removes.forEach((e) => bump(e.at, "removes"));
  conversions.forEach((c) => bump(c.orderedAt, "purchases"));

  const revenue = conversions.reduce((t, c) => t + c.revenue, 0);
  const savedInPeriodBought = conversions.filter((c) => c.savedAt >= since).length;
  const currency = conversions.find((c) => c.currency)?.currency ?? null;
  return {
    days,
    saves: adds.length,
    removes: removes.length,
    savers: new Set(adds.map((e) => e.customerId)).size,
    purchases: conversions.length,
    orders: new Set(conversions.map((c) => c.orderId)).size,
    buyers: new Set(conversions.map((c) => c.customerId)).size,
    revenue,
    currency,
    // Of the products saved in this period, how many were bought (so far)
    saveToBuy: rate(savedInPeriodBought, adds.length),
    avgDaysToBuy: conversions.length
      ? conversions.reduce((t, c) => t + (c.orderedAt - c.savedAt) / 86400000, 0) / conversions.length
      : null,
    emails: {
      total: emailGroup("All wishlist emails", sends, viaEmail),
      restock: emailGroup("Back in stock", restockSends, restockConv),
      preorder: emailGroup("Pre-order", preSends, preConv),
    },
    sharing: { lists: sharing._count._all, views: sharing._sum.shareViews ?? 0 },
    series,
  };
}
