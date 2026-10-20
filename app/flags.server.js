import db from "./db.server";
import { ShippingError, logEvent } from "./shipping.server";

// ---------------------------------------------------------------------------
// Order flags: anyone with the Flag/Review switch can mark an order as having
// an issue for the team to look at, then resolve it once it's sorted.
// While an order has an open flag, auto-batching leaves it alone.
// ---------------------------------------------------------------------------

export const FLAG_REASONS = [
  "Address problem",
  "Possible fraud",
  "Customer contacted us",
  "Item or stock problem",
  "Payment problem",
  "Other",
];

const view = (f) => ({
  id: f.id,
  orderId: f.orderId,
  orderName: f.orderName,
  orderNumber: f.orderId.split("/").pop(),
  reason: f.reason,
  note: f.note,
  status: f.status,
  createdBy: f.createdBy,
  createdAt: f.createdAt.toISOString(),
  resolvedBy: f.resolvedBy,
  resolvedAt: f.resolvedAt?.toISOString() ?? null,
  resolution: f.resolution,
});

export async function flagOrder(shop, { orderId, orderName }, reason, note, user) {
  if (!orderId || !orderName) throw new ShippingError("Which order?");
  const r = String(reason ?? "").trim();
  if (!FLAG_REASONS.includes(r)) throw new ShippingError("Pick a reason.");
  const n = String(note ?? "").trim().slice(0, 1000) || null;
  if (r === "Other" && !n) throw new ShippingError('Add a note saying what the issue is.');
  const f = await db.orderFlag.create({
    data: { shop, orderId, orderName, reason: r, note: n, createdBy: user?.name ?? null },
  });
  await logEvent(shop, { orderName, type: "order_flagged", detail: `${r}${n ? `: ${n}` : ""}`, user });
  return view(f);
}

export async function resolveFlag(shop, id, resolution, user) {
  const f = await db.orderFlag.findFirst({ where: { shop, id: Number(id) } });
  if (!f) throw new ShippingError("That flag couldn't be found.");
  if (f.status !== "open") throw new ShippingError("That flag is already resolved.");
  const what = String(resolution ?? "").trim().slice(0, 1000);
  if (!what) throw new ShippingError('Say what was done, e.g. "Address corrected with the customer".');
  const done = await db.orderFlag.update({
    where: { id: f.id },
    data: { status: "resolved", resolvedBy: user?.name ?? null, resolvedAt: new Date(), resolution: what },
  });
  await logEvent(shop, { orderName: f.orderName, type: "flag_resolved", detail: `${f.reason}: ${what}`, user });
  return view(done);
}

export async function reopenFlag(shop, id, user) {
  const f = await db.orderFlag.findFirst({ where: { shop, id: Number(id) } });
  if (!f || f.status === "open") throw new ShippingError("That flag isn't resolved.");
  await db.orderFlag.update({ where: { id: f.id }, data: { status: "open", resolvedBy: null, resolvedAt: null, resolution: null } });
  await logEvent(shop, { orderName: f.orderName, type: "flag_reopened", detail: f.reason, user });
}

export async function flagsForOrder(shop, orderId) {
  const rows = await db.orderFlag.findMany({ where: { shop, orderId }, orderBy: { id: "desc" } });
  return rows.map(view).sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
}

// The Review tab. Each flag comes with how the hub sees the order's shipments.
export async function listFlags(shop, { status = "open" } = {}) {
  const rows = await db.orderFlag.findMany({
    where: { shop, status: status === "resolved" ? "resolved" : "open" },
    orderBy: status === "resolved" ? { resolvedAt: "desc" } : { createdAt: "asc" },
    take: 300,
  });
  const orderIds = [...new Set(rows.map((r) => r.orderId))];
  const shipments = orderIds.length
    ? await db.shipment.findMany({ where: { shop, orderId: { in: orderIds } }, select: { orderId: true, state: true, partIndex: true, partCount: true, batchId: true } })
    : [];
  const byOrder = new Map();
  for (const s of shipments) byOrder.set(s.orderId, [...(byOrder.get(s.orderId) ?? []), s]);
  return rows.map((f) => ({
    ...view(f),
    shipments: (byOrder.get(f.orderId) ?? [])
      .sort((a, b) => a.partIndex - b.partIndex)
      .map((s) => ({ state: s.state, part: s.partCount > 1 ? `${s.partIndex} of ${s.partCount}` : null, inBatch: Boolean(s.batchId) })),
  }));
}

export const openFlagCount = (shop) => db.orderFlag.count({ where: { shop, status: "open" } });
