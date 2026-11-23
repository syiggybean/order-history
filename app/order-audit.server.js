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
  reship_created: "Reship order created",
  reship_of: "This is a reship",
  return_started: "Return started",
  return_approved: "Return request approved",
  return_declined: "Return request declined",
  return_verified: "Return verified (package arrived)",
  hold_mode: "Hold mode changed",
};
// Batch-wide events worth showing on each of its orders
const BATCH_EVENTS = ["batch_created", "batch_assigned", "batch_priority", "batch_renamed", "batch_picked", "batch_pick_reopened", "batch_completed", "batch_done", "batch_cancelled", "labels_bulk", "bulk_labels_override"];
// Scan or check overrides: shown as warnings
const OVERRIDE_EVENTS = new Set(["packed_override", "pack_visual", "ship_outside_batch", "ready_before_release", "bulk_labels_override", "address_kept"]);

const PRIORITY = ["Low", "Normal", "High", "Urgent"];
const itemKey = (l) => l.variantId ?? `title:${l.title}|${l.variantTitle ?? ""}`;
const itemName = (l) => `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`;

// Each item in a box and whether it was scanned. Scans are counted per product
// across the whole box (its own items, other orders' items it carried, freebies),
// so an item counts as scanned when every unit of that product in the box was.
function scanned(box, lines) {
  const counts = json(box.packed, {});
  const all = [...json(box.lines, []), ...json(box.mergedLines, []), ...json(box.freebieLines, [])];
  const need = {};
  for (const l of all) need[itemKey(l)] = (need[itemKey(l)] ?? 0) + (l.quantity ?? 0);
  // Packed at MonkeyBean's pack bench (someone scanned, or chose to skip scanning)
  const packedHere = Boolean(box.packedAt || box.packedBy);
  const gone = box.state === "shipped" || box.state === "closed";
  return lines.map((l) => {
    const k = itemKey(l);
    const got = Math.min(counts[k] ?? 0, need[k] ?? 0);
    const full = got > 0 && got >= (need[k] ?? 0);
    return {
      name: itemName(l),
      quantity: l.quantity,
      scan: full ? "scanned" : got > 0 ? "partly" : packedHere ? "not_scanned" : gone ? "outside" : null,
    };
  });
}

// The box a part went out in when it was combined with another order's
async function carrierOf(shop, s) {
  const groups = await db.mergeGroup.findMany({ where: { shop, riders: { contains: `"shipmentId":${s.id}` } }, orderBy: { id: "desc" } });
  for (const g of groups) {
    const r = json(g.riders, []).find((x) => Number(x.shipmentId) === s.id);
    if (r && g.status !== "undone" && g.status !== "cancelled") return { g, r };
  }
  return null;
}

// The link a staff member can watch a packing video with (2 hours)
const videoUrl = (v, shop, appOrigin) => (appOrigin ? `${String(appOrigin).replace(/\/+$/, "")}/packcam/media?t=${signLink({ k: "rec", id: v.id, shop }, 2 * 60 * 60_000)}` : null);

// Closed fulfillment orders with no fulfillment on them: Shopify closed them
// with nothing shipped (items moved to another part, cancelled, removed)
const FO_SENT = `#graphql
  query AuditFulfillmentOrders($ids: [ID!]!) {
    nodes(ids: $ids) { ... on FulfillmentOrder { id status fulfillments(first: 1) { nodes { id } } } }
  }`;
async function nothingSentIds(admin, shipments) {
  const ids = shipments.filter((s) => (s.state === "shipped" || s.state === "closed") && s.labelStatus !== "bought" && !s.packedAt && s.fulfillmentOrderId).map((s) => s.fulfillmentOrderId);
  if (!admin || !ids.length) return new Set();
  try {
    const res = await admin.graphql(FO_SENT, { variables: { ids: ids.slice(0, 50) } });
    const nodes = (await res.json())?.data?.nodes ?? [];
    return new Set(nodes.filter((n) => n?.id && n.status === "CLOSED" && !(n.fulfillments?.nodes ?? []).length).map((n) => n.id));
  } catch (e) {
    console.error("[order-audit] fulfillment orders:", e?.message ?? e);
    return new Set();
  }
}

export async function orderAudit(shop, { orderId = null, orderName = null } = {}, { appOrigin = null, canVideo = false, admin = null } = {}) {
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

  // Who did what to one box: its batch, pick, pack, ship, overrides, videos
  const describe = (box, boxEvents, b, boxVideos, boxClips) => {
    const lastOf = (...types) => boxEvents.find((e) => types.includes(e.type));
    // Picked: the batch's pick list, or this package in flow mode
    const flow = lastOf("flow_picked");
    const picked = flow
      ? { by: flow.userName, at: iso(flow.createdAt), how: "flow" }
      : b?.pickedAt
        ? { by: b.pickedBy, at: iso(b.pickedAt), how: "batch" }
        : null;
    const packed = box.packedAt || box.packedBy ? { by: box.packedBy, at: iso(box.packedAt) } : null;
    const labelEv = lastOf("label_bought");
    const shipped =
      box.labelStatus === "bought"
        ? { by: box.labelBoughtBy ?? labelEv?.userName ?? null, at: iso(box.labelBoughtAt ?? labelEv?.createdAt), how: "label", detail: labelEv?.detail ?? null }
        : box.state === "shipped" || box.state === "closed"
          ? { by: null, at: iso(box.closedAt), how: "shopify", detail: "Fulfilled in Shopify (not through MonkeyBean)" }
          : null;
    const overrides = [];
    if (box.packOverride) {
      const i = box.packOverride.indexOf(":");
      overrides.push({ kind: "Packed without a full scan", scan: true, by: i > 0 ? box.packOverride.slice(0, i).trim() : null, reason: i > 0 ? box.packOverride.slice(i + 1).trim() : box.packOverride, at: iso(box.packedAt) });
    }
    if (box.overrideBy || box.overrideReason) overrides.push({ kind: "Let through outside a batch", scan: false, by: box.overrideBy, reason: box.overrideReason, at: iso(box.overrideAt) });
    for (const e of boxEvents.filter((e) => OVERRIDE_EVENTS.has(e.type) && e.type !== "packed_override" && e.type !== "ship_outside_batch"))
      overrides.push({ kind: EVENT_LABELS[e.type] ?? e.type, scan: e.type === "pack_visual", by: e.userName, reason: e.detail, at: iso(e.createdAt) });
    return {
      batch: b
        ? { id: b.id, title: batchTitle(b), status: b.status, createdBy: b.createdBy, createdAt: iso(b.createdAt), priority: PRIORITY[b.priority] ?? null }
        : box.batchTag
          ? { id: null, title: box.batchTag, status: null }
          : null,
      picked,
      packed,
      shipped,
      overrides,
      videos: boxVideos.map((v) => ({
        id: v.id,
        status: v.status,
        by: v.userName,
        at: iso(v.doneAt ?? v.createdAt),
        seconds: v.seconds,
        error: v.status === "failed" ? v.error : null,
        url: canVideo && v.status === "done" && v.driveFileId ? videoUrl(v, shop, appOrigin) : null,
        clips: boxClips
          .filter((c) => c.packVideoId === v.id)
          .map((c) => ({ id: c.id, status: c.status, at: iso(c.createdAt), seconds: Math.round((c.endSeconds - c.startSeconds) * 10) / 10 })),
      })),
    };
  };

  const emptyFOs = await nothingSentIds(admin, shipments);
  const parts = [];
  for (const s of shipments) {
    const mine = evs.filter((e) => e.shipmentId === s.id);
    const own = describe(s, mine, s.batchId ? batchOf.get(s.batchId) : null, videos.filter((v) => v.shipmentId === s.id), clips);
    // Went out in another order's box: that box's people, this part's items
    const merged = mine.find((e) => e.type === "merged_shipped");
    const carrier = !s.mergedLines && (merged || s.mergedInto || s.mergeGroupId) ? await carrierOf(shop, s) : null;
    if (carrier) {
      const main = await db.shipment.findFirst({ where: { shop, id: carrier.g.mainShipmentId } });
      if (main) {
        const [mainEvents, mainBatch, mainVideos] = await Promise.all([
          db.shippingEvent.findMany({ where: { shop, shipmentId: main.id }, orderBy: { id: "desc" }, take: 100 }),
          main.batchId ? db.batch.findFirst({ where: { shop, id: main.batchId } }) : null,
          db.packVideo.findMany({ where: { shop, shipmentId: main.id }, orderBy: { id: "desc" } }),
        ]);
        const mainClips = mainVideos.length ? await db.packClip.findMany({ where: { shop, packVideoId: { in: mainVideos.map((v) => v.id) } } }) : [];
        const box = describe(main, mainEvents, mainBatch, mainVideos, mainClips);
        parts.push({
          id: s.id,
          part: s.partIndex,
          state: s.state,
          fulfillmentOrderId: s.fulfillmentOrderId,
          ...box,
          // This part's own overrides, and the box's
          overrides: [...own.overrides, ...box.overrides],
          // Sent automatically when the main box shipped
          shipped: box.shipped ?? (merged ? { by: merged.userName, at: iso(merged.createdAt), how: "merged", detail: null } : null),
          inBox: { orderName: main.orderName, orderId: main.orderId, done: s.state === "shipped" || s.state === "closed" },
          items: scanned(main, carrier.r.lines ?? json(s.lines, [])),
          carried: [],
        });
        continue;
      }
    }
    // Closed in Shopify with nothing shipped from it
    if (s.fulfillmentOrderId && emptyFOs.has(s.fulfillmentOrderId) && !merged) {
      parts.push({ id: s.id, part: s.partIndex, state: s.state, nothingSent: true, closedAt: iso(s.closedAt), batch: null, picked: null, packed: null, shipped: null, overrides: [], videos: [], inBox: null, items: [], carried: [] });
      continue;
    }
    // Other orders' items this box carried
    const carriedLines = json(s.mergedLines, []);
    const carried = [...new Set(carriedLines.map((l) => l.fromOrderName))].map((name) => {
      const ls = carriedLines.filter((l) => l.fromOrderName === name);
      return { orderName: name, orderId: null, shipmentId: ls[0]?.fromShipmentId ?? null, items: scanned(s, ls) };
    });
    for (const c of carried) {
      if (!c.shipmentId) continue;
      const r = await db.shipment.findFirst({ where: { shop, id: c.shipmentId }, select: { orderId: true } });
      c.orderId = r?.orderId ?? null;
    }
    parts.push({
      id: s.id,
      part: s.partIndex,
      state: s.state,
      fulfillmentOrderId: s.fulfillmentOrderId,
      ...own,
      shipped:
        own.shipped?.how === "label" || !merged ? own.shipped : { by: merged.userName, at: iso(merged.createdAt), how: "merged", detail: merged.detail },
      inBox: null,
      items: [...scanned(s, json(s.lines, [])), ...scanned(s, json(s.freebieLines, [])).map((it) => ({ ...it, name: `${it.name} (free gift)` }))],
      carried,
    });
  }

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
