import { createHash } from "node:crypto";
import db from "./db.server";
import { methodRulesOf } from "./components/shipping/methods";
import { unauthenticated } from "./shopify.server";
import { dayInStore, errorMessage, gql, toDay } from "./preorders.server";

// ---------------------------------------------------------------------------
// Shipping hub: shipments, readiness and holds
//
// A shipment is one Shopify fulfillment order. Shopify splits each order into
// fulfillment orders by shipping profile (the GT groups), so each one ships
// on its own and goes into its own batch.
//
// Ready = paid, not held by anyone else, nothing still on pre-order, and every
// item physically in stock. Pre-order = the product has a GT tag or a release
// date after today; those always wait, whatever the stock count says (stock
// on pre-order products is often just the number of pre-orders on offer).
// Stock goes to the oldest orders first: if 250 copies arrive for 300 orders,
// the 250 oldest are ready and the rest keep waiting.
//
// Holds: depending on the setting, the app places its own Shopify hold on
// shipments that aren't ready (or on everything not yet at the Ship step), so
// labels can't be bought for them. It only ever releases its own holds.
// ---------------------------------------------------------------------------

export const HOLD_HANDLE = "oh-shipping";

// ---------------------------------------------------------------------------
// Sandbox: a practice copy of the hub under "<shop>::sandbox". Reads from
// Shopify go through; anything that would change Shopify is skipped and
// listed instead, so the whole flow can be tried safely.
// ---------------------------------------------------------------------------

export const SANDBOX_SUFFIX = "::sandbox";
export const isSandboxShop = (shop) => String(shop).endsWith(SANDBOX_SUFFIX);

const describeSkipped = (op, v = {}) => {
  const order = (id) => (id ? `order ${String(id).split("/").pop()}` : "an order");
  if (op === "tagsAdd") return `Add tag ${(v.tags ?? []).join(", ")} to ${order(v.id)}`;
  if (op === "tagsRemove") return `Remove tag ${(v.tags ?? []).join(", ")} from ${order(v.id)}`;
  if (op === "fulfillmentOrderHold") return `Hold fulfillment order ${String(v.id).split("/").pop()}`;
  if (op === "fulfillmentOrderReleaseHold") return `Release hold on fulfillment order ${String(v.id).split("/").pop()}`;
  return `${op}: ${JSON.stringify(v).slice(0, 200)}`;
};

// Wraps Shopify's admin client: queries go through, mutations are recorded and skipped
export function sandboxAdmin(realAdmin, shop) {
  return {
    sandbox: true,
    graphql: async (query, opts = {}) => {
      const body = String(query).replace(/^\s*#graphql\s*/, "").trim();
      if (body.startsWith("mutation")) {
        const op = /mutation[^{]*\{\s*(\w+)/.exec(body)?.[1] ?? "change";
        await logEvent(shop, { type: "sandbox_skipped", detail: describeSkipped(op, opts.variables) });
        return { json: async () => ({ data: {} }) };
      }
      if (!realAdmin) throw new Error("Not available in sandbox mode.");
      return realAdmin.graphql(query, opts);
    },
  };
}
export const ACTIVE_STATES = ["waiting", "ready", "batched", "packed", "labeling"];
const MAX_HOLD_CHANGES_PER_RUN = 60;
const PAID = new Set(["PAID", "PARTIALLY_REFUNDED", "AUTHORIZED", "PARTIALLY_PAID"]);

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
export const linesOf = (s) => json(s.lines, []);

// ---------------------------------------------------------------------------
// Settings and audit trail
// ---------------------------------------------------------------------------

export async function getShippingSettings(shop) {
  return db.shippingSettings.upsert({ where: { shop }, create: { shop }, update: {} });
}

export async function logEvent(shop, { shipmentId = null, batchId = null, orderName = null, type, detail = null, user = null }) {
  await db.shippingEvent.create({ data: { shop, shipmentId, batchId, orderName, type, detail, userName: user?.name ?? null } });
}

// ---------------------------------------------------------------------------
// Reading fulfillment orders from Shopify
// ---------------------------------------------------------------------------

const FO_FIELDS = `
  id
  status
  createdAt
  deliveryMethod { methodType presentedName }
  assignedLocation { name location { id } }
  destination { countryCode province }
  fulfillmentHolds { id handle heldByRequestingApp displayReason }
  order {
    id
    name
    createdAt
    cancelledAt
    updatedAt
    displayFinancialStatus
    customer { displayName }
    fulfillmentOrders(first: 6) { nodes { id createdAt deliveryMethod { methodType } } }
  }
  lineItems(first: 25) {
    nodes {
      id
      remainingQuantity
      requiresShipping
      inventoryItemId
      sku
      productTitle
      variantTitle
      shippingLine { title }
      image { url(transform: { maxWidth: 80 }) }
      lineItem { id }
      variant { id barcode product { id } inventoryItem { id tracked } }
    }
  }
`;

const FO_PAGE = `#graphql
  query ($after: String) {
    fulfillmentOrders(first: 20, after: $after, includeClosed: false, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { ${FO_FIELDS} }
    }
  }`;

const ORDER_FOS = `#graphql
  query ($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 10) { nodes { ${FO_FIELDS} } }
    }
  }`;

const ONE_FO = `#graphql
  query ($id: ID!) {
    fulfillmentOrder(id: $id) { id status fulfillments(first: 1) { nodes { id } } }
  }`;

// GT tags mark pre-orders: "GT30Days", "GT 30 Days", "GT30" and so on
export const isGtTag = (tag) => /^gt\s*\d+/i.test(String(tag).trim());

// Turns a fulfillment order into shipment fields. null = not something we ship
// (pickup, digital, nothing left to send).
function toShipment(fo) {
  if (fo.deliveryMethod?.methodType && fo.deliveryMethod.methodType !== "SHIPPING") return null;
  const lines = fo.lineItems.nodes
    .filter((li) => li.remainingQuantity > 0 && li.requiresShipping)
    .map((li) => ({
      foLineItemId: li.id,
      lineItemId: li.lineItem?.id ?? null,
      variantId: li.variant?.id ?? null,
      productId: li.variant?.product?.id ?? null,
      inventoryItemId: li.variant?.inventoryItem?.id ?? li.inventoryItemId ?? null,
      tracked: li.variant?.inventoryItem?.tracked ?? false,
      sku: li.sku ?? null,
      barcode: li.variant?.barcode ?? null,
      title: li.productTitle,
      variantTitle: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : null,
      quantity: li.remainingQuantity,
      imageUrl: li.image?.url ?? null,
    }));
  if (!lines.length) return null;

  // "Part 2 of 3": position among the order's shipping fulfillment orders
  const siblings = (fo.order.fulfillmentOrders?.nodes ?? [])
    .filter((x) => !x.deliveryMethod?.methodType || x.deliveryMethod.methodType === "SHIPPING")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const index = siblings.findIndex((x) => x.id === fo.id);

  const holds = fo.fulfillmentHolds ?? [];
  const ours = holds.find((h) => h.heldByRequestingApp && h.handle === HOLD_HANDLE);
  const others = holds.filter((h) => !h.heldByRequestingApp);
  const method = fo.lineItems.nodes.find((li) => li.shippingLine?.title)?.shippingLine?.title ?? fo.deliveryMethod?.presentedName ?? null;

  return {
    fulfillmentOrderId: fo.id,
    orderId: fo.order.id,
    orderName: fo.order.name,
    orderCreatedAt: new Date(fo.order.createdAt),
    customerName: fo.order.customer?.displayName ?? null,
    shippingMethod: method,
    country: fo.destination?.countryCode ?? null,
    province: fo.destination?.province ?? null,
    locationId: fo.assignedLocation?.location?.id ?? null,
    locationName: fo.assignedLocation?.name ?? null,
    foStatus: fo.status,
    financialStatus: fo.order.displayFinancialStatus ?? null,
    lines: JSON.stringify(lines),
    units: lines.reduce((n, l) => n + l.quantity, 0),
    partIndex: index >= 0 ? index + 1 : 1,
    partCount: Math.max(1, siblings.length),
    otherHold: others.length ? others.map((h) => h.displayReason).join("; ") : null,
    appHoldId: ours?.id ?? null,
    cancelled: Boolean(fo.order.cancelledAt),
    orderUpdatedAt: fo.order.updatedAt ? new Date(fo.order.updatedAt) : null,
  };
}

async function upsertShipment(shop, data) {
  const { cancelled, ...fields } = data;
  const existing = await db.shipment.findUnique({
    where: { shop_fulfillmentOrderId: { shop, fulfillmentOrderId: fields.fulfillmentOrderId } },
  });
  if (cancelled) {
    if (existing && ACTIVE_STATES.includes(existing.state)) {
      await db.shipment.update({ where: { id: existing.id }, data: { state: "closed", closedAt: new Date(), waitingReason: "Order cancelled" } });
    }
    return;
  }
  if (!existing) {
    await db.shipment.create({ data: { shop, ...fields, syncedAt: new Date() } });
    return;
  }
  // A shipment that left us (closed/shipped) and came back open: start over
  const state = ACTIVE_STATES.includes(existing.state) ? existing.state : "waiting";
  await db.shipment.update({
    where: { id: existing.id },
    data: { ...fields, state, ...(state === "waiting" && existing.state !== "waiting" ? { batchId: null, readyAt: null } : {}), syncedAt: new Date() },
  });
}

// A shipment Shopify no longer lists as open: shipped elsewhere or cancelled
async function closeMissing(shop, admin, shipment) {
  const data = await gql(admin, ONE_FO, { id: shipment.fulfillmentOrderId }).catch(() => null);
  const fo = data?.fulfillmentOrder;
  const shipped = fo?.status === "CLOSED" && fo.fulfillments.nodes.length > 0;
  // Label bought in the app before the box was packed: Shopify sees it as
  // fulfilled, but it stays on the pack bench until it's packed
  if (shipped && shipment.labelEarly && shipment.labelStatus === "bought" && shipment.state === "batched") return;
  await db.shipment.update({
    where: { id: shipment.id },
    data: shipped
      ? { state: "shipped", closedAt: new Date(), waitingReason: shipment.batchId ? null : "Shipped outside the app" }
      : { state: "closed", closedAt: new Date(), waitingReason: fo ? `Closed in Shopify (${fo.status.toLowerCase()})` : "No longer in Shopify" },
  });
}

// Everything open in Shopify → shipments. Runs every 30 minutes and on demand.
export async function syncAll(shop, admin, onProgress = () => {}) {
  const seen = new Set();
  let after = null;
  let pages = 0;
  try {
    do {
      const data = await gql(admin, FO_PAGE, { after });
      const page = data?.fulfillmentOrders;
      if (!page) throw new Error("Shopify didn't return fulfillment orders. Check the app has the fulfillment order permissions.");
      for (const fo of page.nodes) {
        const s = toShipment(fo);
        if (!s) continue;
        seen.add(s.fulfillmentOrderId);
        await upsertShipment(shop, s);
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      pages++;
      onProgress({ read: seen.size, pages });
    } while (after && pages < 500);

    const missing = await db.shipment.findMany({
      where: { shop, state: { in: ACTIVE_STATES }, fulfillmentOrderId: { notIn: [...seen] } },
    });
    onProgress({ read: seen.size, pages, phase: `Closing out ${missing.length} shipped or cancelled elsewhere` });
    for (const m of missing) await closeMissing(shop, admin, m);

    await db.shippingSettings.update({ where: { shop }, data: { lastFullSyncAt: new Date(), lastSyncError: null } });
    return { open: seen.size, closed: missing.length };
  } catch (e) {
    await db.shippingSettings.update({ where: { shop }, data: { lastSyncError: errorMessage(e).slice(0, 500) } });
    throw e;
  }
}

// One order changed (new order, edit, fulfillment, cancellation)
export async function syncOrder(shop, admin, orderId) {
  const data = await gql(admin, ORDER_FOS, { id: orderId });
  const fos = data?.order?.fulfillmentOrders?.nodes ?? [];
  const seen = new Set();
  for (const fo of fos) {
    if (!["OPEN", "ON_HOLD", "IN_PROGRESS", "SCHEDULED"].includes(fo.status)) continue;
    const s = toShipment(fo);
    if (!s) continue;
    seen.add(s.fulfillmentOrderId);
    await upsertShipment(shop, s);
  }
  const missing = await db.shipment.findMany({
    where: { shop, orderId, state: { in: ACTIVE_STATES }, fulfillmentOrderId: { notIn: [...seen] } },
  });
  for (const m of missing) await closeMissing(shop, admin, m);
}

// ---------------------------------------------------------------------------
// Stock and readiness
// ---------------------------------------------------------------------------

const STOCK_QUERY = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on InventoryItem {
        id
        tracked
        inventoryLevels(first: 10) {
          nodes { location { id } quantities(names: ["on_hand"]) { name quantity } }
        }
      }
    }
  }`;

// { "itemId|locationId": on hand }
async function loadStock(admin, itemIds) {
  const stock = {};
  const ids = [...new Set(itemIds)];
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gql(admin, STOCK_QUERY, { ids: ids.slice(i, i + 50) });
    for (const item of data?.nodes ?? []) {
      if (!item?.id) continue;
      for (const lvl of item.inventoryLevels.nodes) {
        stock[`${item.id}|${lvl.location.id}`] = lvl.quantities.find((q) => q.name === "on_hand")?.quantity ?? 0;
      }
    }
  }
  return stock;
}

const lineLabel = (l) => `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`;

const prettyDay = (day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

// Lines still on pre-order today, with a reason for each.
// products: { productId: { gtTag, release } }, read fresh on every stock check
export function preorderLines(s, today, products = {}) {
  return linesOf(s)
    .map((l) => {
      const p = products[l.productId] ?? {};
      if (p.release && p.release > today) return `${lineLabel(l)} releases ${prettyDay(p.release)}`;
      if (p.gtTag) return `${lineLabel(l)} is tagged ${p.gtTag}`;
      return null;
    })
    .filter(Boolean);
}

const PRODUCT_INFO = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        tags
        releaseDate: metafield(namespace: "app-ibp-book", key: "publication_date") { value }
      }
    }
  }`;

// GT tag and release date for each product
export async function loadProductInfo(admin, productIds) {
  const info = {};
  const ids = [...new Set(productIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await gql(admin, PRODUCT_INFO, { ids: ids.slice(i, i + 100) });
    for (const p of data?.nodes ?? []) {
      if (!p?.id) continue;
      info[p.id] = { gtTag: (p.tags ?? []).find(isGtTag) ?? null, release: toDay(p.releaseDate?.value) };
    }
  }
  return info;
}

// Works out which shipments are ready, oldest orders first, and flags batched
// shipments whose stock has gone. Pure: takes shipments and stock, returns changes.
export function allocate(shipments, stock, now = new Date(), products = {}) {
  const free = { ...stock };
  const key = (l, s) => `${l.inventoryItemId}|${s.locationId}`;
  const take = (s) => {
    const short = [];
    for (const l of linesOf(s)) {
      if (!l.tracked || !l.inventoryItemId) continue;
      const k = key(l, s);
      const have = free[k] ?? 0;
      if (have < l.quantity) short.push({ line: l, need: l.quantity - Math.max(0, have) });
    }
    if (short.length) return short;
    for (const l of linesOf(s)) {
      if (!l.tracked || !l.inventoryItemId) continue;
      free[key(l, s)] = (free[key(l, s)] ?? 0) - l.quantity;
    }
    return null;
  };
  const today = dayInStore(now);
  const byAge = (a, b) => new Date(a.orderCreatedAt) - new Date(b.orderCreatedAt) || a.id - b.id;
  const changes = new Map(); // id -> data

  // Batched work keeps its claim on stock; if the stock isn't there, flag it
  // (Boxes whose label is already bought were fulfilled in Shopify: their stock has left)
  for (const s of shipments.filter((x) => ["batched", "packed", "labeling"].includes(x.state) && x.labelStatus !== "bought").sort(byAge)) {
    const short = take(s);
    const pre = preorderLines(s, today, products);
    const flag =
      [
        pre.length ? `Not released yet: ${pre.join(", ")}` : null,
        short ? `Not enough stock: ${short.map((x) => `${x.need} × ${lineLabel(x.line)}`).join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(". ") || null;
    const ours = (f) => !f || f.startsWith("Not enough stock") || f.startsWith("Not released yet");
    // Packed boxes have their items already; only flag work not yet packed
    if (s.state === "batched" && flag !== s.flag && ours(s.flag)) changes.set(s.id, { flag });
  }

  for (const s of shipments.filter((x) => x.state === "waiting" || x.state === "ready").sort(byAge)) {
    let reason = null;
    if (!PAID.has(s.financialStatus ?? "")) reason = "Awaiting payment";
    else if (s.otherHold) reason = `On hold in Shopify: ${s.otherHold}`;
    else if (s.foStatus === "SCHEDULED") reason = "Scheduled for later";
    else if (preorderLines(s, today, products).length) reason = `Pre-order: ${preorderLines(s, today, products).join(", ")}`;
    else {
      const short = take(s);
      if (short) reason = `Needs ${short.map((x) => `${x.need} more × ${lineLabel(x.line)}`).join(", ")}`;
    }
    const state = reason ? "waiting" : "ready";
    if (state !== s.state || reason !== s.waitingReason) {
      changes.set(s.id, {
        state,
        waitingReason: reason,
        readyAt: state === "ready" ? (s.readyAt ?? now) : null,
      });
    }
  }
  return { changes, free };
}

export async function refreshReadiness(shop, admin) {
  const shipments = await db.shipment.findMany({ where: { shop, state: { in: ACTIVE_STATES } } });
  const items = shipments.flatMap((s) => linesOf(s).filter((l) => l.tracked && l.inventoryItemId).map((l) => l.inventoryItemId));
  const stock = items.length ? await loadStock(admin, items) : {};
  const products = await loadProductInfo(admin, shipments.flatMap((s) => linesOf(s).map((l) => l.productId)));
  const { changes } = allocate(shipments, stock, new Date(), products);
  for (const [id, data] of changes) await db.shipment.update({ where: { id }, data });
  await db.shippingSettings.update({ where: { shop }, data: { lastReadyRunAt: new Date() } });
  return { checked: shipments.length, changed: changes.size, stock };
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

const HOLD = `#graphql
  mutation ($id: ID!, $hold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
      fulfillmentHold { id }
      userErrors { field message }
    }
  }`;

const RELEASE = `#graphql
  mutation ($id: ID!, $holdIds: [ID!]) {
    fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }`;

// Should the app be holding this shipment right now?
export function wantsHold(s, mode) {
  if (s.overrideAt) return false; // let through by someone allowed to ship outside a batch
  if (!ACTIVE_STATES.includes(s.state)) return false;
  if (mode === "notReady") return s.state === "waiting" && !s.otherHold;
  if (mode === "untilBatched") return s.state !== "labeling";
  return false;
}

async function placeHold(admin, s, mode) {
  const data = await gql(admin, HOLD, {
    id: s.fulfillmentOrderId,
    hold: {
      reason: "OTHER",
      reasonNotes:
        mode === "untilBatched" ? "Ships through a batch in MonkeyBean" : "Not ready to ship yet (MonkeyBean)",
      handle: HOLD_HANDLE,
      notifyMerchant: false,
    },
  });
  const r = data?.fulfillmentOrderHold;
  if (r?.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
  return r?.fulfillmentHold?.id ?? null;
}

async function releaseHold(admin, s) {
  const data = await gql(admin, RELEASE, { id: s.fulfillmentOrderId, holdIds: [s.appHoldId] });
  const r = data?.fulfillmentOrderReleaseHold;
  if (r?.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
}

// Brings Shopify's holds in line with the setting, a limited number per run
export async function reconcileHolds(shop, admin) {
  const { holdMode } = await getShippingSettings(shop);
  const rows = await db.shipment.findMany({
    where: { shop, OR: [{ state: { in: ACTIVE_STATES } }, { appHoldId: { not: null } }] },
    orderBy: { orderCreatedAt: "asc" },
  });
  let changed = 0;
  for (const s of rows) {
    if (changed >= MAX_HOLD_CHANGES_PER_RUN) break;
    const want = wantsHold(s, holdMode);
    const have = Boolean(s.appHoldId);
    if (want === have) continue;
    // Don't retry a failing shipment more than every 30 minutes
    if (s.holdError && Date.now() - s.updatedAt.getTime() < 30 * 60 * 1000) continue;
    changed++;
    try {
      if (want) {
        const holdId = await placeHold(admin, s, holdMode);
        await db.shipment.update({ where: { id: s.id }, data: { appHoldId: holdId, holdError: null } });
      } else {
        await releaseHold(admin, s);
        await db.shipment.update({ where: { id: s.id }, data: { appHoldId: null, holdError: null } });
      }
    } catch (e) {
      await db.shipment.update({ where: { id: s.id }, data: { holdError: errorMessage(e).slice(0, 300) } });
    }
  }
  return { changed };
}

// ---------------------------------------------------------------------------
// Staff actions
// ---------------------------------------------------------------------------

export class ShippingError extends Error {}

// "Ship outside a batch": lift the app's hold so it can be shipped from Shopify now
export async function allowOutsideBatch(shop, admin, id, user, reason) {
  const s = await db.shipment.findFirst({ where: { shop, id } });
  if (!s) throw new ShippingError("That shipment couldn't be found.");
  if (!ACTIVE_STATES.includes(s.state)) throw new ShippingError("That shipment has already shipped or closed.");
  const why = String(reason ?? "").trim();
  if (!why) throw new ShippingError("Add a short reason, e.g. \"Customer collecting today\".");
  if (s.appHoldId) await releaseHold(admin, s);
  await db.shipment.update({
    where: { id: s.id },
    data: { appHoldId: null, holdError: null, overrideAt: new Date(), overrideBy: user?.name ?? null, overrideReason: why.slice(0, 300) },
  });
  await logEvent(shop, { shipmentId: s.id, orderName: s.orderName, type: "ship_outside_batch", detail: why, user });
}

// Put the app's normal rules back on a shipment let through earlier
export async function clearOutsideBatch(shop, id, user) {
  const s = await db.shipment.findFirst({ where: { shop, id } });
  if (!s || !s.overrideAt) return;
  await db.shipment.update({ where: { id: s.id }, data: { overrideAt: null, overrideBy: null, overrideReason: null } });
  await logEvent(shop, { shipmentId: s.id, orderName: s.orderName, type: "outside_batch_cleared", user });
}

export async function saveShippingSettings(shop, { holdMode }, user) {
  if (!["off", "notReady", "untilBatched"].includes(holdMode)) throw new ShippingError("Unknown hold setting.");
  if (holdMode === "untilBatched") throw new ShippingError("\"Hold everything until its batch ships\" turns on with the Ship step, coming in a later stage.");
  const before = await getShippingSettings(shop);
  await db.shippingSettings.update({ where: { shop }, data: { holdMode } });
  if (before.holdMode !== holdMode) await logEvent(shop, { type: "hold_mode", detail: `${before.holdMode} → ${holdMode}`, user });
}

// Words that decide the shipping method badges (cheapest / fastest / buyer-selected)
export async function saveMethodRules(shop, input, user) {
  const rules = methodRulesOf(input);
  await getShippingSettings(shop);
  await db.shippingSettings.update({ where: { shop }, data: { methodRules: JSON.stringify(rules) } });
  await logEvent(shop, { type: "method_rules", detail: `Fastest: ${rules.fastest.join(", ") || "—"} · Cheapest: ${rules.cheapest.join(", ") || "—"} · Buyer-selected: ${rules.buyer.join(", ") || "—"} · otherwise ${rules.otherwise}`, user });
  return rules;
}

// ---------------------------------------------------------------------------
// Lists for the Shipping page
// ---------------------------------------------------------------------------

const viewShipment = (s) => ({
  id: s.id,
  orderId: s.orderId,
  orderName: s.orderName,
  orderNumber: s.orderId.split("/").pop(),
  orderCreatedAt: s.orderCreatedAt.toISOString(),
  customerName: s.customerName,
  shippingMethod: s.shippingMethod,
  country: s.country,
  province: s.province,
  part: s.partCount > 1 ? `${s.partIndex} of ${s.partCount}` : null,
  state: s.state,
  waitingReason: s.waitingReason,
  readyAt: s.readyAt?.toISOString() ?? null,
  units: s.units,
  lines: linesOf(s).map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, sku: l.sku, imageUrl: l.imageUrl, productId: l.productId })),
  held: Boolean(s.appHoldId),
  holdError: s.holdError,
  otherHold: s.otherHold,
  override: s.overrideAt ? { by: s.overrideBy, at: s.overrideAt.toISOString(), reason: s.overrideReason } : null,
  flag: s.flag,
  notice: noticeOf(s),
  packedAt: s.packedAt?.toISOString() ?? null,
  packedBy: s.packedBy,
  packOverride: s.packOverride,
  batchId: s.batchId,
  tagError: s.tagError,
});

// Open review flags on each shipment's order ("Flag/Review")
export async function withFlags(shop, shipments) {
  const ids = [...new Set(shipments.map((s) => s.orderId))];
  if (!ids.length) return shipments;
  const flags = await db.orderFlag.findMany({ where: { shop, status: "open", orderId: { in: ids } }, orderBy: { id: "asc" } });
  const byOrder = new Map();
  for (const f of flags) byOrder.set(f.orderId, [...(byOrder.get(f.orderId) ?? []), { id: f.id, reason: f.reason, note: f.note, by: f.createdBy }]);
  return shipments.map((s) => ({ ...s, review: byOrder.get(s.orderId) ?? [] }));
}

// filter: { state, q, product, variant, method, country, batchId, singles, doubles, pair, sort: oldest | newest }
//   singles: one unit in the box; doubles: two units (pair: "variantA|variantB", or "variantA" for two of one item)
export function shipmentWhere(shop, filter = {}) {
  const where = { shop, state: filter.state ?? "ready" };
  if (filter.batchId) {
    where.batchId = Number(filter.batchId);
    where.state = { in: ACTIVE_STATES.concat(["shipped"]) };
  }
  if (filter.method) where.shippingMethod = filter.method;
  if (filter.country === "domestic") where.country = "US";
  if (filter.country === "international") where.NOT = { country: "US" };
  if (filter.q) {
    const q = String(filter.q).trim();
    where.OR = [
      { orderName: { contains: q, mode: "insensitive" } },
      { customerName: { contains: q, mode: "insensitive" } },
      { lines: { contains: q, mode: "insensitive" } },
    ];
  }
  const and = [];
  if (filter.product) and.push({ lines: { contains: `"productId":"${filter.product}"` } });
  if (filter.variant) and.push({ lines: { contains: `"variantId":"${filter.variant}"` } });
  if (filter.singles) where.units = 1;
  else if (filter.doubles) {
    where.units = 2;
    const pair = String(filter.pair ?? "").split("|").filter(Boolean).slice(0, 2);
    for (const v of pair) and.push({ lines: { contains: `"variantId":"${v}"` } });
    // Two of one item: a single line (lines are stored as a JSON array, so two lines contain "},{")
    if (pair.length === 1) and.push({ NOT: { lines: { contains: "},{" } } });
  }
  if (and.length) where.AND = and;
  return where;
}

// Products in shipments of one state, for the product filter's suggestions.
// Matches the title, variant or SKU; titles that start with the text come first.
export async function suggestProducts(shop, { q = "", state = "ready", singles = false, doubles = false, limit = 10 } = {}) {
  const text = String(q ?? "").trim().toLowerCase();
  const rows = await db.shipment.findMany({
    where: {
      shop,
      state: ["ready", "waiting"].includes(state) ? state : "ready",
      ...(singles ? { units: 1 } : doubles ? { units: 2 } : {}),
      ...(text ? { lines: { contains: text, mode: "insensitive" } } : {}),
    },
    select: { lines: true },
    take: 5000,
  });
  const found = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const l of json(r.lines, [])) {
      if (!l.productId || seen.has(l.productId)) continue;
      const hay = [l.title, l.variantTitle, l.sku].filter(Boolean).join(" ").toLowerCase();
      if (text && !hay.includes(text)) continue;
      seen.add(l.productId);
      const p = found.get(l.productId) ?? { productId: l.productId, title: l.title, imageUrl: l.imageUrl ?? null, shipments: 0 };
      p.shipments++;
      found.set(l.productId, p);
    }
  }
  const starts = (p) => (text && String(p.title ?? "").toLowerCase().startsWith(text) ? 0 : 1);
  return [...found.values()]
    .sort((a, b) => starts(a) - starts(b) || b.shipments - a.shipments || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);
}

// Doubles: the most common two-item combinations (two different items, or two of one),
// among the shipments the other filters show. Picking one filters the list to it.
const pairItem = (l, qty = 1) => ({ variantId: l.variantId, productId: l.productId ?? null, title: l.title, variantTitle: l.variantTitle ?? null, imageUrl: l.imageUrl ?? null, qty });
export async function doublePairs(shop, filter = {}, { limit = 12 } = {}) {
  const where = shipmentWhere(shop, { ...filter, singles: false, doubles: true, pair: "" });
  const rows = await db.shipment.findMany({ where, select: { lines: true }, take: 20000 });
  const groups = new Map();
  for (const r of rows) {
    const lines = json(r.lines, []);
    if (!lines.length || lines.some((l) => !l.variantId)) continue;
    let key;
    let items;
    if (lines.length === 1 && lines[0].quantity === 2) {
      key = lines[0].variantId;
      items = [pairItem(lines[0], 2)];
    } else if (lines.length === 2 && lines.every((l) => l.quantity === 1) && lines[0].variantId !== lines[1].variantId) {
      const [a, b] = [...lines].sort((x, y) => x.variantId.localeCompare(y.variantId));
      key = `${a.variantId}|${b.variantId}`;
      items = [pairItem(a), pairItem(b)];
    } else continue;
    const g = groups.get(key) ?? { key, items, shipments: 0 };
    g.shipments++;
    groups.set(key, g);
  }
  const all = [...groups.values()];
  const label = (g) => g.items.map((i) => i.title).join(" + ");
  return {
    shipments: rows.length,
    combinations: all.length,
    pairs: all.sort((a, b) => b.shipments - a.shipments || label(a).localeCompare(label(b))).slice(0, limit),
  };
}

// The variants of the chosen product in the shipments shown, with how many shipments have each
export async function productVariants(shop, filter = {}) {
  if (!filter.product) return [];
  const where = shipmentWhere(shop, { ...filter, variant: "", pair: "" });
  const rows = await db.shipment.findMany({ where, select: { lines: true }, take: 20000 });
  const found = new Map();
  for (const r of rows) {
    const seen = new Set();
    for (const l of json(r.lines, [])) {
      if (l.productId !== filter.product || !l.variantId || seen.has(l.variantId)) continue;
      seen.add(l.variantId);
      const v = found.get(l.variantId) ?? { variantId: l.variantId, title: l.variantTitle || l.title, sku: l.sku ?? null, shipments: 0 };
      v.shipments++;
      found.set(l.variantId, v);
    }
  }
  return [...found.values()].sort((a, b) => String(a.title).localeCompare(String(b.title), undefined, { numeric: true }));
}

export const shipmentOrder = (sort) => {
  const dir = sort === "newest" ? "desc" : "asc";
  return [{ orderCreatedAt: dir }, { id: dir }];
};

export async function listShipments(shop, filter = {}, { page = 1, pageSize = 50, viewer = null } = {}) {
  const where = shipmentWhere(shop, filter);
  const [rows, total] = await Promise.all([
    db.shipment.findMany({
      where,
      orderBy: shipmentOrder(filter.sort),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.shipment.count({ where }),
  ]);
  const shipments = await withNotices(shop, await withFlags(shop, rows.map(viewShipment)), viewer);
  return { shipments, total, page, hasMore: page * pageSize < total };
}

// Counts, shipping methods, and a per-product stock picture
export async function shippingOverview(shop) {
  const [counts, methods, active, settings] = await Promise.all([
    db.shipment.groupBy({ by: ["state"], where: { shop }, _count: { _all: true } }),
    db.shipment.groupBy({ by: ["shippingMethod"], where: { shop, state: { in: ["waiting", "ready"] } }, _count: { _all: true } }),
    db.shipment.findMany({ where: { shop, state: { in: ["waiting", "ready", "batched", "packed", "labeling"] } }, select: { state: true, lines: true } }),
    getShippingSettings(shop),
  ]);
  // Per product: units wanted and how many of those are ready
  const products = new Map();
  for (const s of active) {
    for (const l of json(s.lines, [])) {
      const k = l.productId ?? l.title;
      const p = products.get(k) ?? { productId: l.productId, title: l.title, ordered: 0, readyUnits: 0, waitingUnits: 0, shipments: 0 };
      p.ordered += l.quantity;
      if (s.state === "waiting") p.waitingUnits += l.quantity;
      else p.readyUnits += l.quantity;
      p.shipments++;
      products.set(k, p);
    }
  }
  return {
    counts: Object.fromEntries(counts.map((c) => [c.state, c._count._all])),
    methods: methods
      .filter((m) => m.shippingMethod)
      .map((m) => ({ method: m.shippingMethod, count: m._count._all }))
      .sort((a, b) => b.count - a.count),
    products: [...products.values()].sort((a, b) => b.waitingUnits - a.waitingUnits || b.ordered - a.ordered).slice(0, 100),
    settings: {
      holdMode: settings.holdMode,
      lastFullSyncAt: settings.lastFullSyncAt?.toISOString() ?? null,
      lastReadyRunAt: settings.lastReadyRunAt?.toISOString() ?? null,
      lastSyncError: settings.lastSyncError,
      addressCheckError: settings.addressCheckError,
      autoBatchEnabled: settings.autoBatchEnabled,
      autoBatchTime: settings.autoBatchTime,
      autoSingleItem: settings.autoSingleItem,
      autoSingleMin: settings.autoSingleMin,
      lastAutoBatchAt: settings.lastAutoBatchAt?.toISOString() ?? null,
      packageStep: settings.packageStep,
      weightUnit: settings.weightUnit,
      dimUnit: settings.dimUnit,
      boxes: settings.boxes,
      packedTag: settings.packedTag,
      labelBoxId: settings.labelBoxId ?? null,
      labelNotify: settings.labelNotify !== false,
      methodRules: methodRulesOf(settings.methodRules),
    },
  };
}

// ---------------------------------------------------------------------------
// Notices: an order note, or Shopify's warning that the shipping address may
// be invalid (its address verification: WARNING or ERROR). Staff must read and
// acknowledge them before viewing the order, and again at the pack bench.
// ---------------------------------------------------------------------------

export const staffKeyOf = (user) => String(user?.id ?? user?.email ?? user?.name ?? "staff");

// Which flagged address a "keep as is" decision was about
export const addressKeyOf = (a) => (a?.level ? createHash("sha1").update((a.address ?? []).join("/")).digest("hex").slice(0, 12) : null);

export function noticeOf(s) {
  if (!s.noticeKey) return null;
  const a = json(s.noticeAddress, null);
  const address = a?.level ? a : null;
  const d = json(s.addressDecision, null);
  // A decision only counts for the address it was made about
  const kept = address && d && d.key === addressKeyOf(address) ? { by: d.by, at: d.at } : null;
  return { key: s.noticeKey, note: s.orderNote ?? null, address, shipTo: a?.address ?? null, kept };
}

// Adds ackedByMe to each shipment's notice for this person
export async function withNotices(shop, shipments, viewer) {
  const keyed = shipments.filter((s) => s.notice);
  if (!keyed.length || !viewer) return shipments;
  const acks = await db.noticeAck.findMany({
    where: { shop, staffKey: viewer, context: "view", orderId: { in: [...new Set(keyed.map((s) => s.orderId))] } },
    select: { orderId: true, noticeKey: true },
  });
  const seen = new Set(acks.map((a) => `${a.orderId}|${a.noticeKey}`));
  return shipments.map((s) => (s.notice ? { ...s, notice: { ...s.notice, ackedByMe: seen.has(`${s.orderId}|${s.notice.key}`) } } : s));
}

// context: "view" (lists, per person, once per version) or "pack" (each time a box is packed)
// Back from reviewing the order in Shopify: re-read it now and say what changed
export async function recheckOrder(shop, admin, shipmentId) {
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId) } });
  if (!s) throw new ShippingError("That shipment couldn't be found.");
  const before = noticeOf(s);
  if (!isSandboxShop(shop)) {
    await syncOrder(shop, admin, s.orderId);
    await refreshNotices(shop, admin, { orderIds: [s.orderId] });
  }
  const after = await db.shipment.findUnique({ where: { id: s.id } });
  const n = noticeOf(after);
  return { notice: n, fixed: Boolean(before?.address) && !n?.address, stillFlagged: Boolean(n?.address) };
}

// Keep the flagged address as it is (Shopify's suggestion declined)
export async function keepAddress(shop, shipmentId, user) {
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId) } });
  if (!s) throw new ShippingError("That shipment couldn't be found.");
  const n = noticeOf(s);
  if (!n?.address) throw new ShippingError("Shopify isn't flagging this address any more.");
  const decision = { key: addressKeyOf(n.address), by: user?.name ?? null, at: new Date().toISOString() };
  await db.shipment.updateMany({ where: { shop, orderId: s.orderId }, data: { addressDecision: JSON.stringify(decision) } });
  await logEvent(shop, {
    shipmentId: s.id,
    orderName: s.orderName,
    type: "address_kept",
    detail: `Kept the address Shopify flagged (${n.address.level === "ERROR" ? "likely invalid" : "may be invalid"}): ${(n.address.address ?? []).join(", ")}`,
    user,
  });
  return { notice: noticeOf({ ...s, addressDecision: JSON.stringify(decision) }) };
}

export async function ackNotice(shop, shipmentId, context, user) {
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId) } });
  if (!s) throw new ShippingError("That shipment couldn't be found.");
  if (!s.noticeKey) return { key: null };
  const ctx = context === "pack" ? "pack" : "view";
  const staffKey = staffKeyOf(user);
  await db.noticeAck.upsert({
    where: { shop_orderId_noticeKey_staffKey_context: { shop, orderId: s.orderId, noticeKey: s.noticeKey, staffKey, context: ctx } },
    create: { shop, orderId: s.orderId, noticeKey: s.noticeKey, staffKey, staffName: user?.name ?? null, context: ctx },
    update: { createdAt: new Date(), staffName: user?.name ?? null },
  });
  if (ctx === "pack") await db.shipment.update({ where: { id: s.id }, data: { packAckKey: s.noticeKey } });
  const n = noticeOf(s);
  // List views pop up on every click; recorded, but kept out of the activity log
  if (ctx === "view") return { key: s.noticeKey };
  await logEvent(shop, {
    shipmentId: s.id,
    orderName: s.orderName,
    type: ctx === "pack" ? "notice_ack_pack" : "notice_ack",
    detail: [n.note ? "note" : null, n.address ? `address ${n.address.level === "ERROR" ? "likely invalid" : "may be invalid"}` : null].filter(Boolean).join(" and "),
    user,
  });
  return { key: s.noticeKey };
}

const NOTICE_INFO = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id note updatedAt }
    }
  }`;

// Separate: addresses need Shopify's customer-data approval; without it notes still work
const NOTICE_ADDRESS = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id shippingAddress { validationResultSummary formatted(withName: true, withCompany: true) } }
    }
  }`;

const hashOf = (x) => createHash("sha1").update(x).digest("hex").slice(0, 16);
export const ADDRESS_LEVEL_TEXT = {
  ERROR: "Shopify says this shipping address is likely invalid.",
  WARNING: "Shopify says this shipping address may be invalid.",
};

// The notice for one order: its note, and the address if Shopify flagged it
export function computeNotice({ order, address }) {
  const note = order.note?.trim() || null;
  const level = ["WARNING", "ERROR"].includes(address?.validationResultSummary) ? address.validationResultSummary : null;
  const lines = address?.formatted ?? null;
  const addr = level ? { level, text: ADDRESS_LEVEL_TEXT[level], address: lines } : null;
  const key = note || addr ? hashOf(`${note ?? ""}|${addr ? `${level}|${(lines ?? []).join("/")}` : ""}`) : null;
  return { note, address: addr, shipTo: lines, key };
}

// Checks orders that are new or changed since their last check, ready and batched first
export async function refreshNotices(shop, admin, { limit = 500, orderIds: only = null } = {}) {
  const rows = await db.shipment.findMany({
    where: { shop, state: { in: ACTIVE_STATES }, ...(only ? { orderId: { in: only } } : {}) },
    select: { orderId: true, state: true, orderUpdatedAt: true, noticeCheckedAt: true },
  });
  const due = new Map();
  for (const r of rows) {
    // Asked for by name (someone just fixed it in Shopify): always re-read
    if (!only && r.noticeCheckedAt && (!r.orderUpdatedAt || r.orderUpdatedAt <= r.noticeCheckedAt)) continue;
    const prio = r.state === "waiting" ? 1 : 0;
    if (!due.has(r.orderId) || prio < due.get(r.orderId)) due.set(r.orderId, prio);
  }
  const orderIds = [...due.entries()].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([id]) => id);
  let checked = 0;
  let addressError = null;
  for (let i = 0; i < orderIds.length; i += 25) {
    const ids = orderIds.slice(i, i + 25);
    const info = await gql(admin, NOTICE_INFO, { ids });
    let addresses = null;
    if (!addressError) {
      try {
        addresses = await gql(admin, NOTICE_ADDRESS, { ids });
      } catch (e) {
        addressError = errorMessage(e);
      }
    }
    const addrOf = new Map((addresses?.nodes ?? []).filter(Boolean).map((n) => [n.id, n.shippingAddress ?? null]));
    const now = new Date();
    for (const order of info?.nodes ?? []) {
      if (!order?.id) continue;
      const r = computeNotice({ order, address: addrOf.get(order.id) });
      await db.shipment.updateMany({
        where: { shop, orderId: order.id },
        data: {
          orderNote: r.note,
          noticeAddress: r.address ? JSON.stringify(r.address) : r.shipTo ? JSON.stringify({ level: null, address: r.shipTo }) : null,
          noticeKey: r.key,
          noticeCheckedAt: now,
        },
      });
      checked++;
    }
  }
  if (orderIds.length) {
    await db.shippingSettings.update({
      where: { shop },
      data: {
        addressCheckError: addressError
          ? `Shopify didn't share shipping addresses with this app, so invalid-address warnings can't be shown (order notes still are). Apps built for your own store normally get addresses automatically; try opening the app from Shopify admin once so it picks up its permissions, and if this stays, the message from Shopify was: ${addressError}`.slice(0, 600)
          : null,
      },
    });
  }
  return { checked, remaining: Math.max(0, due.size - orderIds.length), addressError };
}

// ---------------------------------------------------------------------------
// Order quick view
// ---------------------------------------------------------------------------

const ORDER_DETAILS = `#graphql
  query ($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      cancelledAt
      closed
      displayFinancialStatus
      displayFulfillmentStatus
      tags
      note
      customer { displayName numberOfOrders }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      shippingLines(first: 5) { nodes { title } }
      lineItems(first: 100) {
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          currentQuantity
          unfulfilledQuantity
          image { url(transform: { maxWidth: 80 }) }
          product { id }
        }
      }
      fulfillments(first: 20) { name createdAt displayStatus trackingInfo(first: 3) { company number url } }
    }
  }`;

// Kept separate: the address needs extra customer-data approval, and the rest
// of the order should still show without it
const ORDER_ADDRESS = `#graphql
  query ($id: ID!) {
    order(id: $id) { shippingAddress { name city provinceCode zip countryCodeV2 } }
  }`;

const tidy = (s) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null);

export async function orderDetails(shop, admin, orderId) {
  const [data, address, shipments, flags] = await Promise.all([
    gql(admin, ORDER_DETAILS, { id: orderId }),
    gql(admin, ORDER_ADDRESS, { id: orderId }).catch(() => null),
    db.shipment.findMany({ where: { shop, orderId }, orderBy: [{ partIndex: "asc" }, { id: "asc" }] }),
    db.orderFlag.findMany({ where: { shop, orderId }, orderBy: { id: "desc" } }),
  ]);
  const o = data?.order;
  if (!o) return null;
  const batchIds = [...new Set(shipments.map((s) => s.batchId).filter(Boolean))];
  const batches = batchIds.length ? await db.batch.findMany({ where: { id: { in: batchIds } }, select: { id: true, tag: true, name: true, status: true } }) : [];
  const batchOf = new Map(batches.map((b) => [b.id, b]));
  const a = address?.order?.shippingAddress;
  return {
    id: o.id,
    number: o.id.split("/").pop(),
    name: o.name,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    closed: o.closed,
    payment: tidy(o.displayFinancialStatus),
    fulfillment: tidy(o.displayFulfillmentStatus),
    tags: o.tags,
    note: o.note,
    customer: o.customer ? { name: o.customer.displayName, orders: Number(o.customer.numberOfOrders) } : null,
    total: o.currentTotalPriceSet?.shopMoney ?? null,
    shippingMethods: o.shippingLines.nodes.map((l) => l.title),
    address: a ? { name: a.name, place: [a.city, a.provinceCode, a.zip].filter(Boolean).join(", "), country: a.countryCodeV2 } : null,
    lines: o.lineItems.nodes
      .filter((l) => l.currentQuantity > 0 || l.quantity > 0)
      .map((l) => ({
        id: l.id,
        title: l.title,
        variantTitle: l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : null,
        sku: l.sku,
        quantity: l.currentQuantity,
        removed: l.quantity - l.currentQuantity,
        unfulfilled: l.unfulfilledQuantity,
        imageUrl: l.image?.url ?? null,
        productId: l.product?.id ?? null,
      })),
    fulfillments: o.fulfillments.map((f) => ({
      name: f.name,
      at: f.createdAt,
      status: tidy(f.displayStatus),
      tracking: f.trackingInfo.map((t) => ({ company: t.company, number: t.number, url: t.url })),
    })),
    flags: flags
      .map((f) => ({
        id: f.id,
        reason: f.reason,
        note: f.note,
        status: f.status,
        createdBy: f.createdBy,
        createdAt: f.createdAt.toISOString(),
        resolvedBy: f.resolvedBy,
        resolvedAt: f.resolvedAt?.toISOString() ?? null,
        resolution: f.resolution,
      }))
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1)),
    shipments: shipments.map((s) => ({
      id: s.id,
      part: s.partCount > 1 ? `${s.partIndex} of ${s.partCount}` : null,
      state: s.state,
      waitingReason: s.waitingReason,
      flag: s.flag,
      shippingMethod: s.shippingMethod,
      units: s.units,
      lines: linesOf(s).map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity })),
      batch: s.batchId && batchOf.get(s.batchId) ? batchOf.get(s.batchId) : null,
      override: s.overrideAt ? { by: s.overrideBy, reason: s.overrideReason } : null,
    })),
  };
}

export async function recentEvents(shop, take = 50) {
  const rows = await db.shippingEvent.findMany({ where: { shop }, orderBy: { id: "desc" }, take });
  return rows.map((e) => ({ id: e.id, type: e.type, detail: e.detail, orderName: e.orderName, userName: e.userName, at: e.createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------
// Background work: sync, readiness and holds
// ---------------------------------------------------------------------------

const inFlight = new Map(); // shop -> the run in progress
// Extra work after each refresh (batch tags, auto-batching), registered by other modules
const afterRun = [];
export const onAfterRun = (fn) => {
  if (!afterRun.includes(fn)) afterRun.push(fn);
};
const progress = new Map(); // shop -> what the run is doing now
const lastRun = new Map(); // shop -> how the last full read went
const pendingOrders = new Map(); // shop -> Set(orderId)
const readinessTimers = new Map(); // shop -> pending refresh

async function counts(shop) {
  const rows = await db.shipment.groupBy({ by: ["state"], where: { shop, state: { in: ["waiting", "ready"] } }, _count: { _all: true } });
  const n = Object.fromEntries(rows.map((c) => [c.state, c._count._all]));
  return { ready: n.ready ?? 0, waiting: n.waiting ?? 0 };
}

async function work(shop, full, manual) {
  const p = { startedAt: new Date().toISOString(), manual, full, phase: "Starting", read: 0, pages: 0 };
  progress.set(shop, p);
  const step = (phase) => Object.assign(p, { phase });
  // Sandbox: no reading from Shopify or holds; just the batch work, with changes skipped
  if (isSandboxShop(shop)) {
    try {
      for (const hook of afterRun) await hook(shop, sandboxAdmin(null, shop), step).catch((e) => console.error("[shipping] sandbox:", errorMessage(e)));
      return null;
    } finally {
      progress.delete(shop);
    }
  }
  try {
    const { admin } = await unauthenticated.admin(shop);
    const s = await getShippingSettings(shop);
    const fullDue = full || !s.lastFullSyncAt || Date.now() - s.lastFullSyncAt.getTime() > 30 * 60 * 1000;
    let read = null;
    if (fullDue) {
      p.full = true;
      // Quick pass first, so stock and pre-order changes show without waiting for the full read
      step("Checking stock and pre-orders");
      await refreshReadiness(shop, admin);
      step("Reading open orders from Shopify");
      read = await syncAll(shop, admin, (x) => Object.assign(p, x));
    }
    const orders = [...(pendingOrders.get(shop) ?? [])];
    pendingOrders.delete(shop);
    if (orders.length) step(`Re-reading ${orders.length} changed order${orders.length === 1 ? "" : "s"}`);
    for (const id of orders) await syncOrder(shop, admin, id).catch((e) => console.error("[shipping] order sync:", errorMessage(e)));
    step("Checking stock and pre-orders");
    await refreshReadiness(shop, admin);
    step("Checking order notes and address changes");
    await refreshNotices(shop, admin).catch((e) => console.error("[shipping] notices:", errorMessage(e)));
    step("Updating holds");
    await reconcileHolds(shop, admin);
    for (const hook of afterRun) {
      await hook(shop, admin, step).catch((e) => console.error("[shipping] after run:", errorMessage(e)));
    }
    if (read) {
      lastRun.set(shop, {
        ok: true,
        manual,
        startedAt: p.startedAt,
        finishedAt: new Date().toISOString(),
        open: read.open,
        closed: read.closed,
        ...(await counts(shop)),
      });
    }
    return read;
  } catch (e) {
    console.error(`[shipping] ${shop}:`, errorMessage(e));
    if (p.full) lastRun.set(shop, { ok: false, manual, startedAt: p.startedAt, finishedAt: new Date().toISOString(), error: errorMessage(e).slice(0, 300) });
    throw e;
  } finally {
    progress.delete(shop);
  }
}

// One run per shop at a time; a second caller shares the run in progress
function runFor(shop, { full = false, manual = false } = {}) {
  if (inFlight.has(shop)) return inFlight.get(shop);
  const run = work(shop, full, manual).finally(() => inFlight.delete(shop));
  inFlight.set(shop, run);
  return run;
}

// A quick refresh (no full read) that callers can wait for
export const refreshNow = (shop) => runFor(shop, { full: false });

// What the Shipping page shows about reading from Shopify
export function syncStatus(shop) {
  const p = progress.get(shop);
  return { running: p ? { ...p } : null, last: lastRun.get(shop) ?? null };
}

// From webhooks: an order changed, or stock moved. Batched up for a few seconds.
export function orderChanged(shop, orderId) {
  if (!orderId) return;
  if (!pendingOrders.has(shop)) pendingOrders.set(shop, new Set());
  pendingOrders.get(shop).add(orderId);
  soon(shop);
}
export function stockMoved(shop) {
  soon(shop);
}
// Batches changed: tags to update. Sooner than the webhook delay.
export function kick(shop, ms = 1500) {
  soon(shop, ms);
}
// A product's tags or release date changed: re-read the orders it's on
export async function productChanged(shop, productId) {
  if (!productId) return;
  const rows = await db.shipment.findMany({
    where: { shop, state: { in: ACTIVE_STATES }, lines: { contains: `"productId":"${productId}"` } },
    select: { orderId: true },
  });
  if (!rows.length) return;
  if (!pendingOrders.has(shop)) pendingOrders.set(shop, new Set());
  for (const r of rows) pendingOrders.get(shop).add(r.orderId);
  soon(shop);
}
function soon(shop, ms = 8000) {
  clearTimeout(readinessTimers.get(shop));
  readinessTimers.set(
    shop,
    setTimeout(() => {
      readinessTimers.delete(shop);
      runFor(shop).catch(() => {});
    }, ms),
  );
}
// "Read everything from Shopify now": waits for any run already going, then
// does a full read. Runs on the server whether or not anyone stays on the page.
export async function runNow(shop, opts = { full: true }) {
  while (inFlight.has(shop)) await inFlight.get(shop).catch(() => {});
  const read = await runFor(shop, { manual: true, ...opts });
  return { open: read?.open ?? null, closed: read?.closed ?? 0, ...(await counts(shop)), at: new Date().toISOString() };
}

// Starts a full read in the background (unless one is already going)
const queued = new Set(); // shops with a full read asked for and not yet finished
export function startFullRead(shop) {
  if (queued.has(shop) || progress.get(shop)?.full) return { alreadyRunning: true };
  queued.add(shop);
  runNow(shop, { full: true })
    .catch(() => {})
    .finally(() => queued.delete(shop));
  return { started: true };
}

async function tick() {
  const sessions = await db.session.findMany({ where: { isOnline: false }, select: { shop: true } });
  for (const shop of new Set(sessions.map((s) => s.shop))) await runFor(shop).catch(() => {});
}

if (!globalThis.__shippingTimer && process.env.NODE_ENV !== "test") {
  const t = () => tick().catch((e) => console.error("[shipping] tick:", errorMessage(e)));
  globalThis.__shippingTimer = setInterval(t, 2 * 60 * 1000);
  setTimeout(t, 45 * 1000);
}
