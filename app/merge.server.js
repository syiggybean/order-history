import db from "./db.server";
import { gql } from "./preorders.server";
import { ShippingError, isSandboxShop, kick, linesOf, logEvent, onAfterRun, releaseHold, syncOrder } from "./shipping.server";

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
// Same place written two ways ("123 Main Street, Apt 4" / "123 main st #4", ZIP+4 or not)
// gives the same key
const WORDS = {
  street: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", place: "pl", circle: "cir",
  highway: "hwy", parkway: "pkwy", terrace: "ter", square: "sq", trail: "trl", way: "wy",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  apartment: "apt", unit: "apt", suite: "apt", ste: "apt", number: "apt", no: "apt", floor: "fl", building: "bldg",
};
const streetKey = (a) =>
  norm(`${a.address1 ?? ""} ${a.address2 ?? ""}`.replace(/#/g, " apt "))
    .split(" ")
    .map((w) => WORDS[w] ?? w)
    .filter((w, i, all) => !(w === "apt" && all[i + 1] === "apt"))
    .join(" ");
const addressKey = (a) =>
  a ? [streetKey(a), norm(a.city), String(a.zip ?? "").replace(/\s+/g, "").slice(0, 5).toLowerCase(), norm(a.provinceCode), norm(a.countryCodeV2)].join("|") : null;

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
        customerId: g[0].customerId,
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

// ---------------------------------------------------------------------------
// Box planner: a customer's open orders, arranged into boxes any way the person
// likes (ready or not). An order whose items go into several boxes is split in
// Shopify (one fulfillment order per box); a box with several orders becomes a
// merge (label on one of them, the others fulfilled with its tracking).
// ---------------------------------------------------------------------------

const PLANNABLE = ["waiting", "ready"];

// Customers by name (or an order number), with their open and recent orders counted
export async function searchCustomers(shop, q) {
  const text = String(q ?? "").trim();
  if (text.length < 2) return [];
  const num = text.replace(/^#/, "");
  const rows = await db.shipment.findMany({
    where: {
      shop,
      customerId: { not: null },
      OR: [{ customerName: { contains: text, mode: "insensitive" } }, ...(/^\d+$/.test(num) ? [{ orderName: `#${num}` }, { orderName: num }] : [])],
    },
    select: { customerId: true, customerName: true, orderId: true, state: true, orderCreatedAt: true },
    orderBy: { orderCreatedAt: "desc" },
    take: 2000,
  });
  const by = new Map();
  for (const r of rows) {
    const c = by.get(r.customerId) ?? { customerId: r.customerId, name: r.customerName, open: new Set(), orders: new Set(), lastOrderAt: r.orderCreatedAt.toISOString() };
    c.orders.add(r.orderId);
    if (PLANNABLE.includes(r.state) || ["batched", "packed", "labeling"].includes(r.state)) c.open.add(r.orderId);
    by.set(r.customerId, c);
  }
  return [...by.values()]
    .map((c) => ({ customerId: c.customerId, name: c.name, openOrders: c.open.size, orders: c.orders.size, lastOrderAt: c.lastOrderAt }))
    .sort((a, b) => b.openOrders - a.openOrders || b.lastOrderAt.localeCompare(a.lastOrderAt))
    .slice(0, 20);
}

const planLine = (s, l) => ({
  shipmentId: s.id,
  id: l.foLineItemId,
  key: itemKey(l),
  title: l.title,
  variantTitle: l.variantTitle,
  sku: l.sku,
  imageUrl: l.imageUrl,
  quantity: l.quantity,
});

// One customer: their open shipments (as boxes today), what can't be changed, and history
export async function customerPlan(shop, admin, customerId) {
  const all = await db.shipment.findMany({ where: { shop, customerId: String(customerId) }, orderBy: [{ orderCreatedAt: "asc" }, { id: "asc" }] });
  if (!all.length) return null;
  const open = all.filter((s) => PLANNABLE.includes(s.state) && !s.batchId);
  const groups = await db.mergeGroup.findMany({ where: { shop, status: "open", mainShipmentId: { in: all.map((s) => s.id) } } });
  const groupOf = new Map(groups.map((g) => [g.id, g]));
  // Merges whose box is already in a batch (or packed) can't be re-planned here
  const lockedGroups = new Set(groups.filter((g) => all.find((s) => s.id === g.mainShipmentId && s.batchId)).map((g) => g.id));
  const plannable = open.filter((s) => !(s.mergeGroupId && lockedGroups.has(s.mergeGroupId)));

  // Addresses, so boxes don't mix two addresses
  const addr = new Map();
  let addressesChecked = false;
  if (!isSandboxShop(shop) && plannable.length) {
    try {
      const ids = [...new Set(plannable.map((s) => s.orderId))];
      for (let i = 0; i < ids.length; i += 100) {
        const data = await gql(admin, ADDRESSES, { ids: ids.slice(i, i + 100) });
        for (const n of data?.nodes ?? []) if (n?.id) addr.set(n.id, n.shippingAddress ?? null);
      }
      addressesChecked = addr.size > 0;
    } catch {
      addressesChecked = false;
    }
  }

  // Today's boxes: each shipment on its own, merges together
  const boxes = [];
  const boxOfGroup = new Map();
  for (const s of plannable) {
    if (s.mergeGroupId && groupOf.has(s.mergeGroupId)) {
      if (!boxOfGroup.has(s.mergeGroupId)) {
        boxOfGroup.set(s.mergeGroupId, boxes.length);
        const g = groupOf.get(s.mergeGroupId);
        boxes.push({ lines: [], labelShipmentId: g.mainShipmentId, method: g.method ?? null, mergeId: g.id });
      }
      // The box's own items (not the copies it carries for the others)
      boxes[boxOfGroup.get(s.mergeGroupId)].lines.push(...linesOf(s).map((l) => planLine(s, l)));
    } else boxes.push({ lines: linesOf(s).map((l) => planLine(s, l)), labelShipmentId: s.id, method: s.shippingMethod ?? null, mergeId: null });
  }
  const orders = new Map();
  for (const s of plannable) {
    const a = addr.get(s.orderId) ?? null;
    orders.set(s.id, {
      shipmentId: s.id,
      orderId: s.orderId,
      orderName: s.orderName,
      orderNumber: s.orderId.split("/").pop(),
      orderCreatedAt: s.orderCreatedAt.toISOString(),
      state: s.state,
      waitingReason: s.waitingReason,
      releaseDay: s.releaseDay ?? null,
      shippingMethod: s.shippingMethod,
      otherHold: s.otherHold,
      address: a?.formatted ?? null,
      addressKey: addressesChecked ? addressKey(a) : null,
    });
  }
  const inWork = all.filter((s) => (["batched", "packed", "labeling"].includes(s.state) || (PLANNABLE.includes(s.state) && s.batchId)) || (s.mergeGroupId && lockedGroups.has(s.mergeGroupId) && !s.batchId));
  const history = all
    .filter((s) => ["shipped", "closed"].includes(s.state))
    .sort((a, b) => b.orderCreatedAt - a.orderCreatedAt)
    .slice(0, 15);
  const brief = (s) => ({
    shipmentId: s.id,
    orderId: s.orderId,
    orderName: s.orderName,
    orderNumber: s.orderId.split("/").pop(),
    orderCreatedAt: s.orderCreatedAt.toISOString(),
    state: s.state,
    reason: s.waitingReason,
    closedAt: s.closedAt?.toISOString() ?? null,
    items: linesOf(s).map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity })),
  });
  return {
    customerId: String(customerId),
    name: all[0].customerName,
    addressesChecked,
    orders: [...orders.values()],
    boxes,
    inWork: inWork.map(brief),
    history: history.map(brief),
  };
}

const SPLIT = `#graphql
  mutation ($splits: [FulfillmentOrderSplitInput!]!) {
    fulfillmentOrderSplit(fulfillmentOrderSplits: $splits) {
      fulfillmentOrderSplits {
        fulfillmentOrder { id lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } } }
        remainingFulfillmentOrder { id lineItems(first: 50) { nodes { id remainingQuantity lineItem { id } } } }
      }
      userErrors { field message }
    }
  }`;

const sameContents = (fo, want) => {
  const have = new Map();
  for (const n of fo?.lineItems?.nodes ?? []) if (n.remainingQuantity > 0) have.set(n.lineItem?.id, (have.get(n.lineItem?.id) ?? 0) + n.remainingQuantity);
  if (have.size !== want.size) return false;
  for (const [k, q] of want) if (have.get(k) !== q) return false;
  return true;
};

// boxes: [{ items: [{ shipmentId, id (fulfillment order line item), quantity }], labelShipmentId, method }]
// Every item of every shipment in the plan must be in exactly one box.
export async function saveBoxes(shop, admin, { customerId, boxes }, user) {
  const plan = (boxes ?? []).map((b) => ({ ...b, items: (b.items ?? []).filter((i) => Number(i.quantity) > 0) })).filter((b) => b.items.length);
  if (!plan.length) throw new ShippingError("Put the items in at least one box.");
  const ids = [...new Set(plan.flatMap((b) => b.items.map((i) => Number(i.shipmentId))))];
  const ships = await db.shipment.findMany({ where: { shop, id: { in: ids } } });
  if (ships.length !== ids.length) throw new ShippingError("Some of these orders changed. Reload the customer.");
  for (const s of ships) {
    if (s.customerId !== String(customerId)) throw new ShippingError(`${s.orderName} is for a different customer.`);
    if (!PLANNABLE.includes(s.state) || s.batchId) throw new ShippingError(`${s.orderName} is in a batch or on its way already. Reload the customer.`);
    if (s.otherHold) throw new ShippingError(`${s.orderName} is on hold in Shopify (${s.otherHold}). Release that hold first.`);
  }
  // Every item placed once, in full
  for (const s of ships) {
    for (const l of linesOf(s)) {
      const placed = plan.flatMap((b) => b.items).filter((i) => Number(i.shipmentId) === s.id && String(i.id) === String(l.foLineItemId)).reduce((n, i) => n + Number(i.quantity), 0);
      if (placed !== l.quantity) throw new ShippingError(`${l.quantity} × ${l.title} (${s.orderName}): put all of them in boxes (${placed} placed).`);
    }
  }
  // One address per box (when Shopify shares addresses)
  if (!isSandboxShop(shop)) {
    const orderIds = [...new Set(ships.map((s) => s.orderId))];
    const addr = new Map();
    try {
      for (let i = 0; i < orderIds.length; i += 100) {
        const data = await gql(admin, ADDRESSES, { ids: orderIds.slice(i, i + 100) });
        for (const n of data?.nodes ?? []) if (n?.id) addr.set(n.id, addressKey(n.shippingAddress));
      }
    } catch {
      // not shared: the page warned about it
    }
    for (const [i, b] of plan.entries()) {
      const keys = new Set(b.items.map((it) => addr.get(ships.find((s) => s.id === Number(it.shipmentId)).orderId)).filter(Boolean));
      if (keys.size > 1 && !b.sameAddress) throw new ShippingError(`Box ${i + 1} has orders going to different addresses.`);
    }
  }

  // Merges being re-planned: undone first (the plan says how they ship now)
  const oldGroups = [...new Set(ships.map((s) => s.mergeGroupId).filter(Boolean))];
  for (const gid of oldGroups) {
    const g = await db.mergeGroup.findFirst({ where: { shop, id: gid, status: "open" } });
    if (!g) continue;
    await db.shipment.updateMany({ where: { mergeGroupId: g.id }, data: { mergeGroupId: null, mergedLines: null, mergedInto: null, mergeMethod: null } });
    await db.mergeGroup.update({ where: { id: g.id }, data: { status: "undone" } });
  }

  // Split shipments whose items go into more than one box
  const sandbox = isSandboxShop(shop);
  const foOf = new Map(); // `${boxIndex}:${shipmentId}` -> fulfillment order id
  const splitOrders = new Set();
  const notes = [];
  for (const s of ships) {
    const parts = plan
      .map((b, bi) => ({ bi, items: b.items.filter((i) => Number(i.shipmentId) === s.id) }))
      .filter((p) => p.items.length);
    if (parts.length === 1) {
      foOf.set(`${parts[0].bi}:${s.id}`, s.fulfillmentOrderId);
      continue;
    }
    const lines = linesOf(s);
    const lineItemOf = new Map(lines.map((l) => [String(l.foLineItemId), l.lineItemId]));
    if (sandbox) {
      // Practice copy: split in the app only
      for (const [n, p] of parts.entries()) {
        const want = p.items.map((i) => ({ ...lines.find((l) => String(l.foLineItemId) === String(i.id)), quantity: Number(i.quantity) }));
        if (n === 0) {
          await db.shipment.update({ where: { id: s.id }, data: { lines: JSON.stringify(want), units: want.reduce((a, l) => a + l.quantity, 0) } });
          foOf.set(`${p.bi}:${s.id}`, s.fulfillmentOrderId);
        } else {
          const foId = `${s.fulfillmentOrderId}-split-${Date.now()}-${n}`;
          const { id: _id, createdAt: _c, updatedAt: _u, mergeGroupId: _m, mergedLines: _ml, mergedInto: _mi, mergeMethod: _mm, ...rest } = s;
          await db.shipment.create({ data: { ...rest, fulfillmentOrderId: foId, lines: JSON.stringify(want), units: want.reduce((a, l) => a + l.quantity, 0) } });
          foOf.set(`${p.bi}:${s.id}`, foId);
        }
      }
    } else {
      if (s.appHoldId) await releaseHold(admin, s);
      // Split one part off at a time; the last part keeps what's left
      let current = { id: s.fulfillmentOrderId, ids: new Map(lines.map((l) => [l.lineItemId, String(l.foLineItemId)])) };
      for (const p of parts.slice(1)) {
        const want = new Map();
        for (const i of p.items) {
          const li = lineItemOf.get(String(i.id));
          want.set(li, (want.get(li) ?? 0) + Number(i.quantity));
        }
        const data = await gql(admin, SPLIT, {
          splits: [{ fulfillmentOrderId: current.id, fulfillmentOrderLineItems: [...want].map(([li, q]) => ({ id: current.ids.get(li), quantity: q })) }],
        });
        const errs = data?.fulfillmentOrderSplit?.userErrors ?? [];
        const r = data?.fulfillmentOrderSplit?.fulfillmentOrderSplits?.[0];
        if (errs.length || !r) throw new ShippingError(`Shopify couldn't split ${s.orderName}: ${errs.map((e) => e.message).join("; ") || "no answer"}`);
        const pair = [r.fulfillmentOrder, r.remainingFulfillmentOrder].filter(Boolean);
        const mine = pair.find((fo) => sameContents(fo, want)) ?? r.fulfillmentOrder;
        const rest = pair.find((fo) => fo.id !== mine.id) ?? r.remainingFulfillmentOrder;
        foOf.set(`${p.bi}:${s.id}`, mine.id);
        current = { id: rest.id, ids: new Map((rest.lineItems?.nodes ?? []).map((n) => [n.lineItem?.id, n.id])) };
      }
      foOf.set(`${parts[0].bi}:${s.id}`, current.id);
      splitOrders.add(s.orderId);
    }
    notes.push(`${s.orderName} split into ${parts.length}`);
  }
  for (const orderId of splitOrders) await syncOrder(shop, admin, orderId);

  // Boxes with more than one shipment: merged (label on the chosen order)
  const merged = [];
  for (const [bi, b] of plan.entries()) {
    const sids = [...new Set(b.items.map((i) => Number(i.shipmentId)))];
    const foIds = sids.map((sid) => foOf.get(`${bi}:${sid}`));
    const rows = await db.shipment.findMany({ where: { shop, fulfillmentOrderId: { in: foIds } } });
    if (rows.length !== foIds.length) throw new ShippingError(`Box ${bi + 1}: Shopify's split didn't come back as expected. Reload the customer and check it.`);
    if (rows.length < 2) continue;
    const labelFo = b.labelShipmentId ? foOf.get(`${bi}:${Number(b.labelShipmentId)}`) : null;
    const main = rows.find((r) => r.fulfillmentOrderId === labelFo) ?? rows.find((r) => r.state === "ready") ?? rows[0];
    const riders = rows.filter((r) => r.id !== main.id);
    const mergedLines = riders.flatMap((r) => linesOf(r).map((l) => ({ ...l, fromOrderName: r.orderName, fromShipmentId: r.id })));
    const g = await db.mergeGroup.create({
      data: {
        shop,
        mainShipmentId: main.id,
        mainOrderName: main.orderName,
        method: b.method ? String(b.method).slice(0, 120) : null,
        riders: JSON.stringify(riders.map((r) => ({ shipmentId: r.id, orderId: r.orderId, orderName: r.orderName, fulfillmentOrderId: r.fulfillmentOrderId, lines: linesOf(r), done: false }))),
        createdBy: user?.name ?? null,
      },
    });
    await db.shipment.update({ where: { id: main.id }, data: { mergeGroupId: g.id, mergedLines: JSON.stringify(mergedLines), mergeMethod: g.method } });
    await db.shipment.updateMany({ where: { id: { in: riders.map((r) => r.id) } }, data: { mergeGroupId: g.id, mergedInto: main.orderName } });
    merged.push(`${main.orderName} + ${riders.map((r) => r.orderName).join(", ")}`);
  }
  await logEvent(shop, {
    orderName: ships[0].orderName,
    type: "boxes_planned",
    detail: `${ships[0].customerName ?? "Customer"}: ${plan.length} box${plan.length === 1 ? "" : "es"}${notes.length ? ` · ${notes.join(", ")}` : ""}${merged.length ? ` · together: ${merged.join("; ")}` : ""}`,
    user,
  });
  kick(shop, 500);
  return { boxes: plan.length, splits: notes, merged };
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
