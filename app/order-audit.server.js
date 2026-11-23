// An order's history in MonkeyBean: who picked, packed and shipped each part,
// its batch, scan overrides, packing videos and every logged event. Shown in
// every order flyout (Shipping, order lookup, tickets).
//
// Shopify's own timeline names the app ("MonkeyBean"), not the person; this is
// where the person is.
import db from "./db.server";
import { signLink } from "./packcam.server";

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const iso = (d) => (d ? new Date(d).toISOString() : null);
const batchTitle = (b) => (b ? (b.name ? `${b.tag} · ${b.name}` : b.tag) : null);

// Plain words for each logged event
export const EVENT_LABELS = {
  package: "Package chosen at the pack bench",
  package_settings: "Package settings changed",
  packed: "Packed",
  packed_override: "Packed without a full scan",
  pack_visual: "Item matched by photo at the pack bench",
  flow_picked: "Picked",
  unpacked: "Unpacked",
  label_bought: "Label bought",
  label_failed: "Label failed",
  labels_bulk: "Labels bought in bulk",
  bulk_labels_override: "Bulk labels: checks overridden",
  batch_created: "Batch created",
  batch_added: "Added to a batch",
  batch_removed: "Removed from a batch",
  batch_cancelled: "Batch cancelled",
  batch_assigned: "Batch assigned",
  batch_priority: "Batch priority changed",
  batch_renamed: "Batch renamed",
  batch_picked: "Batch picked",
  batch_pick_reopened: "Batch pick reopened",
  batch_completed: "Batch packed",
  batch_done: "Batch done",
  auto_batch: "Batched automatically",
  ship_outside_batch: "Let through outside a batch",
  outside_batch_cleared: "Outside-batch permission removed",
  ready_before_release: "Marked ready before release",
  address_kept: "Flagged address kept",
  address_changed: "Shipping address changed",
  notice_ack: "Order note / address warning acknowledged",
  notice_ack_pack: "Order note / address warning acknowledged at the pack bench",
  orders_merged: "Orders combined into one box",
  orders_unmerged: "Combined box undone",
  boxes_planned: "Boxes planned",
  merged_shipped: "Shipped in another order's box",
  order_flagged: "Flagged for review",
  flag_resolved: "Review flag resolved",
  flag_reopened: "Review flag reopened",
  order_resync: "Re-read from Shopify",
  pack_clip: "Customer video clip",
  hold_mode: "Hold mode changed",
};
// Batch-wide events worth showing on each of its orders
const BATCH_EVENTS = ["batch_created", "batch_assigned", "batch_priority", "batch_renamed", "batch_picked", "batch_pick_reopened", "batch_completed", "batch_done", "batch_cancelled", "labels_bulk", "bulk_labels_override"];
// Scan or check overrides: shown as warnings
const OVERRIDE_EVENTS = new Set(["packed_override", "pack_visual", "ship_outside_batch", "ready_before_release", "bulk_labels_override", "address_kept"]);

const PRIORITY = ["Low", "Normal", "High", "Urgent"];

// The link a staff member can watch a packing video with (2 hours)
const videoUrl = (v, shop, appOrigin) => (appOrigin ? `${String(appOrigin).replace(/\/+$/, "")}/packcam/media?t=${signLink({ k: "rec", id: v.id, shop }, 2 * 60 * 60_000)}` : null);

export async function orderAudit(shop, { orderId = null, orderName = null } = {}, { appOrigin = null, canVideo = false } = {}) {
  if (!orderId && !orderName) return null;
  const shipments = await db.shipment.findMany({
    where: { shop, ...(orderId ? { orderId: String(orderId) } : { orderName: String(orderName) }) },
    orderBy: [{ partIndex: "asc" }, { id: "asc" }],
  });
  const name = orderName ?? shipments[0]?.orderName ?? null;
  const ids = shipments.map((s) => s.id);
  const batchIds = [...new Set(shipments.map((s) => s.batchId).filter(Boolean))];

  const [batches, events, videos] = await Promise.all([
    batchIds.length ? db.batch.findMany({ where: { shop, id: { in: batchIds } } }) : [],
    db.shippingEvent.findMany({
      where: {
        shop,
        OR: [
          ...(ids.length ? [{ shipmentId: { in: ids } }] : []),
          ...(name ? [{ orderName: name }] : []),
          ...(batchIds.length ? [{ batchId: { in: batchIds }, shipmentId: null, type: { in: BATCH_EVENTS } }] : []),
        ],
      },
      orderBy: { id: "desc" },
      take: 300,
    }),
    ids.length ? db.packVideo.findMany({ where: { shop, shipmentId: { in: ids } }, orderBy: { id: "desc" } }) : [],
  ]);
  const clips = videos.length ? await db.packClip.findMany({ where: { shop, packVideoId: { in: videos.map((v) => v.id) } }, orderBy: { id: "desc" } }) : [];
  const batchOf = new Map(batches.map((b) => [b.id, b]));
  // Never the same event twice (e.g. matched by both shipment and order name)
  const seen = new Set();
  const evs = events.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));

  const parts = shipments.map((s) => {
    const b = s.batchId ? batchOf.get(s.batchId) : null;
    const mine = evs.filter((e) => e.shipmentId === s.id);
    const lastOf = (...types) => mine.find((e) => types.includes(e.type));
    // Picked: the batch's pick list, or this package in flow mode
    const flow = lastOf("flow_picked");
    const picked = flow
      ? { by: flow.userName, at: iso(flow.createdAt), how: "flow" }
      : b?.pickedAt
        ? { by: b.pickedBy, at: iso(b.pickedAt), how: "batch" }
        : null;
    const packed = s.packedAt || s.packedBy ? { by: s.packedBy, at: iso(s.packedAt) } : null;
    const labelEv = lastOf("label_bought");
    const merged = lastOf("merged_shipped");
    const shipped =
      s.labelStatus === "bought"
        ? { by: s.labelBoughtBy ?? labelEv?.userName ?? null, at: iso(s.labelBoughtAt ?? labelEv?.createdAt), how: "label", detail: labelEv?.detail ?? null }
        : merged
          ? { by: merged.userName, at: iso(merged.createdAt), how: "merged", detail: merged.detail }
          : s.state === "shipped" || s.state === "closed"
            ? { by: null, at: iso(s.closedAt), how: "shopify", detail: "Fulfilled in Shopify (not through MonkeyBean)" }
            : null;
    const overrides = [];
    if (s.packOverride) {
      const i = s.packOverride.indexOf(":");
      overrides.push({ kind: "Packed without a full scan", by: i > 0 ? s.packOverride.slice(0, i).trim() : null, reason: i > 0 ? s.packOverride.slice(i + 1).trim() : s.packOverride, at: iso(s.packedAt) });
    }
    if (s.overrideBy || s.overrideReason) overrides.push({ kind: "Let through outside a batch", by: s.overrideBy, reason: s.overrideReason, at: iso(s.overrideAt) });
    for (const e of mine.filter((e) => OVERRIDE_EVENTS.has(e.type) && e.type !== "packed_override" && e.type !== "ship_outside_batch"))
      overrides.push({ kind: EVENT_LABELS[e.type] ?? e.type, by: e.userName, reason: e.detail, at: iso(e.createdAt) });
    const vids = videos
      .filter((v) => v.shipmentId === s.id)
      .map((v) => ({
        id: v.id,
        status: v.status,
        by: v.userName,
        at: iso(v.doneAt ?? v.createdAt),
        seconds: v.seconds,
        error: v.status === "failed" ? v.error : null,
        url: canVideo && v.status === "done" && v.driveFileId ? videoUrl(v, shop, appOrigin) : null,
        clips: clips
          .filter((c) => c.packVideoId === v.id)
          .map((c) => ({ id: c.id, status: c.status, at: iso(c.createdAt), seconds: Math.round((c.endSeconds - c.startSeconds) * 10) / 10 })),
      }));
    return {
      id: s.id,
      part: s.partIndex,
      state: s.state,
      batch: b
        ? { id: b.id, title: batchTitle(b), status: b.status, createdBy: b.createdBy, createdAt: iso(b.createdAt), priority: PRIORITY[b.priority] ?? null }
        : s.batchTag
          ? { id: null, title: s.batchTag, status: null }
          : null,
      picked,
      packed,
      shipped,
      overrides,
      videos: vids,
    };
  });

  const history = evs.map((e) => ({
    id: e.id,
    at: iso(e.createdAt),
    type: e.type,
    label: EVENT_LABELS[e.type] ?? e.type.replace(/_/g, " "),
    detail: e.detail,
    by: e.userName,
    part: e.shipmentId ? (shipments.find((s) => s.id === e.shipmentId)?.partIndex ?? null) : null,
    batch: e.batchId && !e.shipmentId ? batchTitle(batchOf.get(e.batchId)) : null,
    override: OVERRIDE_EVENTS.has(e.type),
  }));

  return { orderName: name, parts, history, multiPart: shipments.length > 1 };
}
