// Returns: customer-requested (Shopify's self-serve returns) and staff-started
// returns, tracked in MonkeyBean so staff can approve requests, see what's on
// its way back, and verify each item when the package arrives.
//
// Shopify keeps the return itself; MonkeyBean keeps a copy (ReturnCase) plus
// what the verifier found. Verifying an item:
//   Resellable  → back into stock (Shopify "restocked" at the return location)
//   Damaged     → recorded, not restocked
//   Wrong item  → the item we expected didn't come back: recorded as missing
//   Missing     → recorded as missing
// Refunds stay in Shopify (not part of this).
//
// Needs Shopify's read_returns and write_returns permissions.
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { logEvent } from "./shipping.server";

export class ReturnsError extends Error {}

import { CONDITIONS, DECLINE_REASONS, RETURN_REASONS, STAGES } from "./returns";
export { CONDITIONS, DECLINE_REASONS, RETURN_REASONS, STAGES };

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const iso = (d) => (d ? new Date(d).toISOString() : null);

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const body = await res.json();
  if (body?.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("; ");
    const e = new ReturnsError(/access denied|read_returns|write_returns|not approved/i.test(msg) ? "MonkeyBean doesn't have Shopify's returns permission yet. Approve the app's updated permissions in Shopify." : `Shopify: ${msg}`);
    e.denied = /access denied|read_returns|write_returns|not approved/i.test(msg);
    throw e;
  }
  return body.data;
}

const userErrors = (r) => {
  const errs = r?.userErrors ?? [];
  if (errs.length) throw new ReturnsError(errs.map((x) => x.message).join("; "));
};

// ---------------------------------------------------------------------------
// Reading returns from Shopify
// ---------------------------------------------------------------------------

const RETURN_FIELDS = `
  id name status createdAt requestApprovedAt closedAt totalQuantity
  decline { reason note }
  returnLineItems(first: 50) {
    nodes {
      id quantity
      ... on ReturnLineItem {
        returnReasonNote customerNote
        returnReasonDefinition { name }
        fulfillmentLineItem { id lineItem { id title variantTitle sku variant { id } image { url(transform: { maxWidth: 80 }) } } }
      }
    }
  }
  reverseFulfillmentOrders(first: 5) {
    nodes {
      id status
      lineItems(first: 50) { nodes { id totalQuantity dispositions { type quantity } fulfillmentLineItem { id } } }
    }
  }`;

const ORDER_RETURNS = `#graphql
  query MonkeyBeanOrderReturns($id: ID!) {
    order(id: $id) {
      id name customer { displayName }
      returns(first: 20) { nodes { ${RETURN_FIELDS} } }
    }
  }`;

const ACTIVE = `#graphql
  query MonkeyBeanActiveReturns($q: String!, $after: String) {
    orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes { id name customer { displayName } returns(first: 10) { nodes { ${RETURN_FIELDS} } } }
    }
  }`;

const RETURN_ONE = `#graphql
  query MonkeyBeanReturn($id: ID!) {
    return(id: $id) { ${RETURN_FIELDS} order { id name customer { displayName } } }
  }`;

const itemsOf = (r) =>
  (r.returnLineItems?.nodes ?? []).map((n) => {
    const li = n.fulfillmentLineItem?.lineItem;
    return {
      returnLineItemId: n.id,
      fulfillmentLineItemId: n.fulfillmentLineItem?.id ?? null,
      lineItemId: li?.id ?? null,
      variantId: li?.variant?.id ?? null,
      title: li?.title ?? "Item",
      variantTitle: li?.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : null,
      sku: li?.sku ?? null,
      image: li?.image?.url ?? null,
      quantity: n.quantity,
      reason: n.returnReasonDefinition?.name ?? null,
      reasonNote: n.returnReasonNote || null,
      customerNote: n.customerNote || null,
    };
  });

// Reverse fulfillment order lines, matched to return lines by fulfillment line item
const rfoLinesOf = (r) =>
  (r.reverseFulfillmentOrders?.nodes ?? []).flatMap((o) =>
    (o.lineItems?.nodes ?? []).map((l) => ({
      id: l.id,
      fulfillmentLineItemId: l.fulfillmentLineItem?.id ?? null,
      total: l.totalQuantity,
      disposed: (l.dispositions ?? []).reduce((n, d) => n + d.quantity, 0),
    })),
  );

// Save one Shopify return. A return first seen as REQUESTED came from the
// customer; one MonkeyBean made is marked staff (set when it's created).
async function upsert(shop, order, r) {
  const status = String(r.status ?? "").toLowerCase();
  const existing = await db.returnCase.findFirst({ where: { shop, shopifyReturnId: r.id } });
  const data = {
    name: r.name ?? null,
    orderId: order.id,
    orderName: order.name,
    customerName: order.customer?.displayName ?? null,
    status,
    totalQuantity: r.totalQuantity ?? 0,
    items: JSON.stringify(itemsOf(r)),
    rfoLines: JSON.stringify(rfoLinesOf(r)),
    declineNote: r.decline ? [r.decline.reason, r.decline.note].filter(Boolean).join(": ") : null,
    requestedAt: r.createdAt ? new Date(r.createdAt) : null,
    approvedAt: r.requestApprovedAt ? new Date(r.requestApprovedAt) : null,
    closedAt: r.closedAt ? new Date(r.closedAt) : null,
    syncedAt: new Date(),
  };
  if (existing) return db.returnCase.update({ where: { id: existing.id }, data });
  return db.returnCase.create({ data: { shop, shopifyReturnId: r.id, source: status === "requested" ? "customer" : "shopify", ...data } });
}

// One order's returns, read now (when its flyout opens)
export async function syncOrderReturns(shop, admin, orderId) {
  const o = (await gql(admin, ORDER_RETURNS, { id: orderId }))?.order;
  if (!o) return [];
  for (const r of o.returns?.nodes ?? []) await upsert(shop, o, r);
  return listReturns(shop, { orderId });
}

// Every active return (requested, in progress, being inspected), plus any we
// hold as active that Shopify has since closed, declined or cancelled
export async function syncReturns(shop, admin) {
  const seen = new Set();
  let after = null;
  for (let page = 0; page < 6; page++) {
    const data = await gql(admin, ACTIVE, { q: "return_status:return_requested OR return_status:in_progress OR return_status:inspection_complete", after });
    for (const o of data?.orders?.nodes ?? []) {
      for (const r of o.returns?.nodes ?? []) {
        await upsert(shop, o, r);
        seen.add(r.id);
      }
    }
    if (!data?.orders?.pageInfo?.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  const stale = await db.returnCase.findMany({ where: { shop, status: { in: ["requested", "open"] } } });
  for (const c of stale) {
    if (seen.has(c.shopifyReturnId)) continue;
    const r = (await gql(admin, RETURN_ONE, { id: c.shopifyReturnId }).catch(() => null))?.return;
    if (r) await upsert(shop, r.order, r);
  }
  await db.returnSync.upsert({ where: { shop }, create: { shop, lastRunAt: new Date(), lastError: null }, update: { lastRunAt: new Date(), lastError: null } });
}

export async function syncNow(shop, admin) {
  try {
    await syncReturns(shop, admin);
  } catch (e) {
    await db.returnSync
      .upsert({ where: { shop }, create: { shop, lastError: String(e?.message ?? e).slice(0, 500) }, update: { lastError: String(e?.message ?? e).slice(0, 500), lastRunAt: new Date() } })
      .catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// What staff see: requested → awaiting arrival → verified, or closed/declined/cancelled
export const stageOf = (c) =>
  c.status === "requested" ? "requested" : c.status === "declined" ? "declined" : c.status === "canceled" || c.status === "cancelled" ? "cancelled" : c.verifiedAt ? "verified" : c.status === "closed" ? "closed" : "awaiting";
export const returnView = (c) => {
  const items = json(c.items, []);
  const found = json(c.conditions, []);
  return {
    id: c.id,
    shopifyReturnId: c.shopifyReturnId,
    name: c.name,
    orderId: c.orderId,
    orderName: c.orderName,
    orderNumber: c.orderId?.split("/").pop() ?? null,
    customerName: c.customerName,
    stage: stageOf(c),
    stageLabel: STAGES[stageOf(c)],
    source: c.source,
    sourceLabel: c.source === "customer" ? "Customer request" : c.source === "staff" ? `Started by ${c.createdBy ?? "staff"}` : "Created in Shopify",
    reason: c.reason,
    note: c.note,
    totalQuantity: c.totalQuantity,
    items: items.map((it) => ({ ...it, found: found.filter((f) => f.returnLineItemId === it.returnLineItemId) })),
    requestedAt: iso(c.requestedAt ?? c.createdAt),
    approvedAt: iso(c.approvedAt),
    approvedBy: c.approvedBy,
    declineNote: c.declineNote,
    verifiedAt: iso(c.verifiedAt),
    verifiedBy: c.verifiedBy,
    verifyNote: c.verifyNote,
    restocked: c.restockedUnits ?? 0,
    closedAt: iso(c.closedAt),
  };
};

export async function listReturns(shop, { stage = null, q = "", orderId = null, take = 100 } = {}) {
  const where = { shop };
  if (orderId) where.orderId = orderId;
  const t = String(q ?? "").trim().replace(/^#/, "");
  if (t) where.OR = [{ orderName: { contains: t, mode: "insensitive" } }, { customerName: { contains: t, mode: "insensitive" } }, { name: { contains: t, mode: "insensitive" } }];
  const rows = await db.returnCase.findMany({ where, orderBy: { id: "desc" }, take: stage ? 500 : take });
  const list = rows.map(returnView);
  return stage ? list.filter((r) => (stage === "done" ? ["verified", "closed", "declined", "cancelled"].includes(r.stage) : r.stage === stage)).slice(0, take) : list;
}

export async function returnCounts(shop) {
  const rows = await db.returnCase.findMany({ where: { shop, status: { in: ["requested", "open"] } }, select: { status: true, verifiedAt: true } });
  return {
    requested: rows.filter((r) => r.status === "requested").length,
    awaiting: rows.filter((r) => r.status === "open" && !r.verifiedAt).length,
  };
}

export async function returnStatus(shop) {
  const s = await db.returnSync.findFirst({ where: { shop } });
  return { lastRunAt: iso(s?.lastRunAt), lastError: s?.lastError ?? null };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function caseOr404(shop, id) {
  const c = await db.returnCase.findFirst({ where: { shop, id: Number(id) } });
  if (!c) throw new ReturnsError("That return isn't there anymore. Refresh the list.");
  return c;
}

async function refresh(shop, admin, c) {
  const r = (await gql(admin, RETURN_ONE, { id: c.shopifyReturnId }))?.return;
  if (r) await upsert(shop, r.order, r);
  return returnView(await db.returnCase.findFirst({ where: { id: c.id } }));
}

export async function approveReturn(shop, admin, id, user, { notifyCustomer = true } = {}) {
  const c = await caseOr404(shop, id);
  if (c.status !== "requested") throw new ReturnsError("Only requested returns can be approved.");
  const data = await gql(admin, `#graphql
    mutation MonkeyBeanApprove($input: ReturnApproveRequestInput!) { returnApproveRequest(input: $input) { return { id status } userErrors { field message } } }`, { input: { id: c.shopifyReturnId, notifyCustomer: Boolean(notifyCustomer) } });
  userErrors(data?.returnApproveRequest);
  await db.returnCase.update({ where: { id: c.id }, data: { approvedBy: user?.name ?? null } });
  await logEvent(shop, { orderName: c.orderName, type: "return_approved", detail: `${c.name ?? "Return"} approved`, user });
  return refresh(shop, admin, c);
}

export async function declineReturn(shop, admin, id, user, { reason = "OTHER", note = "", notifyCustomer = true } = {}) {
  const c = await caseOr404(shop, id);
  if (c.status !== "requested") throw new ReturnsError("Only requested returns can be declined.");
  if (!DECLINE_REASONS[reason]) throw new ReturnsError("Choose why it's declined.");
  const declineNote = String(note ?? "").trim().slice(0, 500);
  if (reason === "OTHER" && !declineNote) throw new ReturnsError("Add a note for the customer saying why.");
  const data = await gql(admin, `#graphql
    mutation MonkeyBeanDecline($input: ReturnDeclineRequestInput!) { returnDeclineRequest(input: $input) { return { id status } userErrors { field message } } }`, {
    input: { id: c.shopifyReturnId, declineReason: reason, ...(declineNote ? { declineNote } : {}), notifyCustomer: Boolean(notifyCustomer) },
  });
  userErrors(data?.returnDeclineRequest);
  await logEvent(shop, { orderName: c.orderName, type: "return_declined", detail: `${c.name ?? "Return"} declined: ${DECLINE_REASONS[reason]}${declineNote ? ` (${declineNote})` : ""}`, user });
  return refresh(shop, admin, c);
}

// What an order has that can still be returned (shipped and not already returned)
const RETURNABLE = `#graphql
  query MonkeyBeanReturnable($id: ID!) {
    order(id: $id) {
      id name customer { displayName }
      returnableFulfillments(first: 20) {
        nodes {
          returnableFulfillmentLineItems(first: 50) {
            nodes { quantity fulfillmentLineItem { id lineItem { id title variantTitle sku image { url(transform: { maxWidth: 80 }) } } } }
          }
        }
      }
    }
  }`;

export async function returnableItems(shop, admin, orderId) {
  const o = (await gql(admin, RETURNABLE, { id: orderId }))?.order;
  if (!o) throw new ReturnsError("That order isn't in Shopify.");
  const items = (o.returnableFulfillments?.nodes ?? []).flatMap((f) =>
    (f.returnableFulfillmentLineItems?.nodes ?? [])
      .filter((n) => n.quantity > 0 && n.fulfillmentLineItem)
      .map((n) => {
        const li = n.fulfillmentLineItem.lineItem;
        return {
          fulfillmentLineItemId: n.fulfillmentLineItem.id,
          title: li?.title ?? "Item",
          variantTitle: li?.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : null,
          sku: li?.sku ?? null,
          image: li?.image?.url ?? null,
          quantity: n.quantity,
        };
      }),
  );
  return { orderId: o.id, orderName: o.name, items, reasons: RETURN_REASONS };
}

// A staff-started return: open (approved) straight away
export async function startReturn(shop, admin, { orderId, items, reason, note = "", notifyCustomer = false }, user) {
  const why = String(reason ?? "").trim();
  if (!RETURN_REASONS.includes(why)) throw new ReturnsError("Choose why it's being returned.");
  const extra = String(note ?? "").trim().slice(0, 500);
  if (why === "Other" && !extra) throw new ReturnsError("Add a note saying why it's being returned.");
  const can = await returnableItems(shop, admin, orderId);
  const byId = new Map(can.items.map((i) => [i.fulfillmentLineItemId, i]));
  const lines = [];
  for (const it of items ?? []) {
    const r = byId.get(String(it.fulfillmentLineItemId));
    const q = Math.floor(Number(it.quantity));
    if (!r || !(q > 0)) continue;
    if (q > r.quantity) throw new ReturnsError(`${r.title}: only ${r.quantity} can be returned.`);
    lines.push({ r, q });
  }
  if (!lines.length) throw new ReturnsError("Choose at least one item to return.");
  const reasonNote = `${why}${extra ? `: ${extra}` : ""}`.slice(0, 255);
  const data = await gql(admin, `#graphql
    mutation MonkeyBeanStartReturn($input: ReturnInput!) { returnCreate(returnInput: $input) { return { id name } userErrors { field message } } }`, {
    input: {
      orderId,
      returnLineItems: lines.map(({ r, q }) => ({ fulfillmentLineItemId: r.fulfillmentLineItemId, quantity: q, returnReasonNote: reasonNote })),
      notifyCustomer: Boolean(notifyCustomer),
    },
  });
  userErrors(data?.returnCreate);
  const made = data?.returnCreate?.return;
  if (!made) throw new ReturnsError("Shopify didn't make the return.");
  const r = (await gql(admin, RETURN_ONE, { id: made.id }))?.return;
  const saved = r ? await upsert(shop, r.order, r) : null;
  const c = saved
    ? await db.returnCase.update({ where: { id: saved.id }, data: { source: "staff", createdBy: user?.name ?? null, reason: why, note: extra || null } })
    : await db.returnCase.create({ data: { shop, shopifyReturnId: made.id, name: made.name, orderId, orderName: can.orderName, status: "open", source: "staff", createdBy: user?.name ?? null, reason: why, note: extra || null, items: "[]" } });
  await logEvent(shop, { orderName: can.orderName, type: "return_started", detail: `${made.name ?? "Return"}: ${lines.map(({ r, q }) => `${q} × ${r.title}`).join(", ")} · ${why}${extra ? ` (${extra})` : ""}`, user });
  return returnView(c);
}

// The location restocked items go back to: the store's primary location
const LOCATION = `#graphql
  query MonkeyBeanReturnLocation { location { id name } }`;

// The package arrived: what came back, item by item.
// found: [{ returnLineItemId, condition, quantity }]
export async function verifyReturn(shop, admin, id, { found, note = "" }, user) {
  const c = await caseOr404(shop, id);
  if (c.status === "requested") throw new ReturnsError("Approve the request first.");
  if (["declined", "canceled", "cancelled"].includes(c.status)) throw new ReturnsError("This return was declined or cancelled.");
  if (c.verifiedAt) throw new ReturnsError(`Already verified by ${c.verifiedBy ?? "staff"}.`);
  // Read it fresh: what's still waiting for a decision in Shopify
  const r = (await gql(admin, RETURN_ONE, { id: c.shopifyReturnId }))?.return;
  if (!r) throw new ReturnsError("Shopify can't find this return.");
  const items = itemsOf(r);
  const rfo = rfoLinesOf(r);
  // Every unit of every item needs a condition
  const counted = new Map();
  for (const f of found ?? []) {
    if (!CONDITIONS[f.condition]) throw new ReturnsError("Choose a condition for every item.");
    const q = Math.floor(Number(f.quantity));
    if (!(q > 0)) continue;
    counted.set(f.returnLineItemId, [...(counted.get(f.returnLineItemId) ?? []), { condition: f.condition, quantity: q }]);
  }
  const plan = [];
  for (const it of items) {
    const got = counted.get(it.returnLineItemId) ?? [];
    const n = got.reduce((t, g) => t + g.quantity, 0);
    if (n !== it.quantity) throw new ReturnsError(`${it.title}: give a condition for all ${it.quantity} (you've marked ${n}).`);
    const line = rfo.find((l) => l.fulfillmentLineItemId === it.fulfillmentLineItemId);
    if (!line) throw new ReturnsError(`${it.title}: Shopify hasn't set this item up to be received yet. Try again in a minute.`);
    const open = line.total - line.disposed;
    if (open < n) throw new ReturnsError(`${it.title}: Shopify already has a decision for ${line.disposed} of ${line.total}.`);
    for (const g of got) plan.push({ it, line, ...g });
  }
  const needsLocation = plan.some((p) => CONDITIONS[p.condition].restock);
  const location = needsLocation ? (await gql(admin, LOCATION, {}))?.location : null;
  if (needsLocation && !location?.id) throw new ReturnsError("Couldn't find the store's location to restock to.");
  const data = await gql(admin, `#graphql
    mutation MonkeyBeanVerify($inputs: [ReverseFulfillmentOrderDisposeInput!]!) {
      reverseFulfillmentOrderDispose(dispositionInputs: $inputs) { reverseFulfillmentOrderLineItems { id } userErrors { field message } }
    }`, {
    inputs: plan.map((p) => ({
      reverseFulfillmentOrderLineItemId: p.line.id,
      quantity: p.quantity,
      dispositionType: CONDITIONS[p.condition].disposition,
      ...(CONDITIONS[p.condition].restock ? { locationId: location.id } : {}),
    })),
  });
  userErrors(data?.reverseFulfillmentOrderDispose);
  const restocked = plan.filter((p) => CONDITIONS[p.condition].restock).reduce((t, p) => t + p.quantity, 0);
  const extra = String(note ?? "").trim().slice(0, 1000);
  await db.returnCase.update({
    where: { id: c.id },
    data: {
      verifiedAt: new Date(),
      verifiedBy: user?.name ?? null,
      verifyNote: extra || null,
      conditions: JSON.stringify(plan.map((p) => ({ returnLineItemId: p.it.returnLineItemId, condition: p.condition, quantity: p.quantity }))),
      restockedUnits: restocked,
      restockLocation: location?.name ?? null,
    },
  });
  const summary = plan.map((p) => `${p.quantity} × ${p.it.title}: ${CONDITIONS[p.condition].label.toLowerCase()}`).join(", ");
  await logEvent(shop, { orderName: c.orderName, type: "return_verified", detail: `${c.name ?? "Return"}: ${summary}${restocked ? ` · ${restocked} restocked${location?.name ? ` at ${location.name}` : ""}` : ""}${extra ? ` · ${extra}` : ""}`, user });
  return refresh(shop, admin, c);
}

// ---------------------------------------------------------------------------
// Every 10 minutes: pick up new requests and changes
// ---------------------------------------------------------------------------

if (!globalThis.__returnsTimer && process.env.NODE_ENV !== "test") {
  const tick = async () => {
    const sessions = await db.session.findMany({ where: { isOnline: false }, select: { shop: true } });
    for (const shop of new Set(sessions.map((x) => x.shop))) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        await syncNow(shop, admin);
      } catch (e) {
        if (!e?.denied) console.error(`[returns] ${shop}:`, e?.message ?? e);
      }
    }
  };
  globalThis.__returnsTimer = setInterval(() => tick().catch(() => {}), 10 * 60 * 1000);
  setTimeout(() => tick().catch(() => {}), 2 * 60 * 1000);
}
