import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { KEY, NAMESPACE, TIERS, errorMessage, gql, setReleaseDate, syncTemplate, toDay } from "./preorders.server";
import { createCampaign, getSettings, kickMail, metricsFor, storeUrl } from "./preorder-notify.server";

// ---------------------------------------------------------------------------
// Pre-order countdowns
//
// Products added to the group get an opening time and (optionally) a closing
// time. The theme block shows a countdown before opening, a "Pre-Order"
// button while open, and "Pre-Orders Closed" afterwards.
//
// The app never changes stock. "Continue selling when out of stock" is only
// changed when a person changes it, with one exception: when pre-orders end
// it's turned off, so they can't still be bought elsewhere (the Shop app,
// cart links).
//
// A sales limit counts the units ordered since opening. What's left of it is
// kept on each variant (metafield oh_preorder.limit_left) with whether
// pre-orders are open (product metafield oh_preorder.on_sale), and the
// "Pre-order limits" checkout rule (a validation function) stops carts and
// checkouts from going past it. Raising the limit after selling out re-opens
// sales; once enough is added, the people who signed up are emailed.
//
// Times are entered and shown in store time (Pacific).
// ---------------------------------------------------------------------------

export const STORE_TZ = "America/Los_Angeles";
export const MF_NAMESPACE = "oh_preorder";
const TICK_MS = 15 * 1000;

// ---------------------------------------------------------------------------
// Store time <-> instants
// ---------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: STORE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

function storeParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const m = (p.timeZoneName ?? "GMT").match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return { ...p, offset };
}

// "2026-11-01T09:00" (Pacific) → Date, or null
export function fromStoreInput(value) {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Guess with the offset near that time, then correct it (daylight saving)
  const guess = wall - storeParts(new Date(wall)).offset * 60000;
  const at = new Date(wall - storeParts(new Date(guess)).offset * 60000);
  // A time skipped when clocks go forward doesn't exist; it lands an hour later
  return Number.isNaN(at.getTime()) ? null : at;
}

// Date → "2026-11-01T09:00" (Pacific), for datetime inputs
export function toStoreInput(date) {
  if (!date) return "";
  const p = storeParts(new Date(date));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

// scheduled: before opening · open: buying allowed · closed: after closing
export function phaseOf(w, now = Date.now()) {
  const t = typeof now === "number" ? now : now.getTime();
  if (w.closesAt && t >= new Date(w.closesAt).getTime()) return "closed";
  if (w.opensAt && t < new Date(w.opensAt).getTime()) return "scheduled";
  return "open";
}

const json = (s, fallback = {}) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
export const limitsOf = (w) => {
  const l = json(w.limits, null);
  return l && Object.keys(l).length ? l : null;
};

// Countdowns never change "Continue selling when out of stock" on their own.
// It only changes when someone sets it in the countdown's flyout or bulk edit.

// Closed and set to show the normal "Add to cart": the countdown is off the page
export const finished = (w, phase = phaseOf(w)) => phase === "closed" && Boolean(w.keepSelling);

// ---------------------------------------------------------------------------
// Shopify calls
// ---------------------------------------------------------------------------

const PRODUCT_QUERY = `#graphql
  query ($id: ID!, $after: String, $location: ID!, $withLevels: Boolean!) {
    product(id: $id) {
      id
      title
      handle
      featuredMedia {
        preview {
          image {
            thumb: url(transform: { maxWidth: 120 })
            large: url(transform: { maxWidth: 600 })
          }
        }
      }
      variants(first: 250, after: $after) {
        nodes {
          id
          title
          inventoryPolicy
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $location) @include(if: $withLevels) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

// locationId: also read each variant's available stock there
async function loadProduct(admin, productId, locationId = null) {
  let after = null;
  let product = null;
  const variants = [];
  do {
    const data = await gql(admin, PRODUCT_QUERY, {
      id: productId,
      after,
      location: locationId ?? "gid://shopify/Location/0",
      withLevels: Boolean(locationId),
    });
    if (!data?.product) throw new Error("This product couldn't be found in Shopify.");
    product = data.product;
    variants.push(
      ...product.variants.nodes.map((v) => {
        const level = v.inventoryItem?.inventoryLevel;
        return {
          id: v.id,
          title: v.title,
          inventoryPolicy: v.inventoryPolicy,
          inventoryItemId: v.inventoryItem?.id ?? null,
          tracked: Boolean(v.inventoryItem?.tracked),
          stocked: Boolean(level),
          available: level ? level.quantities.find((q) => q.name === "available")?.quantity ?? 0 : 0,
        };
      }),
    );
    after = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
  } while (after);
  const image = product.featuredMedia?.preview?.image;
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl: image?.thumb ?? null,
    largeImageUrl: image?.large ?? null,
    variants,
  };
}

const VARIANTS_UPDATE = `#graphql
  mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

async function setPolicies(admin, productId, changes) {
  for (let i = 0; i < changes.length; i += 100) {
    const data = await gql(admin, VARIANTS_UPDATE, { productId, variants: changes.slice(i, i + 100) });
    const errs = data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
}

const LOCATIONS_QUERY = `#graphql
  { locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`;

export async function listLocations(admin) {
  const data = await gql(admin, LOCATIONS_QUERY);
  return (data?.locations?.nodes ?? []).filter((l) => l.isActive);
}

// Where limited stock is kept: the chosen location, or the first one that
// fulfils online orders
export async function sellingLocation(shop, admin) {
  const s = await getSettings(shop);
  if (s.locationId) return s.locationId;
  const locations = await listLocations(admin);
  const pick = locations.find((l) => l.fulfillsOnlineOrders) ?? locations[0];
  if (!pick) throw new Error("No active location found to hold pre-order stock.");
  await db.preorderSettings.update({ where: { shop }, data: { locationId: pick.id } });
  return pick.id;
}

const METAFIELDS_SET = `#graphql
  mutation ($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

const METAFIELDS_DELETE = `#graphql
  mutation ($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

// The theme block reads these: product.metafields.oh_preorder.opens_at / closes_at / limited
async function writeMetafields(admin, productId, { opensAt, closesAt, limited = false, shipsOn = null }) {
  const set = [];
  const remove = [];
  // A later wave's own ship date, for the countdown block ("This wave ships …")
  if (shipsOn) set.push({ ownerId: productId, namespace: MF_NAMESPACE, key: "wave_ships_on", type: "date", value: shipsOn });
  else remove.push({ ownerId: productId, namespace: MF_NAMESPACE, key: "wave_ships_on" });
  for (const [key, at] of [
    ["opens_at", opensAt],
    ["closes_at", closesAt],
  ]) {
    if (at) set.push({ ownerId: productId, namespace: MF_NAMESPACE, key, type: "date_time", value: new Date(at).toISOString() });
    else remove.push({ ownerId: productId, namespace: MF_NAMESPACE, key });
  }
  if (limited) set.push({ ownerId: productId, namespace: MF_NAMESPACE, key: "limited", type: "boolean", value: "true" });
  else remove.push({ ownerId: productId, namespace: MF_NAMESPACE, key: "limited" });
  if (set.length) {
    const data = await gql(admin, METAFIELDS_SET, { metafields: set });
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
  if (remove.length) {
    const data = await gql(admin, METAFIELDS_DELETE, { metafields: remove });
    const errs = data?.metafieldsDelete?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
}

// ---------------------------------------------------------------------------
// Sales limits: counted from orders, enforced at checkout
// ---------------------------------------------------------------------------

// Units of each limited variant ordered in this run (since it first opened)
async function soldOf(w, since = w.firstOpenedAt) {
  if (!since) return {};
  const rows = await db.preorderLimitSale.findMany({ where: { shop: w.shop, windowId: w.id } });
  const out = {};
  for (const r of rows) if (new Date(r.orderedAt) >= new Date(since)) out[r.variantId] = (out[r.variantId] ?? 0) + Math.max(0, r.units);
  return out;
}

const leftOf = (limits, sold) => Object.fromEntries(Object.entries(limits).map(([vid, n]) => [vid, Math.max(0, Number(n) - Number(sold[vid] ?? 0))]));

async function setMetafields(admin, list) {
  for (let i = 0; i < list.length; i += 25) {
    const data = await gql(admin, METAFIELDS_SET, { metafields: list.slice(i, i + 25) });
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
}
async function deleteMetafields(admin, list) {
  for (let i = 0; i < list.length; i += 25) {
    const data = await gql(admin, METAFIELDS_DELETE, { metafields: list.slice(i, i + 25) });
    const errs = data?.metafieldsDelete?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
}

// What the checkout rule reads: units left per variant, and whether
// pre-orders are open. Taken off when there's no limit (or it's finished).
async function writeLimit(admin, w, { left, onSale, variantIds = [] }) {
  if (!left) {
    const ids = [...new Set([...variantIds, ...Object.keys(json(w.stock))])];
    await deleteMetafields(admin, [
      { ownerId: w.productId, namespace: MF_NAMESPACE, key: "on_sale" },
      ...ids.map((id) => ({ ownerId: id, namespace: MF_NAMESPACE, key: "limit_left" })),
    ]);
    return;
  }
  await setMetafields(admin, [
    { ownerId: w.productId, namespace: MF_NAMESPACE, key: "on_sale", type: "boolean", value: onSale ? "true" : "false" },
    ...Object.entries(left).map(([id, n]) => ({ ownerId: id, namespace: MF_NAMESPACE, key: "limit_left", type: "number_integer", value: String(n) })),
  ]);
}

// Units ordered of limited variants, from an order (new or changed). Cancelled
// orders and removed items free their units again.
export async function recordLimitSales(shop, order) {
  const orderId = order?.admin_graphql_api_id ?? (order?.id ? `gid://shopify/Order/${order.id}` : null);
  if (!orderId) return;
  const byVariant = new Map();
  for (const li of order.line_items ?? []) {
    if (!li?.variant_id || !li?.product_id) continue;
    const vid = `gid://shopify/ProductVariant/${li.variant_id}`;
    const qty = order.cancelled_at ? 0 : Number(li.current_quantity ?? li.quantity) || 0;
    const cur = byVariant.get(vid) ?? { productId: `gid://shopify/Product/${li.product_id}`, units: 0 };
    cur.units += qty;
    byVariant.set(vid, cur);
  }
  if (!byVariant.size) return;
  const productIds = [...new Set([...byVariant.values()].map((x) => x.productId))];
  const windows = (await db.preorderWindow.findMany({ where: { shop, productId: { in: productIds } } })).filter((w) => limitsOf(w));
  const touched = [];
  for (const w of windows) {
    const limits = limitsOf(w);
    let changed = false;
    for (const [vid, x] of byVariant) {
      if (x.productId !== w.productId || !(vid in limits)) continue;
      const where = { shop_orderId_variantId: { shop, orderId, variantId: vid } };
      const had = await db.preorderLimitSale.findUnique({ where });
      if (had && had.units === x.units) continue;
      if (!had && x.units === 0) continue;
      const orderedAt = new Date(order.created_at ?? Date.now());
      if (had) await db.preorderLimitSale.update({ where, data: { units: x.units } });
      else await db.preorderLimitSale.create({ data: { shop, windowId: w.id, productId: w.productId, variantId: vid, orderId, units: x.units, orderedAt } });
      changed = true;
    }
    if (changed) touched.push(w.id);
  }
  if (!touched.length) return;
  const { admin } = await unauthenticated.admin(shop);
  for (const id of touched) {
    const w = await db.preorderWindow.findUnique({ where: { id } });
    if (w) await refreshLimit(admin, w).catch((e) => console.error(`[preorder-windows] limit ${w.productId}:`, errorMessage(e)));
  }
}

const ORDERS_QUERY = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id createdAt cancelledAt lineItems(first: 100) { nodes { currentQuantity variant { id } } } }
    }
  }`;

// Orders placed before the app counted limits by order: found through the
// pre-order sales it already kept for the product, read from Shopify
async function backfillLimit(admin, w) {
  const limits = limitsOf(w);
  if (limits && w.firstOpenedAt) {
    const since = new Date(new Date(w.firstOpenedAt).getTime() - 24 * 3600 * 1000);
    const sales = await db.preorderSale.findMany({ where: { shop: w.shop, productId: w.productId } });
    const ids = [...new Set(sales.filter((x) => new Date(x.createdAt) >= since).map((x) => x.orderId))];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await gql(admin, ORDERS_QUERY, { ids: ids.slice(i, i + 50) });
      for (const o of data?.nodes ?? []) {
        if (!o?.id || new Date(o.createdAt) < new Date(w.firstOpenedAt)) continue;
        const units = {};
        for (const li of o.lineItems?.nodes ?? []) {
          const vid = li.variant?.id;
          if (vid && vid in limits) units[vid] = (units[vid] ?? 0) + (o.cancelledAt ? 0 : Number(li.currentQuantity) || 0);
        }
        for (const [vid, n] of Object.entries(units)) {
          const where = { shop_orderId_variantId: { shop: w.shop, orderId: o.id, variantId: vid } };
          if (await db.preorderLimitSale.findUnique({ where })) continue; // the order notification got there first
          await db.preorderLimitSale.create({ data: { shop: w.shop, windowId: w.id, productId: w.productId, variantId: vid, orderId: o.id, units: n, orderedAt: new Date(o.createdAt) } });
        }
      }
    }
  }
  return db.preorderWindow.update({ where: { id: w.id }, data: { limitCountedAt: new Date() } });
}

// Every limited product: count earlier orders once, then put what's left
// (and whether it's on sale) where the checkout rule reads it
export async function syncLimits(now = Date.now()) {
  const rows = await db.preorderWindow.findMany({ where: { limits: { not: null } } });
  for (let w of rows) {
    if (!limitsOf(w) || finished(w, phaseOf(w, now)) || busy.has(w.id)) continue;
    busy.add(w.id);
    try {
      const { admin } = await unauthenticated.admin(w.shop);
      if (!w.limitCountedAt) w = await backfillLimit(admin, w);
      await refreshLimit(admin, w, now);
    } catch (e) {
      console.error(`[preorder-windows] limit ${w.productId}:`, errorMessage(e));
    } finally {
      busy.delete(w.id);
    }
  }
}

// After sales or a new limit: what's left goes to Shopify; selling out and
// coming back (with the "re-opened" email) are noted
async function refreshLimit(admin, w, now = Date.now()) {
  const limits = limitsOf(w);
  const phase = phaseOf(w, now);
  if (!limits || finished(w, phase)) return;
  const left = leftOf(limits, await soldOf(w));
  const total = sum(left);
  const onSale = phase === "open" && w.appliedPhase === "open";
  await writeLimit(admin, w, { left, onSale });
  const data = { stock: JSON.stringify(left) };
  let reopened = false;
  if (onSale && total === 0 && !w.soldOutAt) {
    data.soldOutAt = new Date();
    data.restockedUnits = 0;
  } else if (onSale && total > 0 && w.soldOutAt) {
    const settings = await getSettings(w.shop);
    if (total > settings.restockThreshold) {
      data.soldOutAt = null;
      data.restockedUnits = 0;
      reopened = true;
    } else data.restockedUnits = total;
  }
  const saved = await db.preorderWindow.update({ where: { id: w.id }, data });
  if (reopened) {
    const product = await loadProduct(admin, w.productId);
    await sendCampaign(w.shop, admin, saved, product, "reopened", `reopened:${w.id}:${Date.now()}`);
  }
  return left;
}

// ---------------------------------------------------------------------------
// Applying a window to Shopify
// ---------------------------------------------------------------------------

const busy = new Set(); // windows being changed right now

async function productUrlFor(shop, admin, handle) {
  return `${(await storeUrl(shop, admin)).replace(/\/$/, "")}/products/${handle}`;
}

async function sendCampaign(shop, admin, w, product, kind, dedupeKey) {
  return createCampaign(shop, {
    window: w,
    kind,
    dedupeKey,
    product,
    productUrl: await productUrlFor(shop, admin, product.handle),
  });
}

// Makes Shopify match the window's phase:
//   - when pre-orders end, "Continue selling" is turned off (never on)
//   - with a limit: what's left and whether it's open, for the checkout rule
// Sends the "pre-orders are open" / "re-opened" emails on the way into open.
export async function enforce(admin, w, now = Date.now()) {
  const phase = phaseOf(w, now);
  const prev = w.appliedPhase;
  const limits = limitsOf(w);
  try {
    const product = await loadProduct(admin, w.productId);
    const data = {};
    let firstOpen = false;
    let reopened = false;

    // Pre-orders ended: stop "Continue selling when out of stock", so they
    // can't still be bought elsewhere (the Shop app, cart links). Only ever
    // turned off here, never on.
    if (phase === "closed" && prev !== "closed") {
      const changes = product.variants.filter((v) => v.inventoryPolicy === "CONTINUE").map((v) => ({ id: v.id, inventoryPolicy: "DENY" }));
      if (changes.length) {
        await setPolicies(admin, w.productId, changes);
        await db.preorderLog
          .create({ data: { shop: w.shop, productId: w.productId, title: product.title, action: "countdown", detail: "Pre-orders ended: Continue selling when out of stock turned off" } })
          .catch(() => null);
      }
    }

    if (phase === "open" && prev !== "open") {
      firstOpen = !w.firstOpenedAt;
      reopened = !firstOpen;
      data.firstOpenedAt = w.firstOpenedAt ?? new Date();
      data.closedAt = null;
      data.soldOutAt = null;
      data.restockedUnits = 0;
    }
    if (phase === "closed" && prev !== "closed") data.closedAt = new Date();

    // Set to show "Add to cart" after closing: the countdown comes off the page
    // instead of showing "Pre-Orders Closed"
    if (finished(w, phase)) await writeMetafields(admin, w.productId, { opensAt: null, closesAt: null, limited: false });

    // The limit for the checkout rule: what's left, and whether it's on sale
    if (limits && !finished(w, phase)) {
      const left = leftOf(limits, await soldOf(w, data.firstOpenedAt ?? w.firstOpenedAt));
      await writeLimit(admin, w, { left, onSale: phase === "open" });
      data.stock = JSON.stringify(left);
      if (phase === "open" && sum(left) === 0 && !w.soldOutAt && !firstOpen && !reopened) data.soldOutAt = new Date();
    } else if (json(w.stock) && Object.keys(json(w.stock)).length) {
      await writeLimit(admin, w, { left: null, variantIds: product.variants.map((v) => v.id) });
      data.stock = null;
    }

    const saved = await db.preorderWindow.update({
      where: { id: w.id },
      data: {
        ...data,
        ...(firstOpen && w.quietOpen ? { quietOpen: false } : {}),
        appliedPhase: phase,
        appliedAt: new Date(),
        lastError: null,
        title: product.title,
        handle: product.handle,
        imageUrl: product.imageUrl,
      },
    });

    // The page goes back to the normal product template once it's finished
    if (finished(w, phase) && prev !== "closed") {
      await syncTemplate(w.shop, admin, w.productId).catch((e) => console.error(`[preorder-windows] template ${w.productId}:`, errorMessage(e)));
    }

    // Emails (none for automatic countdowns on products already on pre-order)
    if (firstOpen && w.quietOpen) {
      // nothing to announce
    } else if (firstOpen) {
      await sendCampaign(w.shop, admin, saved, product, "opened", `opened:${w.id}:${saved.firstOpenedAt.toISOString()}`);
    } else if (reopened) {
      const settings = await getSettings(w.shop);
      const onSale = limits ? sum(json(data.stock)) : Infinity;
      if (onSale > settings.restockThreshold) {
        await sendCampaign(w.shop, admin, saved, product, "reopened", `reopened:${w.id}:${Date.now()}`);
      }
    }
    return { phase, changed: 0 };
  } catch (e) {
    await db.preorderWindow.update({ where: { id: w.id }, data: { lastError: errorMessage(e).slice(0, 500) } });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export class WindowError extends Error {}

const sum = (obj) => Object.values(obj ?? {}).reduce((n, x) => n + Math.max(0, Number(x) || 0), 0);

const view = (w, now = Date.now(), metrics = null) => {
  const limits = limitsOf(w);
  const phase = phaseOf(w, now);
  const stock = json(w.stock);
  return {
    id: w.id,
    productId: w.productId,
    title: w.title ?? "Unknown product",
    handle: w.handle,
    imageUrl: w.imageUrl,
    opensAt: w.opensAt?.toISOString() ?? null,
    closesAt: w.closesAt?.toISOString() ?? null,
    opensInput: toStoreInput(w.opensAt),
    closesInput: toStoreInput(w.closesAt),
    closesRule: w.closesRule ?? null,
    releaseDay: w.releaseDay ?? null,
    auto: Boolean(w.auto),
    keepSelling: Boolean(w.keepSelling),
    wave: w.waveId ? { id: w.waveId, number: w.waveNumber, shipDay: w.waveShipDay } : null,
    finished: finished(w, phase),
    addedBy: w.addedBy ?? null,
    phase,
    appliedPhase: w.appliedPhase,
    limited: Boolean(limits),
    limitTotal: limits ? sum(limits) : null,
    variantCount: limits ? Object.keys(limits).length : 0,
    // Units left in the limit (sold = limit − left)
    available: limits ? (Object.keys(stock).length ? sum(stock) : sum(limits)) : null,
    held: 0,
    soldOut: Boolean(limits && phase === "open" && w.appliedPhase === "open" && Object.keys(stock).length && sum(stock) === 0),
    restockedUnits: w.restockedUnits,
    firstOpenedAt: w.firstOpenedAt?.toISOString() ?? null,
    closedAt: w.closedAt?.toISOString() ?? null,
    lastError: w.lastError,
    updatedBy: w.updatedBy ?? w.addedBy,
    updatedAt: w.updatedAt.toISOString(),
    metrics,
  };
};

export async function listWindows(shop) {
  const rows = await db.preorderWindow.findMany({ where: { shop }, orderBy: [{ opensAt: "asc" }, { id: "asc" }] });
  const metrics = rows.length ? await metricsFor(shop, rows.map((w) => w.productId)) : {};
  const now = Date.now();
  const order = { scheduled: 0, open: 1, closed: 2 };
  return rows.map((w) => view(w, now, metrics[w.productId])).sort((a, b) => order[a.phase] - order[b.phase]);
}

// Adds a product to the group. Nothing changes in Shopify until times are set.
export async function addProduct(shop, admin, productId, user) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId ?? "")) throw new WindowError("Pick a product to add.");
  const existing = await db.preorderWindow.findUnique({ where: { shop_productId: { shop, productId } } });
  if (existing) return view(existing);
  const product = await loadProduct(admin, productId);
  const w = await db.preorderWindow.create({
    data: {
      shop,
      productId,
      title: product.title,
      handle: product.handle,
      imageUrl: product.imageUrl,
      // Remember how each variant was set, to put it back on removal
      originalPolicies: JSON.stringify(Object.fromEntries(product.variants.map((v) => [v.id, v.inventoryPolicy]))),
      addedBy: user?.name ?? null,
    },
  });
  return view(w);
}

// Variants with their current stock and limits, for the edit form
export async function windowVariants(shop, admin, id) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const product = await loadProduct(admin, w.productId);
  const limits = limitsOf(w) ?? {};
  const left = json(w.stock);
  return product.variants.map((v) => ({
    id: v.id,
    title: v.title === "Default Title" ? product.title : v.title,
    tracked: v.tracked,
    available: v.available,
    limit: limits[v.id] ?? null,
    left: limits[v.id] != null ? left[v.id] ?? limits[v.id] : null,
    continueSelling: v.inventoryPolicy === "CONTINUE",
  }));
}

// "Continue selling when out of stock" for every variant of a countdown's
// product. Only ever called when a person changes it.
export async function setContinueSelling(shop, admin, id, on, user) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const product = await loadProduct(admin, w.productId);
  const want = on ? "CONTINUE" : "DENY";
  const changes = product.variants.filter((v) => v.inventoryPolicy !== want).map((v) => ({ id: v.id, inventoryPolicy: want }));
  if (!changes.length) return 0;
  await setPolicies(admin, w.productId, changes);
  await db.preorderLog
    .create({
      data: {
        shop,
        productId: w.productId,
        title: w.title,
        action: "countdown",
        detail: `Continue selling when out of stock turned ${on ? "on" : "off"}${user?.name ? ` by ${user.name}` : ""}`,
      },
    })
    .catch(() => null);
  return changes.length;
}

const parseLimits = (input) => {
  if (!input) return null;
  const out = {};
  for (const [id, n] of Object.entries(input)) {
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)) continue;
    const x = Math.round(Number(n));
    if (!Number.isFinite(x) || x < 0) throw new WindowError("Limits must be whole numbers of 0 or more.");
    out[id] = x;
  }
  return Object.keys(out).length ? out : null;
};

// Sets times and the optional sales limit.
// opens/closes: Pacific "YYYY-MM-DDTHH:mm" (blank = none); limits: {variantId: n} or null
// closesRule: "release" closes at the end of the product's release date (read
// from Shopify now), "manual" uses `closes`, undefined leaves the rule as it is
// keepSelling: true/false to change it, undefined leaves it as it is
// wave: undefined leaves it as it is; { shipDay: "YYYY-MM-DD", fresh } makes this a
// later wave of pre-orders with its own ship date (the release date isn't
// touched), fresh starting another one; false ends being a wave
export async function saveWindow(shop, admin, id, { opens, closes, limits, closesRule, keepSelling, wave }, user) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const keep = keepSelling === undefined ? Boolean(w.keepSelling) : Boolean(keepSelling);
  const asWave = wave === undefined ? (w.waveId ? { shipDay: w.waveShipDay } : null) : wave || null;
  if (asWave) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asWave.shipDay ?? "")) throw new WindowError("Enter the date this wave ships.");
    // A wave closes at its own time; the release date belongs to the first run
    if (closesRule === "release" || (!closesRule && followsRelease(w, await getSettings(shop)))) closesRule = "manual";
  }
  let releaseDay = w.releaseDay;
  if (closesRule === "release") {
    releaseDay = (await releaseDays(admin, [w.productId]))[w.productId] ?? null;
    if (!releaseDay) throw new WindowError("This product has no release date in Shopify yet, so it can't close on it. Set one, or pick a closing time.");
    closes = toStoreInput(releaseCloseAt(releaseDay));
  }
  const opensAt = opens ? fromStoreInput(opens) : null;
  const closesAt = closes ? fromStoreInput(closes) : null;
  if (opens && !opensAt) throw new WindowError("The opening time isn't a valid date and time.");
  if (closes && !closesAt) throw new WindowError("The closing time isn't a valid date and time.");
  if (opensAt && closesAt && closesAt <= opensAt) throw new WindowError("Pre-orders must close after they open.");
  if (!opensAt && !closesAt) throw new WindowError("Set an opening time, a closing time, or both.");
  const newLimits = parseLimits(limits);

  if (busy.has(w.id)) throw new WindowError("This product is being updated. Try again in a moment.");
  busy.add(w.id);
  try {
    const waveData = await placeWave(shop, w, asWave, { opensAt, closesAt }, user);
    await writeMetafields(admin, w.productId, { opensAt, closesAt, limited: Boolean(newLimits), shipsOn: asWave?.shipDay ?? null });
    const saved = await db.preorderWindow.update({
      where: { id: w.id },
      data: {
        ...waveData,
        opensAt,
        closesAt,
        limits: newLimits ? JSON.stringify(newLimits) : null,
        // Orders are counted from here on; ones from before are counted once at start-up
        ...(newLimits && !w.limitCountedAt && !w.firstOpenedAt ? { limitCountedAt: new Date() } : {}),
        updatedBy: user?.name ?? null,
        ...(closesRule === "release" || closesRule === "manual" ? { closesRule } : {}),
        releaseDay,
        keepSelling: keep,
      },
    });
    await enforce(admin, saved);
    // A new limit: count orders already placed in this run, then what's left
    // changes now (and may re-open)
    if (newLimits) {
      let cur = await db.preorderWindow.findUnique({ where: { id: w.id } });
      if (!cur.limitCountedAt) cur = await backfillLimit(admin, cur);
      await refreshLimit(admin, cur);
    }
  } finally {
    busy.delete(w.id);
  }
  // The countdown blocks live on the "preorder" product template
  await syncTemplate(shop, admin, w.productId).catch((e) => console.error(`[preorder-windows] template ${w.productId}:`, errorMessage(e)));
  return view(await db.preorderWindow.findUnique({ where: { id: w.id } }));
}

// ---------------------------------------------------------------------------
// Waves: more pre-orders for a product that's already out
// ---------------------------------------------------------------------------

// Window fields for the wave (and the wave's own row). A new wave starts when
// the product isn't in a wave yet or one is asked for (fresh, the History
// tab's "New wave"); otherwise the current wave's times and ship date change
// (re-opening a wave keeps it the same wave).
async function placeWave(shop, w, asWave, { opensAt, closesAt }, user) {
  const now = new Date();
  const current = w.waveId ? await db.preorderWave.findFirst({ where: { shop, id: w.waveId } }) : null;
  if (!asWave) {
    if (!current) return {};
    // Not a wave after all: forget it if it never opened
    if (new Date(current.opensAt) > now) await db.preorderWave.delete({ where: { id: current.id } });
    return { waveId: null, waveNumber: null, waveShipDay: null };
  }
  const opened = opensAt ?? now;
  const startNew = !current || Boolean(asWave.fresh);
  if (!startNew) {
    await db.preorderWave.update({ where: { id: current.id }, data: { opensAt: opened, closesAt, shipDay: asWave.shipDay } });
    return { waveShipDay: asWave.shipDay };
  }
  // The run before it ends now at the latest, so orders after this belong to the new wave
  if (current && (!current.closesAt || new Date(current.closesAt) > now)) {
    await db.preorderWave.update({ where: { id: current.id }, data: { closesAt: now } });
  }
  const last = await db.preorderWave.findFirst({ where: { shop, productId: w.productId }, orderBy: { number: "desc" } });
  // The first run (on the release date) is wave 1
  const number = Math.max(2, (last?.number ?? 1) + 1);
  const row = await db.preorderWave.create({
    data: { shop, productId: w.productId, windowId: w.id, number, opensAt: opened, closesAt, shipDay: asWave.shipDay, createdBy: user?.name ?? null },
  });
  // A fresh run: opening emails "pre-orders are open" again, and a limit starts from scratch
  return { waveId: row.id, waveNumber: number, waveShipDay: asWave.shipDay, firstOpenedAt: null, closedAt: null, soldOutAt: null, restockedUnits: 0, quietOpen: false };
}

// Every wave of these products: productId → [{ number, opensAt, closesAt, shipDay }]
export async function wavesFor(shop, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return {};
  const rows = await db.preorderWave.findMany({ where: { shop, productId: { in: ids } }, orderBy: { opensAt: "asc" } });
  const out = {};
  for (const r of rows) (out[r.productId] ??= []).push({ number: r.number, opensAt: r.opensAt.toISOString(), closesAt: r.closesAt?.toISOString() ?? null, shipDay: r.shipDay });
  return out;
}

// ---------------------------------------------------------------------------
// Closing on the release date
// ---------------------------------------------------------------------------

const RELEASE_QUERY = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value } }
    }
  }`;

// productId → "YYYY-MM-DD" (or null) from Shopify
async function releaseDays(admin, productIds) {
  const out = {};
  for (let i = 0; i < productIds.length; i += 100) {
    const data = await gql(admin, RELEASE_QUERY, { ids: productIds.slice(i, i + 100) });
    for (const n of data?.nodes ?? []) if (n?.id) out[n.id] = toDay(n.metafield?.value) ?? null;
  }
  return out;
}

// End of the release day, store time
export const releaseCloseAt = (day) => fromStoreInput(`${day}T23:59`);

// Follows the release date: its own rule, or the shop's setting
export const followsRelease = (w, settings) => w.closesRule === "release" || (!w.closesRule && Boolean(settings?.closeOnRelease));

// Moves the closing time of every product that follows its release date to the
// end of that date, when it has changed. Leaves alone: products not set up yet,
// ones already closed (re-opening is a decision for the History tab), and
// release dates already past.
export async function syncReleaseCloses(shop, admin, { ids = null, user = null } = {}) {
  const settings = await getSettings(shop);
  const rows = await db.preorderWindow.findMany({ where: { shop, ...(ids ? { id: { in: ids } } : {}) } });
  if (!rows.length) return { changed: [], problems: [] };
  const days = await releaseDays(admin, rows.map((w) => w.productId));
  const changed = [];
  const problems = [];
  for (const w of rows) {
    const day = days[w.productId] ?? null;
    if (day !== (w.releaseDay ?? null)) await db.preorderWindow.update({ where: { id: w.id }, data: { releaseDay: day } });
    if (w.waveId) continue; // a later wave closes at its own time
    if (!followsRelease(w, settings) || !day) continue;
    if (!w.opensAt && !w.closesAt) continue; // not set up: saving it would open pre-orders now
    if (phaseOf(w) === "closed") continue;
    const closesAt = releaseCloseAt(day);
    if (!closesAt || closesAt <= new Date()) continue;
    if (w.closesAt && closesAt.getTime() === new Date(w.closesAt).getTime()) continue;
    if (w.opensAt && closesAt <= new Date(w.opensAt)) {
      problems.push(`${w.title}: its release date (${day}) is before pre-orders open`);
      continue;
    }
    if (busy.has(w.id)) continue; // next run
    try {
      await saveWindow(shop, admin, w.id, { opens: toStoreInput(w.opensAt), closes: toStoreInput(closesAt), limits: limitsOf(w) }, user ?? { name: "Release date" });
      changed.push({ id: w.id, title: w.title, closes: closesAt.toISOString() });
    } catch (e) {
      problems.push(`${w.title}: ${e.message}`);
    }
  }
  return { changed, problems };
}

// ---------------------------------------------------------------------------
// Bulk edit: the same times, closing rule and/or release date for several products
// opens: "" = keep; closesMode: keep | release | date | none; release: "YYYY-MM-DD" or ""
// ---------------------------------------------------------------------------
export async function bulkEdit(shop, admin, ids, { opens = "", closesMode = "keep", closes = "", release = "", selling = "keep" }, user) {
  const rows = await db.preorderWindow.findMany({ where: { shop, id: { in: ids } } });
  if (!rows.length) throw new WindowError("Pick at least one product.");
  if (opens && !fromStoreInput(opens)) throw new WindowError("The opening time isn't a valid date and time.");
  if (closesMode === "date" && !fromStoreInput(closes)) throw new WindowError("The closing time isn't a valid date and time.");
  if (release && !/^\d{4}-\d{2}-\d{2}$/.test(release)) throw new WindowError("Enter the release date as a date.");
  if (!opens && closesMode === "keep" && !release && selling === "keep") {
    throw new WindowError("Nothing to change: set an opening time, a closing choice, a release date or continue selling.");
  }
  const results = [];
  for (const w of rows) {
    const done = [];
    try {
      if (release) {
        await setReleaseDate(admin, shop, w.productId, release, "Countdown bulk edit");
        done.push(`release date ${release}`);
      }
      if (opens || closesMode !== "keep") {
        const times = {
          opens: opens || toStoreInput(w.opensAt),
          closes: closesMode === "date" ? closes : closesMode === "none" ? "" : toStoreInput(w.closesAt),
          limits: limitsOf(w),
          closesRule: closesMode === "release" ? "release" : closesMode === "date" || closesMode === "none" ? "manual" : undefined,
        };
        await saveWindow(shop, admin, w.id, times, user);
        if (opens) done.push("opening time");
        if (closesMode !== "keep") done.push(closesMode === "release" ? "closes on its release date" : closesMode === "none" ? "no closing time" : "closing time");
      } else if (release) {
        // A new release date moves the closing time of products that follow it
        await syncReleaseCloses(shop, admin, { ids: [w.id], user });
      }
      if (selling === "on" || selling === "off") {
        await setContinueSelling(shop, admin, w.id, selling === "on", user);
        done.push(`continue selling ${selling}`);
      }
      results.push({ id: w.id, title: w.title, ok: true, done });
    } catch (e) {
      results.push({ id: w.id, title: w.title, ok: false, done, error: e?.message ?? String(e) });
    }
  }
  return results;
}

// Kept for older callers
export const saveTimes = (shop, admin, id, times, user) =>
  db.preorderWindow
    .findFirst({ where: { shop, id } })
    .then((w) => saveWindow(shop, admin, id, { ...times, limits: w ? limitsOf(w) : null }, user));

// History tab: open a closed product again, with a new closing time (or none).
// addUnits: with a sales limit, raises each variant's limit by this many.
export async function reopenWindow(shop, admin, id, { closes, addUnits = 0 }, user) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const closesAt = closes ? fromStoreInput(closes) : null;
  if (closes && !closesAt) throw new WindowError("The closing time isn't a valid date and time.");
  if (closesAt && closesAt <= new Date()) throw new WindowError("The new closing time has to be in the future.");
  const extra = Math.round(Number(addUnits) || 0);
  if (extra < 0) throw new WindowError("Units to add can't be negative.");
  const limits = limitsOf(w);
  if (extra && limits) {
    // A bigger limit: that many more can be pre-ordered (stock isn't touched)
    const bigger = {};
    for (const vid of Object.keys(limits)) bigger[vid] = Number(limits[vid] ?? 0) + extra;
    await db.preorderWindow.update({ where: { id: w.id }, data: { limits: JSON.stringify(bigger) } });
    w.limits = JSON.stringify(bigger);
  }
  return saveWindow(
    shop,
    admin,
    id,
    { opens: toStoreInput(w.opensAt ?? new Date()), closes: closes || "", limits: limitsOf(w) },
    user,
  );
}

// Takes a product out of the group: countdown off, selling setting put back.
// Automatic countdowns won't add it again (it can be allowed again from the
// Automatic tab).
export async function removeProduct(shop, admin, id, user = null) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) return;
  await db.preorderAutoSkip
    .upsert({
      where: { shop_productId: { shop, productId: w.productId } },
      create: { shop, productId: w.productId, title: w.title, reason: "removed", by: user?.name ?? null },
      update: {},
    })
    .catch((e) => console.error(`[preorder-windows] skip ${w.productId}:`, errorMessage(e)));
  await writeMetafields(admin, w.productId, { opensAt: null, closesAt: null, limited: false });
  // The checkout rule lets it go; stock and "Continue selling" are left as they are
  const product = await loadProduct(admin, w.productId).catch(() => null);
  await writeLimit(admin, w, { left: null, variantIds: [...(product?.variants ?? []).map((v) => v.id), ...Object.keys(limitsOf(w) ?? {})] }).catch((e) =>
    console.error(`[preorder-windows] limit ${w.productId}:`, errorMessage(e)),
  );
  await db.preorderWindow.delete({ where: { id: w.id } });
  // Back to the default template, unless its release date is still to come
  await syncTemplate(shop, admin, w.productId).catch((e) => console.error(`[preorder-windows] template ${w.productId}:`, errorMessage(e)));
}

// ---------------------------------------------------------------------------
// Stock changes (from Shopify's inventory notifications)
// ---------------------------------------------------------------------------

async function variantFor(shop, inventoryItemId) {
  const info = await db.inventoryItemInfo.findUnique({ where: { shop_inventoryItemId: { shop, inventoryItemId } } });
  if (info?.productId && info?.variantId) return { productId: info.productId, variantId: info.variantId };
  const { admin } = await unauthenticated.admin(shop);
  const data = await gql(
    admin,
    `#graphql
    query ($id: ID!) { inventoryItem(id: $id) { variant { id product { id } } } }`,
    { id: inventoryItemId },
  );
  const v = data?.inventoryItem?.variant;
  return v ? { productId: v.product.id, variantId: v.id } : null;
}

// Stock earlier versions changed for sales limits (they set stock to the
// limit at opening and held it back at closing), from the inventory history
// the app keeps, plus anything still held back. For fixing stock by hand.
export async function limitStockReport(shop) {
  const [rows, windows] = await Promise.all([
    db.inventoryAdjustment.findMany({ where: { shop, referenceUri: { startsWith: "gid://order-history/PreorderWindow/" } } }),
    db.preorderWindow.findMany({ where: { shop } }),
  ]);
  const byWindow = new Map(windows.map((w) => [w.id, w]));
  const byProduct = new Map(windows.map((w) => [w.productId, w]));
  const out = new Map();
  const entry = (productId, variantId, sku) => {
    const k = `${productId}|${variantId}`;
    if (!out.has(k)) {
      const w = byProduct.get(productId);
      out.set(k, { productId, variantId, sku: sku ?? null, title: w?.title ?? null, handle: w?.handle ?? null, added: 0, removed: 0, held: 0, last: null });
    }
    return out.get(k);
  };
  for (const r of rows) {
    if (r.state && r.state !== "available") continue;
    const w = byWindow.get(Number(String(r.referenceUri).split("/").pop()));
    const productId = r.productId ?? w?.productId ?? null;
    if (!productId || !r.variantId) continue;
    const e = entry(productId, r.variantId, r.sku);
    if (r.change > 0) e.added += r.change;
    else e.removed += -r.change;
    if (!e.last || r.occurredAt > e.last) e.last = r.occurredAt;
  }
  for (const w of windows) {
    for (const [vid, n] of Object.entries(json(w.held))) if (Number(n) > 0) entry(w.productId, vid, null).held += Number(n);
  }
  return [...out.values()]
    .map((e) => ({ ...e, net: e.added - e.removed, last: e.last ? new Date(e.last).toISOString() : null }))
    .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "") || a.variantId.localeCompare(b.variantId));
}

// Stock changes don't affect countdowns any more: a sales limit counts orders
// (recordLimitSales). Kept so the inventory webhook can still call it.
export async function stockChanged() {}

// ---------------------------------------------------------------------------
// Finding products to add
// ---------------------------------------------------------------------------

const SEARCH_QUERY = `#graphql
  query ($query: String!) {
    products(first: 25, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        status
        tags
        featuredMedia { preview { image { url(transform: { maxWidth: 80 }) } } }
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
      }
    }
  }`;

const GT_QUERY = TIERS.map((t) => `tag:${t.tag}`).join(" OR ");

// Words → product search. Empty search lists current pre-orders (GT tags).
export async function searchProducts(shop, admin, text) {
  const words = String(text ?? "")
    .trim()
    .replace(/["\\():]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const query = words.length ? words.map((w) => `(title:*${w}* OR sku:${w}*)`).join(" AND ") : `(${GT_QUERY})`;
  const [data, inGroup] = await Promise.all([
    gql(admin, SEARCH_QUERY, { query: `${query} AND -status:archived` }),
    db.preorderWindow.findMany({ where: { shop }, select: { productId: true } }),
  ]);
  const added = new Set(inGroup.map((w) => w.productId));
  const today = new Date().toISOString().slice(0, 10);
  return (data?.products?.nodes ?? []).map((p) => {
    const release = toDay(p.metafield?.value);
    return {
      productId: p.id,
      title: p.title,
      status: p.status,
      imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
      release,
      preorder: Boolean(release && release > today) || p.tags.some((t) => TIERS.some((x) => x.tag.toLowerCase() === t.toLowerCase())),
      inGroup: added.has(p.id),
    };
  });
}

// ---------------------------------------------------------------------------
// Keeping Shopify in step: checks every 15 seconds for products whose phase
// has changed (opened or closed) since the app last applied it, and sends the
// "closing soon" reminder.
// ---------------------------------------------------------------------------

const lastReleaseSync = new Map(); // shop → time of the last release-date check
const RELEASE_SYNC_MS = 60 * 60 * 1000;

export async function checkWindows(now = Date.now()) {
  const rows = await db.preorderWindow.findMany({
    where: { OR: [{ opensAt: { not: null } }, { closesAt: { not: null } }] },
  });
  // Release dates change in Shopify: hourly, move closing times that follow them
  for (const shop of new Set(rows.map((w) => w.shop))) {
    if (now - (lastReleaseSync.get(shop) ?? 0) < RELEASE_SYNC_MS) continue;
    lastReleaseSync.set(shop, now);
    try {
      const { admin } = await unauthenticated.admin(shop);
      await syncReleaseCloses(shop, admin);
    } catch (e) {
      console.error(`[preorder-windows] release dates ${shop}:`, errorMessage(e));
    }
  }
  for (const w of rows) {
    if (busy.has(w.id)) continue;
    const phase = phaseOf(w, now);
    if (phase !== w.appliedPhase) {
      busy.add(w.id);
      try {
        const { admin } = await unauthenticated.admin(w.shop);
        await enforce(admin, w, now);
      } catch (e) {
        console.error(`[preorder-windows] ${w.productId}:`, errorMessage(e));
      } finally {
        busy.delete(w.id);
      }
      continue;
    }
    if (phase === "open" && w.closesAt) await maybeRemind(w, now);
  }
}

async function maybeRemind(w, now) {
  const settings = await getSettings(w.shop);
  if (!settings.reminderHours) return;
  const closes = new Date(w.closesAt).getTime();
  if (now < closes - settings.reminderHours * 3600 * 1000 || now >= closes) return;
  // No point reminding people about something that's sold out
  if (limitsOf(w) && w.soldOutAt) return;
  const key = `closing:${w.id}:${new Date(w.closesAt).toISOString()}`;
  if (await db.emailCampaign.findUnique({ where: { dedupeKey: key } })) return;
  try {
    const { admin } = await unauthenticated.admin(w.shop);
    const product = await loadProduct(admin, w.productId);
    await sendCampaign(w.shop, admin, w, product, "closing", key);
  } catch (e) {
    console.error(`[preorder-windows] reminder ${w.productId}:`, errorMessage(e));
  }
}

// Someone may change "Continue selling" by hand; put it back if it matters
// Product saved in Shopify: nothing to put back. Countdowns don't override
// "Continue selling when out of stock" (kept so the webhook can still call it).
export async function recheckProduct() {}

if (!globalThis.__preorderWindowTimer && process.env.NODE_ENV !== "test") {
  const tick = () => checkWindows().catch((e) => console.error("[preorder-windows] check:", errorMessage(e)));
  globalThis.__preorderWindowTimer = setInterval(tick, TICK_MS);
  setTimeout(tick, 20 * 1000);
  // Sales limits are checked at checkout from what's written here
  setTimeout(() => syncLimits().catch((e) => console.error("[preorder-windows] limits:", errorMessage(e))), 40 * 1000);
  kickMail();
}
