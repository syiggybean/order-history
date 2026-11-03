import db from "./db.server";
import { gql } from "./preorders.server";
import { ShippingError, isSandboxShop, kick, linesOf, logEvent, onAfterRun, releaseHold } from "./shipping.server";

// ---------------------------------------------------------------------------
// Order Merge: open orders for the same customer and address shipped in one box.
//
// - The main order (left on the Order Merge tab) goes in whole; the person picks
//   which items of the other orders go with it.
// - The main shipment carries those items (mergedLines), so they're on its pick
//   list, packing slip and pack bench; the other orders stay out of batches
//   (mergedInto) until the box ships.
// - Its label is bought on the main order in Shopify as usual. When that order has
//   shipped, the app fulfills the chosen items of the other orders with the same
//   tracking number, and Shopify emails each customer.
// - Orders in Shopify stay separate (payments, refunds and reports untouched).
// ---------------------------------------------------------------------------

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const itemKey = (l) => l.variantId ?? `title:${l.title}|${l.variantTitle ?? ""}`;

const ADDRESSES = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id shippingAddress { address1 address2 city zip provinceCode countryCodeV2 formatted(withName: false, withCompany: true) } }
    }
  }`;

const norm = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const addressKey = (a) => (a ? [a.address1, a.address2, a.city, a.zip, a.provinceCode, a.countryCodeV2].map(norm).join("|") : null);

const viewForMerge = (s) => ({
  id: s.id,
  orderId: s.orderId,
  orderName: s.orderName,
  orderNumber: s.orderId.split("/").pop(),
  orderCreatedAt: s.orderCreatedAt.toISOString(),
  part: s.partCount > 1 ? `${s.partIndex} of ${s.partCount}` : null,
  state: s.state,
  waitingReason: s.waitingReason,
  releaseDay: s.releaseDay ?? null,
  shippingMethod: s.shippingMethod,
  customerName: s.customerName,
  lines: linesOf(s).map((l) => ({
    id: l.foLineItemId,
    key: itemKey(l),
    title: l.title,
    variantTitle: l.variantTitle,
    sku: l.sku,
    imageUrl: l.imageUrl,
    quantity: l.quantity,
  })),
});

// Groups of open, unbatched orders for the same customer and address, with at
// least one ready to ship (it can be the main order). Oldest first.
export async function mergeCandidates(shop, admin, { limit = 60 } = {}) {
  const rows = await db.shipment.findMany({
    where: { shop, state: { in: ["waiting", "ready"] }, batchId: null, mergeGroupId: null, customerId: { not: null } },
    orderBy: [{ orderCreatedAt: "asc" }, { id: "asc" }],
    take: 20000,
  });
  const byCustomer = new Map();
  for (const s of rows) byCustomer.set(s.customerId, [...(byCustomer.get(s.customerId) ?? []), s]);
  let groups = [...byCustomer.values()].filter((g) => new Set(g.map((s) => s.orderId)).size > 1 && g.some((s) => s.state === "ready"));
  groups = groups.slice(0, limit);

  // Their addresses (needs Shopify's customer data access; without it, by customer only)
  const orderIds = [...new Set(groups.flat().map((s) => s.orderId))];
  const addr = new Map();
  let addressesChecked = true;
  try {
    if (isSandboxShop(shop)) throw new Error("sandbox");
    for (let i = 0; i < orderIds.length; i += 100) {
      const data = await gql(admin, ADDRESSES, { ids: orderIds.slice(i, i + 100) });
      for (const n of data?.nodes ?? []) if (n?.id) addr.set(n.id, n.shippingAddress ?? null);
    }
    // No addresses at all back: Shopify isn't sharing them (customer data access)
    if (orderIds.length && !addr.size) addressesChecked = false;
  } catch {
    addressesChecked = false;
  }
  const out = [];
  for (const g of groups) {
    const byAddress = new Map();
    for (const s of g) {
      const a = addr.get(s.orderId) ?? null;
      const k = addressesChecked ? addressKey(a) ?? `none:${s.orderId}` : "unchecked";
      const x = byAddress.get(k) ?? { address: a?.formatted ?? null, shipments: [] };
      x.shipments.push(s);
      byAddress.set(k, x);
    }
    for (const [k, x] of byAddress) {
      if (new Set(x.shipments.map((s) => s.orderId)).size < 2 || !x.shipments.some((s) => s.state === "ready")) continue;
      out.push({
        key: `${g[0].customerId}|${k}`,
        customerName: x.shipments[0].customerName,
        address: x.address,
        shipments: x.shipments.map(viewForMerge),
      });
    }
  }
  return { groups: out, addressesChecked };
}

// Merges that haven't shipped yet (and recent ones), for the tab
export async function listMerges(shop) {
  const rows = await db.mergeGroup.findMany({ where: { shop, status: { in: ["open", "shipped", "cancelled"] } }, orderBy: { id: "desc" }, take: 50 });
  const mains = await db.shipment.findMany({ where: { id: { in: rows.map((r) => r.mainShipmentId) } }, select: { id: true, state: true, batchId: true, orderId: true } });
  const byId = new Map(mains.map((m) => [m.id, m]));
  return rows.map((g) => {
    const m = byId.get(g.mainShipmentId);
    return {
      id: g.id,
      status: g.status,
      mainOrderName: g.mainOrderName,
      mainOrderId: m?.orderId ?? null,
      mainState: m?.state ?? null,
      batchId: m?.batchId ?? null,
      method: g.method,
      error: g.error,
      createdBy: g.createdBy,
      createdAt: g.createdAt.toISOString(),
      shippedAt: g.shippedAt?.toISOString() ?? null,
      riders: json(g.riders, []).map((r) => ({ orderName: r.orderName, items: r.lines.reduce((n, l) => n + l.quantity, 0), done: Boolean(r.done), lines: r.lines.map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity })) })),
      canUndo: g.status === "open" && Boolean(m) && (m.state === "ready" || m.state === "waiting" || m.state === "batched"),
    };
  });
}

// main: the shipment that goes in whole (must be ready, not in a batch).
// riders: [{ shipmentId, lineIds: [fulfillment order line item ids] }]. method: the box's shipping method.
export async function createMerge(shop, { mainShipmentId, riders, method = null }, user) {
  const main = await db.shipment.findFirst({ where: { shop, id: Number(mainShipmentId) } });
  if (!main) throw new ShippingError("That order couldn't be found. Refresh the page.");
  if (main.state !== "ready" || main.batchId) throw new ShippingError(`${main.orderName} has to be ready to ship and not in a batch yet to be the main order.`);
  if (main.mergeGroupId) throw new ShippingError(`${main.orderName} is already in a merge.`);
  const chosen = (riders ?? []).filter((r) => r?.lineIds?.length);
  if (!chosen.length) throw new ShippingError("Tick at least one item from another order to put in the box.");
  const riderRows = [];
  for (const r of chosen) {
    const s = await db.shipment.findFirst({ where: { shop, id: Number(r.shipmentId) } });
    if (!s || !["waiting", "ready"].includes(s.state) || s.batchId) throw new ShippingError(`${s?.orderName ?? "An order"} is no longer open and unbatched. Refresh the page.`);
    if (s.mergeGroupId) throw new ShippingError(`${s.orderName} is already in a merge.`);
    if (s.id === main.id || s.orderId === main.orderId) throw new ShippingError("Pick items from other orders.");
    if (!s.customerId || s.customerId !== main.customerId) throw new ShippingError(`${s.orderName} is for a different customer.`);
    const want = new Set(r.lineIds.map(String));
    const lines = linesOf(s).filter((l) => want.has(String(l.foLineItemId)));
    if (lines.length !== want.size) throw new ShippingError(`Some items of ${s.orderName} changed. Refresh the page.`);
    riderRows.push({ s, lines });
  }
  const mergedLines = riderRows.flatMap(({ s, lines }) => lines.map((l) => ({ ...l, fromOrderName: s.orderName, fromShipmentId: s.id })));
  const ridersJson = riderRows.map(({ s, lines }) => ({ shipmentId: s.id, orderId: s.orderId, orderName: s.orderName, fulfillmentOrderId: s.fulfillmentOrderId, lines, done: false }));
  const group = await db.mergeGroup.create({
    data: { shop, mainShipmentId: main.id, mainOrderName: main.orderName, method: method ? String(method).slice(0, 120) : null, riders: JSON.stringify(ridersJson), createdBy: user?.name ?? null },
  });
  // Claim them (if someone else got there first, undo)
  const m = await db.shipment.updateMany({
    where: { id: main.id, state: "ready", batchId: null, mergeGroupId: null },
    data: { mergeGroupId: group.id, mergedLines: JSON.stringify(mergedLines), mergeMethod: group.method },
  });
  const r = await db.shipment.updateMany({
    where: { id: { in: riderRows.map(({ s }) => s.id) }, state: { in: ["waiting", "ready"] }, batchId: null, mergeGroupId: null },
    data: { mergeGroupId: group.id, mergedInto: main.orderName },
  });
  if (!m.count || r.count !== riderRows.length) {
    await db.shipment.updateMany({ where: { mergeGroupId: group.id }, data: { mergeGroupId: null, mergedLines: null, mergedInto: null, mergeMethod: null } });
    await db.mergeGroup.update({ where: { id: group.id }, data: { status: "undone", error: "Changed while merging" } });
    throw new ShippingError("One of these orders changed a moment ago. Refresh and try again.");
  }
  const items = mergedLines.reduce((n, l) => n + l.quantity, 0);
  await logEvent(shop, {
    shipmentId: main.id,
    orderName: main.orderName,
    type: "orders_merged",
    detail: `${main.orderName} ships with ${items} item${items === 1 ? "" : "s"} from ${riderRows.map(({ s }) => s.orderName).join(", ")}${group.method ? ` · ${group.method}` : ""}`,
    user,
  });
  return { id: group.id, mainOrderName: main.orderName, items };
}

// Undo a merge before its box is packed
export async function undoMerge(shop, groupId, user) {
  const g = await db.mergeGroup.findFirst({ where: { shop, id: Number(groupId) } });
  if (!g || g.status !== "open") throw new ShippingError("That merge is already finished.");
  const main = await db.shipment.findFirst({ where: { id: g.mainShipmentId } });
  if (main && !["ready", "waiting", "batched"].includes(main.state)) throw new ShippingError(`${g.mainOrderName} is already packed; it ships as one box now.`);
  await db.shipment.updateMany({ where: { mergeGroupId: g.id }, data: { mergeGroupId: null, mergedLines: null, mergedInto: null, mergeMethod: null } });
  await db.mergeGroup.update({ where: { id: g.id }, data: { status: "undone" } });
  await logEvent(shop, { shipmentId: g.mainShipmentId, orderName: g.mainOrderName, type: "orders_unmerged", detail: `${g.mainOrderName}: the other orders' items ship on their own again`, user });
  kick(shop);
}

const TRACKING = `#graphql
  query ($id: ID!) {
    fulfillmentOrder(id: $id) { id status fulfillments(first: 5) { nodes { id trackingInfo { company number url } } } }
  }`;

const FULFILL = `#graphql
  mutation ($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }`;

// After each refresh: merged boxes whose main order has shipped → fulfill the other
// orders' items with the same tracking. Main order cancelled → the merge ends.
export async function shipMergedBoxes(shop, admin) {
  const open = await db.mergeGroup.findMany({ where: { shop, status: "open" } });
  const done = [];
  for (const g of open) {
    const main = await db.shipment.findFirst({ where: { id: g.mainShipmentId } });
    if (!main || main.state === "closed") {
      await db.shipment.updateMany({ where: { mergeGroupId: g.id }, data: { mergeGroupId: null, mergedInto: null } });
      await db.mergeGroup.update({ where: { id: g.id }, data: { status: "cancelled", error: `${g.mainOrderName} was cancelled or closed in Shopify` } });
      await logEvent(shop, { orderName: g.mainOrderName, type: "orders_unmerged", detail: `${g.mainOrderName} was cancelled or closed: the other orders ship on their own`, user: { name: null } });
      continue;
    }
    if (main.state !== "shipped") continue;
    const sandbox = isSandboxShop(shop);
    let tracking = null;
    if (!sandbox) {
      const data = await gql(admin, TRACKING, { id: main.fulfillmentOrderId }).catch(() => null);
      const t = (data?.fulfillmentOrder?.fulfillments?.nodes ?? []).flatMap((f) => f.trackingInfo ?? []).find((x) => x?.number);
      tracking = t ? { company: t.company ?? undefined, number: t.number, url: t.url ?? undefined } : null;
    }
    const riders = json(g.riders, []);
    const errors = [];
    for (const r of riders) {
      if (r.done) continue;
      const s = await db.shipment.findFirst({ where: { id: r.shipmentId } });
      try {
        if (!sandbox && s) {
          if (s.appHoldId) await releaseHold(admin, s);
          const res = await gql(admin, FULFILL, {
            fulfillment: {
              lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: r.fulfillmentOrderId, fulfillmentOrderLineItems: r.lines.map((l) => ({ id: l.foLineItemId, quantity: l.quantity })) }],
              notifyCustomer: true,
              ...(tracking ? { trackingInfo: tracking } : {}),
            },
          });
          const errs = res?.fulfillmentCreate?.userErrors ?? [];
          if (errs.length || !res?.fulfillmentCreate?.fulfillment) throw new Error(errs.map((e) => e.message).join("; ") || "Shopify didn't make the fulfillment");
        }
        r.done = true;
        // What's left of that order ships on its own (or it's all gone)
        if (s) {
          const shippedIds = new Set(r.lines.map((l) => String(l.foLineItemId)));
          const left = linesOf(s)
            .map((l) => (shippedIds.has(String(l.foLineItemId)) ? { ...l, quantity: l.quantity - (r.lines.find((x) => String(x.foLineItemId) === String(l.foLineItemId))?.quantity ?? 0) } : l))
            .filter((l) => l.quantity > 0);
          await db.shipment.update({
            where: { id: s.id },
            data: left.length
              ? { mergeGroupId: null, mergedInto: null, appHoldId: null, lines: JSON.stringify(left), units: left.reduce((n, l) => n + l.quantity, 0) }
              : { mergeGroupId: null, mergedInto: null, appHoldId: null, state: "shipped", closedAt: new Date(), waitingReason: `Shipped in ${g.mainOrderName}'s box` },
          });
        }
        await logEvent(shop, {
          shipmentId: r.shipmentId,
          orderName: r.orderName,
          type: "merged_shipped",
          detail: `${r.lines.reduce((n, l) => n + l.quantity, 0)} item(s) shipped in ${g.mainOrderName}'s box${tracking?.number ? ` · tracking ${tracking.number}` : ""}`,
          user: { name: null },
        });
      } catch (e) {
        errors.push(`${r.orderName}: ${e.message}`);
      }
    }
    const allDone = riders.every((r) => r.done);
    await db.mergeGroup.update({
      where: { id: g.id },
      data: { riders: JSON.stringify(riders), status: allDone ? "shipped" : "open", shippedAt: allDone ? new Date() : null, error: errors.length ? errors.join(" · ").slice(0, 500) : null },
    });
    if (allDone) done.push(g.id);
  }
  if (done.length) kick(shop);
  return { shipped: done };
}

onAfterRun(async (shop, admin, step) => {
  step("Merged boxes");
  await shipMergedBoxes(shop, admin);
});
