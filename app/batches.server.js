import { createHash } from "node:crypto";
import db from "./db.server";
import { PACKED_TAG, bulkLabelQuery } from "./pack.server";
import { dayInStore, errorMessage, gql, TIME_ZONE, todayInStore } from "./preorders.server";
import { pushBins, syncAllBins } from "./bins-sync.server";
import {
  ShippingError,
  getShippingSettings,
  kick,
  boxLinesOf,
  linesOf,
  logEvent,
  onAfterRun,
  shipmentOrder,
  shipmentWhere,
} from "./shipping.server";

// ---------------------------------------------------------------------------
// Batches: up to 250 shipments that are picked, packed and shipped together.
//
// - Shipments go in from the Ready list, by hand or by auto-batching rules.
// - Each order gets a Batch-NNNN tag in Shopify, so the batch can be found in
//   the Orders list and on Shopify's bulk label screen (250 at a time, hence the cap).
// - The pick list totals every item in the batch, sorted by bin.
// ---------------------------------------------------------------------------

export const MAX_BATCH = 250;
const EDITABLE = ["open", "picking", "picked"]; // shipments can still be added/removed
const LIVE = ["open", "picking", "picked", "packing", "packed", "shipping"];
// Unpacked shipments can still be taken out while the batch is being packed
const REMOVABLE = [...EDITABLE, "packing", "packed"];
const TAG_CHANGES_PER_RUN = 250;

// Staff live under the real shop name, also when working in sandbox
const realShop = (shop) => String(shop).replace(/::sandbox$/, "");

export const tagFor = (n) => `Batch-${String(n).padStart(4, "0")}`;

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

const lineLabel = (l) => `${l.title}${l.variantTitle ? ` – ${l.variantTitle}` : ""}`;
const itemKey = (l) => l.variantId ?? `title:${l.title}|${l.variantTitle ?? ""}`;

// ---------------------------------------------------------------------------
// Creating and changing batches
// ---------------------------------------------------------------------------

async function newBatch(shop, { name = null, source = "manual", user = null }) {
  await getShippingSettings(shop);
  const { batchCounter } = await db.shippingSettings.update({ where: { shop }, data: { batchCounter: { increment: 1 } } });
  return db.batch.create({
    data: { shop, number: batchCounter, tag: tagFor(batchCounter), name: name?.trim() || null, source, createdBy: user?.name ?? null },
  });
}

async function batchCount(batchId) {
  return db.shipment.count({ where: { batchId, state: { in: ["batched", "packed", "labeling"] } } });
}

// Moves ready shipments into a batch. Only shipments that are still ready and
// not in a batch move (someone else may have batched them a moment ago).
// from: "waiting" too for upcoming releases (batched ahead of their release date)
async function assign(shop, batch, ids, { from = ["ready"] } = {}) {
  if (!ids.length) return 0;
  const r = await db.shipment.updateMany({
    where: { shop, id: { in: ids }, state: { in: from }, batchId: null, mergedInto: null },
    data: { state: "batched", batchId: batch.id, flag: null },
  });
  return r.count;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// target: "new" or a batch id. ids: shipment ids, or filter: everything on the
// Ready list matching the filter, in the list's order (oldest first unless
// sorted newest first); limit: just the first N of those. New batches over 250 are split.
export async function addToBatch(shop, { ids = null, filter = null, limit = null, target = "new", name = null }, user) {
  let wanted;
  if (filter) {
    const rows = await db.shipment.findMany({
      where: { ...shipmentWhere(shop, { ...filter, state: "ready" }), batchId: null },
      orderBy: shipmentOrder(filter.sort),
      select: { id: true },
      ...(limit ? { take: Math.max(1, Math.floor(Number(limit))) } : {}),
    });
    wanted = rows.map((r) => r.id);
  } else {
    const rows = await db.shipment.findMany({
      where: { shop, id: { in: (ids ?? []).map(Number) }, state: "ready", batchId: null },
      orderBy: shipmentOrder("oldest"),
      select: { id: true },
    });
    wanted = rows.map((r) => r.id);
  }
  const asked = filter ? wanted.length : (ids ?? []).length;
  if (!wanted.length) throw new ShippingError("None of those shipments are on the Ready list any more.");

  const results = [];
  if (target === "new") {
    const parts = chunk(wanted, MAX_BATCH);
    for (const [i, part] of parts.entries()) {
      const label = name?.trim() ? (parts.length > 1 ? `${name.trim()} (${i + 1} of ${parts.length})` : name.trim()) : null;
      const batch = await newBatch(shop, { name: label, user });
      const added = await assign(shop, batch, part);
      results.push({ id: batch.id, number: batch.number, tag: batch.tag, name: batch.name, added });
      await logEvent(shop, { batchId: batch.id, type: "batch_created", detail: `${batch.tag}${batch.name ? ` "${batch.name}"` : ""}: ${added} shipment${added === 1 ? "" : "s"}`, user });
    }
  } else {
    const batch = await db.batch.findFirst({ where: { shop, id: Number(target) } });
    if (!batch || !EDITABLE.includes(batch.status)) throw new ShippingError("That batch can't take more shipments.");
    const room = MAX_BATCH - (await batchCount(batch.id));
    if (wanted.length > room)
      throw new ShippingError(
        `${batch.tag} has room for ${room} more (batches hold up to ${MAX_BATCH}). You picked ${wanted.length}. Make a new batch instead, or pick fewer.`,
      );
    const added = await assign(shop, batch, wanted);
    results.push({ id: batch.id, number: batch.number, tag: batch.tag, name: batch.name, added });
    await logEvent(shop, { batchId: batch.id, type: "batch_added", detail: `${added} added to ${batch.tag}`, user });
  }
  kick(shop);
  const added = results.reduce((n, b) => n + b.added, 0);
  return { batches: results, added, skipped: Math.max(0, asked - added) };
}

// Shipments back to the Ready list (readiness is re-checked on the next run)
export async function removeFromBatch(shop, batchId, shipmentIds, user) {
  const batch = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!batch) throw new ShippingError("That batch couldn't be found.");
  if (!REMOVABLE.includes(batch.status)) throw new ShippingError(`${batch.tag} has moved on; shipments can't be taken out here.`);
  const rows = await db.shipment.findMany({ where: { shop, batchId: batch.id, id: { in: shipmentIds.map(Number) }, state: "batched" } });
  if (!rows.length) return { removed: 0 };
  await db.shipment.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { state: "ready", batchId: null, flag: null } });
  await logEvent(shop, {
    batchId: batch.id,
    type: "batch_removed",
    detail: `${rows.map((r) => r.orderName).join(", ")} taken out of ${batch.tag}`,
    user,
  });
  kick(shop);
  return { removed: rows.length };
}

export async function cancelBatch(shop, batchId, user) {
  const batch = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!batch) throw new ShippingError("That batch couldn't be found.");
  if (!EDITABLE.includes(batch.status)) throw new ShippingError(`${batch.tag} is past picking and can't be cancelled here.`);
  const r = await db.shipment.updateMany({ where: { shop, batchId: batch.id, state: "batched" }, data: { state: "ready", batchId: null, flag: null } });
  await db.batch.update({ where: { id: batch.id }, data: { status: "cancelled", cancelledAt: new Date() } });
  await logEvent(shop, { batchId: batch.id, type: "batch_cancelled", detail: `${batch.tag}: ${r.count} shipment${r.count === 1 ? "" : "s"} back to Ready`, user });
  kick(shop);
  return { released: r.count };
}

// Assign a batch to one or more staff (pickers, packers). Empty list = unassigned.
export async function assignBatch(shop, batchId, staffIds, user) {
  const batch = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!batch) throw new ShippingError("That batch couldn't be found.");
  const ids = [...new Set((staffIds ?? []).map(Number).filter(Number.isFinite))];
  const staff = ids.length ? await db.staffMember.findMany({ where: { shop: realShop(shop), id: { in: ids } } }) : [];
  if (staff.length !== ids.length) throw new ShippingError("One of those people isn't on the team any more.");
  const assignees = staff.map((m) => ({ id: m.id, name: m.name ?? m.email ?? "Staff member" }));
  await db.batch.update({ where: { id: batch.id }, data: { assignees: assignees.length ? JSON.stringify(assignees) : null } });
  await logEvent(shop, {
    batchId: batch.id,
    type: "batch_assigned",
    detail: `${batch.tag}: ${assignees.length ? assignees.map((a) => a.name).join(", ") : "unassigned"}`,
    user,
  });
  return { assignees };
}

// For "Only their assigned batches": may this person open / work this batch?
export async function batchAllowed(shop, batchId, staffId) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) }, select: { assignees: true } });
  return Boolean(b) && isAssignedTo(b, staffId);
}

// Staff a batch can be assigned to: anyone with the Pick or Pack switch
export async function assignableStaff(shop) {
  const members = await db.staffMember.findMany({ where: { shop: realShop(shop) }, orderBy: { name: "asc" } });
  return members
    .map((m) => {
      const caps = m.accountOwner ? ["pick", "pack"] : (json(m.access, {})?.shipping ?? []);
      return { id: m.id, name: m.name ?? m.email ?? "Staff member", pick: caps.includes("pick"), pack: caps.includes("pack") };
    })
    .filter((m) => m.pick || m.pack);
}

// ---------------------------------------------------------------------------
// Priority: assigned pickers and packers work their highest-priority batches first
// ---------------------------------------------------------------------------

export const PRIORITIES = [
  { value: 3, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 1, label: "Normal" },
  { value: 0, label: "Low" },
];
export const priorityLabel = (p) => PRIORITIES.find((x) => x.value === p)?.label ?? "Normal";

export async function setBatchPriority(shop, batchId, priority, user) {
  const batch = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!batch) throw new ShippingError("That batch couldn't be found.");
  const p = Number(priority);
  if (!PRIORITIES.some((x) => x.value === p)) throw new ShippingError("Pick Urgent, High, Normal or Low.");
  if (p === batch.priority) return { priority: p };
  await db.batch.update({ where: { id: batch.id }, data: { priority: p } });
  await logEvent(shop, { batchId: batch.id, type: "batch_priority", detail: `${batch.tag}: ${priorityLabel(batch.priority)} → ${priorityLabel(p)}`, user });
  return { priority: p };
}

// Statuses where a batch still needs picking / packing
const TO_PICK = ["open", "picking"];
const TO_PACK = ["open", "picking", "picked", "packing"];

// Batches held for a release date (batched ahead of it): { batchId: latest release day }
async function releaseHolds(shop, batchIds, today = todayInStore()) {
  if (!batchIds.length) return new Map();
  const rows = await db.shipment.groupBy({
    by: ["batchId"],
    where: { shop, batchId: { in: batchIds }, state: "batched", releaseDay: { gt: today } },
    _max: { releaseDay: true },
  });
  return new Map(rows.map((r) => [r.batchId, r._max.releaseDay]));
}

const prettyDay = (day) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

// What stops this person picking / packing each of these batches right now:
//   - a release date still to come (unless they may pick early)
//   - a higher-priority batch assigned to them that still needs that step
//     (Urgent before High before Normal before Low; same level, any order)
// Returns Map(batchId -> { pick: reason | null, pack: reason | null, releaseDay })
export async function batchLocks(shop, batches, user, { early = false } = {}) {
  const out = new Map();
  if (!batches.length) return out;
  const staffId = user?.id ?? null;
  const mine = staffId == null ? [] : (await db.batch.findMany({ where: { shop, status: { in: TO_PACK } }, take: 1000 })).filter((b) => isAssignedTo(b, staffId));
  const holds = await releaseHolds(shop, [...new Set([...batches.map((b) => b.id), ...mine.map((b) => b.id)])]);
  const firstAbove = (b, statuses) =>
    mine
      .filter((m) => m.id !== b.id && statuses.includes(m.status) && (m.priority ?? 1) > (b.priority ?? 1) && (early || !holds.has(m.id)))
      .sort((x, y) => y.priority - x.priority || x.number - y.number)[0];
  for (const b of batches) {
    const releaseDay = holds.get(b.id) ?? null;
    const held = releaseDay && !early ? `Pre-orders in this batch release ${prettyDay(releaseDay)}; it can be picked and packed from then.` : null;
    const above = (statuses) => {
      const m = firstAbove(b, statuses);
      return m ? `${m.tag}${m.name ? ` (${m.name})` : ""} is ${priorityLabel(m.priority)} priority: finish it first.` : null;
    };
    out.set(b.id, { pick: held ?? above(TO_PICK), pack: held ?? above(TO_PACK), releaseDay });
  }
  return out;
}

export const getBatchRow = (shop, batchId) => db.batch.findFirst({ where: { shop, id: Number(batchId) } });

export async function batchLock(shop, batchId, user, opts) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b) return { pick: null, pack: null, releaseDay: null };
  return (await batchLocks(shop, [b], user, opts)).get(b.id);
}

export async function renameBatch(shop, batchId, name, user) {
  const batch = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!batch) throw new ShippingError("That batch couldn't be found.");
  const clean = String(name ?? "").trim().slice(0, 80) || null;
  await db.batch.update({ where: { id: batch.id }, data: { name: clean } });
  await logEvent(shop, { batchId: batch.id, type: "batch_renamed", detail: `${batch.tag}: ${clean ?? "(no name)"}`, user });
}

// ---------------------------------------------------------------------------
// Batch lists
// ---------------------------------------------------------------------------

const assigneesOf = (b) => json(b.assignees, []);
// Is this batch one this person may see? (Only matters with "Only their assigned batches")
export const isAssignedTo = (b, staffId) => assigneesOf(b).some((a) => a.id === Number(staffId));

const viewBatch = (b, stats) => ({
  id: b.id,
  assignees: assigneesOf(b),
  number: b.number,
  tag: b.tag,
  name: b.name,
  source: b.source,
  status: b.status,
  priority: b.priority ?? 1,
  createdBy: b.createdBy,
  createdAt: b.createdAt.toISOString(),
  pickedAt: b.pickedAt?.toISOString() ?? null,
  pickedBy: b.pickedBy,
  shipments: stats?.shipments ?? 0,
  shipped: stats?.shipped ?? 0,
  units: stats?.units ?? 0,
  flagged: stats?.flagged ?? 0,
  oldestOrderAt: stats?.oldest ?? null,
  room: Math.max(0, MAX_BATCH - (stats?.shipments ?? 0)),
});

async function statsFor(batchIds) {
  if (!batchIds.length) return new Map();
  const rows = await db.shipment.findMany({
    where: { batchId: { in: batchIds }, state: { in: ["batched", "packed", "labeling", "shipped"] } },
    select: { batchId: true, units: true, flag: true, orderCreatedAt: true, mergedLines: true, state: true },
  });
  const m = new Map();
  for (const r of rows) {
    const s = m.get(r.batchId) ?? { shipments: 0, shipped: 0, units: 0, flagged: 0, oldest: null };
    s.shipments++;
    if (r.state === "shipped") s.shipped++;
    s.units += r.units + json(r.mergedLines, []).reduce((n, l) => n + (l.quantity ?? 0), 0);
    if (r.flag) s.flagged++;
    const at = r.orderCreatedAt.toISOString();
    if (!s.oldest || at < s.oldest) s.oldest = at;
    m.set(r.batchId, s);
  }
  return m;
}

// show: "live" (still to ship) | "done" | "cancelled"
// onlyFor: a staff member id; just the batches assigned to them
export async function listBatches(shop, { show = "live", onlyFor = null } = {}) {
  if (show === "live") await closeFinishedBatches(shop).catch((e) => console.error(`[batches] closing finished (${shop}):`, errorMessage(e)));
  const status = show === "cancelled" ? ["cancelled"] : show === "done" ? ["done"] : LIVE;
  let batches = await db.batch.findMany({ where: { shop, status: { in: status } }, orderBy: { number: show === "live" ? "asc" : "desc" }, take: 500 });
  if (onlyFor != null) batches = batches.filter((b) => isAssignedTo(b, onlyFor));
  // To ship: highest priority first, then oldest batch
  if (show === "live") batches.sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1) || a.number - b.number);
  batches = batches.slice(0, 200);
  const stats = await statsFor(batches.map((b) => b.id));
  return batches.map((b) => viewBatch(b, stats.get(b.id)));
}

// Open batches with room, for the "Add to batch" picker
export async function openBatches(shop) {
  return (await listBatches(shop)).filter((b) => EDITABLE.includes(b.status) && b.room > 0);
}

export async function getBatch(shop, batchId) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b) return null;
  const stats = await statsFor([b.id]);
  const tagIssues = await db.shipment.count({ where: { batchId: b.id, tagError: { not: null } } });
  const untagged = await db.shipment.count({ where: { batchId: b.id, state: "batched", OR: [{ batchTag: null }, { NOT: { batchTag: b.tag } }] } });
  const packed = await db.shipment.count({ where: { batchId: b.id, state: { in: ["packed", "labeling", "shipped"] } } });
  const toLabel = await db.shipment.findMany({ where: { batchId: b.id, state: { in: ["packed", "labeling"] } }, select: { packTagged: true } });
  const { packedTag } = await getShippingSettings(shop);
  return {
    ...viewBatch(b, stats.get(b.id)),
    editable: EDITABLE.includes(b.status),
    removable: REMOVABLE.includes(b.status),
    tagIssues,
    untagged,
    packed,
    bulk: {
      query: bulkLabelQuery(b.tag),
      ready: toLabel.filter((x) => x.packTagged).length,
      pending: packedTag ? toLabel.filter((x) => !x.packTagged).length : 0,
      tagging: packedTag,
    },
  };
}

// ---------------------------------------------------------------------------
// Pick list: every item in the batch, totalled, sorted by bin
// ---------------------------------------------------------------------------

const binSort = (a, b) => {
  if (a.bin && !b.bin) return -1;
  if (!a.bin && b.bin) return 1;
  return (
    (a.bin ?? "").localeCompare(b.bin ?? "", undefined, { numeric: true, sensitivity: "base" }) ||
    a.title.localeCompare(b.title, undefined, { numeric: true }) ||
    (a.variantTitle ?? "").localeCompare(b.variantTitle ?? "", undefined, { numeric: true })
  );
};

export async function pickList(shop, batchId) {
  const batch = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!batch) return null;
  const shipments = await db.shipment.findMany({
    where: { batchId: batch.id, state: { in: ["batched", "packed", "labeling", "shipped"] } },
    orderBy: shipmentOrder("oldest"),
  });
  const items = new Map();
  for (const s of shipments) {
    for (const l of boxLinesOf(s)) {
      const k = itemKey(l);
      const it = items.get(k) ?? {
        key: k,
        variantId: l.variantId,
        productId: l.productId,
        title: l.title,
        variantTitle: l.variantTitle,
        sku: l.sku,
        barcode: l.barcode,
        imageUrl: l.imageUrl,
        qty: 0,
        orders: 0,
      };
      it.qty += l.quantity;
      it.orders++;
      items.set(k, it);
    }
  }
  const variantIds = [...items.values()].map((i) => i.variantId).filter(Boolean);
  const bins = await db.productBin.findMany({ where: { shop, variantId: { in: variantIds } } });
  const binOf = new Map(bins.map((b) => [b.variantId, b.bin]));
  const picked = json(batch.picked, {});
  const list = [...items.values()]
    .map((i) => ({ ...i, bin: binOf.get(i.variantId) ?? null, picked: Math.min(picked[i.key] ?? 0, i.qty) }))
    .sort(binSort);
  return {
    batch: viewBatch(batch, (await statsFor([batch.id])).get(batch.id)),
    items: list,
    totals: { units: list.reduce((n, i) => n + i.qty, 0), picked: list.reduce((n, i) => n + i.picked, 0), lines: list.length },
    missingBins: list.filter((i) => !i.bin).length,
  };
}

// Saves the picked counts. Two pickers on one batch: retried on a clash.
async function updatePicked(batch, change) {
  let b = batch;
  for (let attempt = 0; attempt < 6; attempt++) {
    const picked = change(json(b.picked, {}));
    const r = await db.batch.updateMany({
      where: { id: b.id, updatedAt: b.updatedAt },
      data: {
        picked: JSON.stringify(picked),
        ...(b.status === "open" ? { status: "picking", pickStartedAt: new Date() } : {}),
      },
    });
    if (r.count) return picked;
    b = await db.batch.findUnique({ where: { id: b.id } });
  }
  throw new ShippingError("Couldn't save the pick; please scan again.");
}

const norm = (s) => String(s ?? "").trim().toLowerCase();

// A scan (barcode or SKU) on the pick list: one more of that item picked
export async function scanPick(shop, batchId, code, user) {
  const list = await pickList(shop, batchId);
  if (!list) throw new ShippingError("That batch couldn't be found.");
  if (!["open", "picking"].includes(list.batch.status)) throw new ShippingError(`${list.batch.tag} is already picked.`);
  const c = norm(code);
  if (!c) throw new ShippingError("Nothing scanned.");
  const matches = list.items.filter((i) => norm(i.barcode) === c || norm(i.sku) === c);
  if (!matches.length) return { ok: false, code, error: `${code} isn't in ${list.batch.tag}. Put it back.` };
  const item = matches.find((i) => i.picked < i.qty) ?? matches[0];
  if (item.picked >= item.qty) return { ok: false, code, key: item.key, error: `Already have all ${item.qty} × ${lineLabel(item)}.` };
  const batch = await db.batch.findUnique({ where: { id: list.batch.id } });
  const picked = await updatePicked(batch, (p) => ({ ...p, [item.key]: Math.min(item.qty, (p[item.key] ?? 0) + 1) }));
  return { ok: true, code, key: item.key, picked: picked[item.key], qty: item.qty, title: lineLabel(item), bin: item.bin, by: user?.name ?? null };
}

// Set a count by hand (the +/− buttons or "all picked")
export async function setPicked(shop, batchId, key, qty) {
  const list = await pickList(shop, batchId);
  if (!list) throw new ShippingError("That batch couldn't be found.");
  if (!["open", "picking"].includes(list.batch.status)) throw new ShippingError(`${list.batch.tag} is already picked.`);
  const item = list.items.find((i) => i.key === key);
  if (!item) throw new ShippingError("That item isn't in this batch.");
  const n = Math.max(0, Math.min(item.qty, Math.round(Number(qty) || 0)));
  const batch = await db.batch.findUnique({ where: { id: list.batch.id } });
  const picked = await updatePicked(batch, (p) => ({ ...p, [key]: n }));
  return { key, picked: picked[key], qty: item.qty };
}

export async function finishPicking(shop, batchId, user, { force = false } = {}) {
  const list = await pickList(shop, batchId);
  if (!list) throw new ShippingError("That batch couldn't be found.");
  if (!["open", "picking"].includes(list.batch.status)) throw new ShippingError(`${list.batch.tag} is already picked.`);
  const short = list.items.filter((i) => i.picked < i.qty);
  if (short.length && !force) {
    return {
      ok: false,
      short: short.map((i) => ({ title: lineLabel(i), missing: i.qty - i.picked, bin: i.bin })),
    };
  }
  await db.batch.update({ where: { id: list.batch.id }, data: { status: "picked", pickedAt: new Date(), pickedBy: user?.name ?? null } });
  await logEvent(shop, {
    batchId: list.batch.id,
    type: "batch_picked",
    detail: `${list.batch.tag}: ${list.totals.picked} of ${list.totals.units} units${short.length ? ` (finished short: ${short.map((i) => `${i.qty - i.picked} × ${lineLabel(i)}`).join(", ")})` : ""}`,
    user,
  });
  return { ok: true };
}

export async function reopenPicking(shop, batchId, user) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b || b.status !== "picked") throw new ShippingError("Only a picked batch can go back to picking.");
  await db.batch.update({ where: { id: b.id }, data: { status: "picking", pickedAt: null, pickedBy: null } });
  await logEvent(shop, { batchId: b.id, type: "batch_pick_reopened", detail: b.tag, user });
}

// ---------------------------------------------------------------------------
// Batch tags on Shopify orders
// ---------------------------------------------------------------------------

const TAGS_ADD = `#graphql
  mutation ($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;
const TAGS_REMOVE = `#graphql
  mutation ($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

async function tagCall(admin, mutation, orderId, tag) {
  const data = await gql(admin, mutation, { id: orderId, tags: [tag] });
  const r = data?.tagsAdd ?? data?.tagsRemove;
  if (r?.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
}

// Puts each batched order's tag on in Shopify and takes old ones off
export async function syncBatchTags(shop, admin) {
  const live = await db.batch.findMany({ where: { shop, status: { not: "cancelled" } }, select: { id: true, tag: true } });
  const tagOf = new Map(live.map((b) => [b.id, b.tag]));
  const rows = await db.shipment.findMany({
    where: { shop, OR: [{ batchId: { not: null } }, { batchTag: { not: null } }] },
    select: { id: true, orderId: true, batchId: true, batchTag: true, tagError: true, updatedAt: true, state: true },
  });
  let changes = 0;
  // Tags still wanted on each order (an order can be in two batches when it ships in parts)
  const wanted = new Map();
  for (const r of rows) {
    const t = r.batchId ? tagOf.get(r.batchId) : null;
    if (t) wanted.set(`${r.orderId}|${t}`, true);
  }
  for (const r of rows) {
    if (changes >= TAG_CHANGES_PER_RUN) break;
    const want = r.batchId ? tagOf.get(r.batchId) ?? null : null;
    if (want === r.batchTag) continue;
    if (r.tagError && Date.now() - r.updatedAt.getTime() < 10 * 60 * 1000) continue;
    changes++;
    try {
      if (r.batchTag && !wanted.has(`${r.orderId}|${r.batchTag}`)) await tagCall(admin, TAGS_REMOVE, r.orderId, r.batchTag);
      if (want) await tagCall(admin, TAGS_ADD, r.orderId, want);
      await db.shipment.update({ where: { id: r.id }, data: { batchTag: want, tagError: null } });
    } catch (e) {
      await db.shipment.update({ where: { id: r.id }, data: { tagError: `Couldn't update the order's batch tag: ${errorMessage(e)}`.slice(0, 300) } });
    }
  }
  changes += await syncPackedTags(shop, admin, TAG_CHANGES_PER_RUN - changes);
  // More to do: go again shortly instead of waiting for the next two-minute check
  if (changes >= TAG_CHANGES_PER_RUN) kick(shop, 5000);
  return { changes };
}

// "Packed" on orders whose box is packed but not shipped yet, so Shopify's
// order list can show just those for buying labels in bulk. Off again once
// shipped (or unpacked). An order with two boxes keeps it while either is packed.
async function syncPackedTags(shop, admin, room) {
  if (room <= 0) return 0;
  const { packedTag } = await getShippingSettings(shop);
  const rows = await db.shipment.findMany({
    where: { shop, OR: [{ packTagged: true }, ...(packedTag ? [{ state: { in: ["packed", "labeling"] } }] : [])] },
    select: { id: true, orderId: true, state: true, packTagged: true, tagError: true, updatedAt: true },
  });
  const wantOrder = new Set(rows.filter((r) => packedTag && ["packed", "labeling"].includes(r.state)).map((r) => r.orderId));
  // The order's other open parts must be on hold first, or Shopify's label screen
  // would offer labels for them too (a hold that failed doesn't block it forever)
  const unheld = new Set(
    (
      await db.shipment.findMany({
        where: { shop, orderId: { in: [...wantOrder] }, state: { in: ["waiting", "ready", "batched"] }, appHoldId: null, otherHold: null, holdError: null, overrideAt: null },
        select: { orderId: true },
      })
    ).map((x) => x.orderId),
  );
  let changes = 0;
  for (const r of rows) {
    if (changes >= room) break;
    const want = packedTag && ["packed", "labeling"].includes(r.state);
    if (want === r.packTagged) continue;
    if (want && unheld.has(r.orderId)) continue; // next run, once the hold is on
    if (r.tagError && Date.now() - r.updatedAt.getTime() < 10 * 60 * 1000) continue;
    changes++;
    try {
      if (want) await tagCall(admin, TAGS_ADD, r.orderId, PACKED_TAG);
      else if (!wantOrder.has(r.orderId)) await tagCall(admin, TAGS_REMOVE, r.orderId, PACKED_TAG);
      await db.shipment.update({ where: { id: r.id }, data: { packTagged: want, tagError: null } });
    } catch (e) {
      await db.shipment.update({ where: { id: r.id }, data: { tagError: `Couldn't update the order's Packed tag: ${errorMessage(e)}`.slice(0, 300) } });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Auto-batching (oldest orders first; orders flagged for review wait)
//   Single items: one unit of one item. An item with more than `autoSingleMin`
//     of them gets its own "<item> singles" batch (topped up first if one's open).
//   Identical orders: exactly the same items and quantities, at least
//     `autoIdenticalMin` of them: "<items> identical".
//   Multiples: orders sharing one "anchor" item (the most common first), each with
//     at most `autoMultiMaxOther` other units, at most `autoMultiMaxItems`
//     different items per batch, at least `autoMultiMin` orders: "<anchor> multiples".
//   Upcoming releases: the same rules for pre-orders releasing within
//     `autoReleaseDays`, batched ahead (picking waits for the release date).
// Batches hold up to 250; bigger groups are split.
// ---------------------------------------------------------------------------

const shortHash = (t) => createHash("sha1").update(String(t)).digest("hex").slice(0, 12);
const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const clip = (t, n = 60) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// Puts a group into batches: tops up an open batch of the same kind first (if allowed),
// then new batches of up to 250
// newOk: false = only top up an open batch (the group is under its minimum).
// Returns the ids it placed.
async function place(shop, made, { source, name, ids, user, topUp = true, from, newOk = true }) {
  let rest = ids;
  const placed = [];
  const open = topUp ? await db.batch.findMany({ where: { shop, source, status: "open" }, orderBy: { number: "asc" } }) : [];
  for (const b of open) {
    if (!rest.length) break;
    const room = MAX_BATCH - (await batchCount(b.id));
    if (room <= 0) continue;
    const part = rest.slice(0, room);
    const added = await assign(shop, b, part, { from });
    placed.push(...part);
    rest = rest.slice(room);
    if (added) made.push({ id: b.id, tag: b.tag, name: b.name, added, topUp: true });
  }
  if (!newOk) return placed;
  const parts = chunk(rest, MAX_BATCH);
  const earlier = topUp ? open.length : await db.batch.count({ where: { shop, source } });
  for (const [i, part] of parts.entries()) {
    const n = earlier + i + 1;
    const batch = await newBatch(shop, { name: `${name}${parts.length > 1 || earlier ? ` ${n}` : ""}`, source, user });
    const added = await assign(shop, batch, part, { from });
    placed.push(...part);
    made.push({ id: batch.id, tag: batch.tag, name: batch.name, added });
  }
  return placed;
}

// A merged box (Order Merge) is grouped by everything in it; the orders merged into
// another box aren't batched on their own
const rowsOf = (list) => list.filter((s) => !s.mergedInto).map((s) => ({ ...s, items: boxLinesOf(s) }));

// Groups one pool of shipments by the rules that are on. release: the release day
// (for names), and the shipments come from the Waiting list.
async function batchPool(shop, settings, pool, made, { user, release = null }) {
  let left = pool.filter((s) => s.items.length && s.items.every((l) => l.quantity > 0));
  const tag = release ? ` · releases ${shortDay(release.until)}` : "";
  const prefix = release ? "auto:release:" : "auto:";
  const from = release ? ["waiting"] : ["ready"];
  const take = (ids) => {
    const gone = new Set(ids);
    left = left.filter((s) => !gone.has(s.id));
  };

  // 1. Single items
  if (settings.autoSingleItem) {
    const min = settings.autoSingleMin ?? 50;
    const groups = new Map();
    for (const s of left) {
      if (s.items.length !== 1 || s.items[0].quantity !== 1) continue;
      const k = itemKey(s.items[0]);
      const g = groups.get(k) ?? { key: k, label: lineLabel(s.items[0]), ids: [] };
      g.ids.push(s.id);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      // Under the minimum: still joins this item's open singles batch, if there is one
      const placed = await place(shop, made, { source: `${prefix}singles:${g.key}`, name: `${g.label} singles${tag}`, ids: g.ids, user, from, newOk: g.ids.length > min });
      take(placed);
    }
  }

  // 2. Identical orders
  if (settings.autoIdentical) {
    const min = settings.autoIdenticalMin ?? 10;
    const groups = new Map();
    for (const s of left) {
      // Single-item orders belong to the singles rule (and its minimum) when that's on
      if (settings.autoSingleItem && s.items.length === 1 && s.items[0].quantity === 1) continue;
      const parts = s.items.map((l) => ({ k: itemKey(l), q: l.quantity, label: lineLabel(l) })).sort((x, y) => x.k.localeCompare(y.k));
      const key = parts.map((p) => `${p.k}×${p.q}`).join("+");
      const g = groups.get(key) ?? { key, label: parts.map((p) => `${p.q > 1 ? `${p.q} × ` : ""}${p.label}`).join(" + "), ids: [] };
      g.ids.push(s.id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const placed = await place(shop, made, { source: `${prefix}identical:${shortHash(g.key)}`, name: `${clip(g.label)} identical${tag}`, ids: g.ids, user, from, newOk: g.ids.length >= min });
      take(placed);
    }
  }

  // 3. Multiples: around the most common anchor item
  if (settings.autoMultiples) {
    const min = settings.autoMultiMin ?? 20;
    const maxOther = settings.autoMultiMaxOther ?? 3;
    const maxItems = settings.autoMultiMaxItems ?? 25;
    let candidates = left.filter((s) => s.items.reduce((n, l) => n + l.quantity, 0) >= 2);
    // First, orders that fit an open multiples batch (same anchor, within its limits)
    const openMulti = await db.batch.findMany({ where: { shop, status: "open", source: { startsWith: `${prefix}multi:` } }, orderBy: { number: "asc" } });
    for (const b of openMulti) {
      const anchor = b.source.slice(`${prefix}multi:`.length);
      const inside = await db.shipment.findMany({ where: { batchId: b.id, state: { in: ["batched", "packed", "labeling"] } }, select: { lines: true } });
      const items = new Set(inside.flatMap((x) => json(x.lines, []).map(itemKey)));
      let room = MAX_BATCH - inside.length;
      const chosen = [];
      for (const s of candidates) {
        if (room <= 0) break;
        const a = s.items.filter((l) => itemKey(l) === anchor);
        if (!a.length) continue;
        const units = s.items.reduce((n, l) => n + l.quantity, 0);
        if (units - a.reduce((n, l) => n + l.quantity, 0) > maxOther) continue;
        const extra = [...new Set(s.items.map(itemKey))].filter((k) => !items.has(k));
        if (items.size + extra.length > maxItems) continue;
        extra.forEach((k) => items.add(k));
        chosen.push(s.id);
        room--;
      }
      if (!chosen.length) continue;
      const added = await assign(shop, b, chosen, { from });
      if (added) made.push({ id: b.id, tag: b.tag, name: b.name, added, topUp: true });
      const gone = new Set(chosen);
      candidates = candidates.filter((s) => !gone.has(s.id));
      take(chosen);
    }
    for (let round = 0; round < 200 && candidates.length >= min; round++) {
      const counts = new Map();
      for (const s of candidates) for (const k of new Set(s.items.map(itemKey))) counts.set(k, (counts.get(k) ?? 0) + 1);
      const anchors = [...counts.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      let done = false;
      for (const [anchor] of anchors) {
        const chosen = [];
        const items = new Set([anchor]);
        let label = null;
        for (const s of candidates) {
          const a = s.items.filter((l) => itemKey(l) === anchor);
          if (!a.length) continue;
          const units = s.items.reduce((n, l) => n + l.quantity, 0);
          const anchorUnits = a.reduce((n, l) => n + l.quantity, 0);
          if (units - anchorUnits > maxOther) continue;
          const extra = [...new Set(s.items.map(itemKey))].filter((k) => !items.has(k));
          if (items.size + extra.length > maxItems) continue;
          extra.forEach((k) => items.add(k));
          label = label ?? lineLabel(a[0]);
          chosen.push(s.id);
        }
        if (chosen.length < min) continue;
        await place(shop, made, { source: `${prefix}multi:${anchor}`, name: `${label} multiples${tag}`, ids: chosen, user, from, topUp: false });
        const gone = new Set(chosen);
        candidates = candidates.filter((s) => !gone.has(s.id));
        take(chosen);
        done = true;
        break;
      }
      if (!done) break;
    }
  }
}

export async function runAutoBatch(shop, user = null, { manual = true } = {}) {
  const settings = await getShippingSettings(shop);
  const made = [];
  const anyRule = settings.autoSingleItem || settings.autoIdentical || settings.autoMultiples;
  if (anyRule) {
    // Orders flagged for review wait until the flag is resolved
    const flagged = new Set((await db.orderFlag.findMany({ where: { shop, status: "open" }, select: { orderId: true } })).map((f) => f.orderId));
    const pick = { id: true, lines: true, orderId: true, releaseDay: true, mergedLines: true, mergedInto: true };
    const ready = await db.shipment.findMany({ where: { shop, state: "ready", batchId: null }, orderBy: shipmentOrder("oldest"), select: pick });
    await batchPool(shop, settings, rowsOf(ready.filter((s) => !flagged.has(s.orderId))), made, { user });
    // Upcoming releases: pre-orders (and nothing else holding them) releasing within N days
    if (settings.autoRelease) {
      const today = todayInStore();
      const until = addDays(today, Math.max(0, settings.autoReleaseDays ?? 3));
      const soon = await db.shipment.findMany({
        where: { shop, state: "waiting", batchId: null, releaseDay: { gt: today, lte: until }, waitingReason: { startsWith: "Pre-order" } },
        orderBy: shipmentOrder("oldest"),
        select: pick,
      });
      const pool = rowsOf(soon.filter((s) => !flagged.has(s.orderId)));
      // One pass per release day, so a batch is released all at once
      for (const day of [...new Set(pool.map((s) => s.releaseDay))].sort()) {
        await batchPool(shop, settings, pool.filter((s) => s.releaseDay === day), made, { user, release: { until: day } });
      }
    }
  }
  await db.shippingSettings.update({ where: { shop }, data: { lastAutoBatchAt: new Date() } });
  const total = made.reduce((n, b) => n + b.added, 0);
  await logEvent(shop, {
    type: "auto_batch",
    detail: made.length ? made.map((b) => `${b.tag} "${b.name}": ${b.topUp ? "+" : ""}${b.added}`).join(", ") : `Nothing to batch (no group met its minimum)`,
    user: user ?? { name: manual ? null : "Daily schedule" },
  });
  if (made.length) kick(shop);
  return { batches: made, added: total };
}

const minutesFormatter = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "numeric", hourCycle: "h23" });
const storeMinutes = (date) => {
  const parts = Object.fromEntries(minutesFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
};
const parseTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// Is the daily auto-batch due? Once per store day, at or after the set time.
export function autoBatchDue(settings, now = new Date()) {
  if (!settings.autoBatchEnabled) return false;
  const at = parseTime(settings.autoBatchTime);
  if (at == null || storeMinutes(now) < at) return false;
  return !settings.lastAutoBatchAt || dayInStore(settings.lastAutoBatchAt) !== dayInStore(now);
}

const whole = (v, lo, hi, what) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) throw new ShippingError(`${what} must be a number from ${lo} to ${hi}.`);
  return n;
};

export async function saveAutoBatchSettings(shop, f, user) {
  const { enabled, time, singles, min } = f;
  const t = parseTime(time);
  if (t == null || t >= 24 * 60) throw new ShippingError("Pick a time like 07:00.");
  const before = await getShippingSettings(shop);
  const data = {
    autoBatchEnabled: Boolean(enabled),
    autoBatchTime: String(time).padStart(5, "0"),
    autoSingleItem: Boolean(singles),
    autoSingleMin: whole(min, 1, 5000, "The single items minimum"),
    autoIdentical: Boolean(f.identical),
    autoIdenticalMin: whole(f.identicalMin ?? before.autoIdenticalMin ?? 10, 2, 5000, "The identical orders minimum"),
    autoMultiples: Boolean(f.multiples),
    autoMultiMin: whole(f.multiMin ?? before.autoMultiMin ?? 20, 2, 5000, "The multiples minimum"),
    autoMultiMaxOther: whole(f.multiMaxOther ?? before.autoMultiMaxOther ?? 3, 0, 50, "Other items per order"),
    autoMultiMaxItems: whole(f.multiMaxItems ?? before.autoMultiMaxItems ?? 25, 1, 500, "Different items per batch"),
    autoRelease: Boolean(f.release),
    autoReleaseDays: whole(f.releaseDays ?? before.autoReleaseDays ?? 3, 1, 60, "Days before release"),
  };
  // Turning the schedule on after today's time has passed shouldn't fire straight away
  if (data.autoBatchEnabled && !before.autoBatchEnabled && storeMinutes(new Date()) >= t) data.lastAutoBatchAt = new Date();
  await db.shippingSettings.update({ where: { shop }, data });
  const rules = [
    data.autoSingleItem ? `single items (more than ${data.autoSingleMin})` : null,
    data.autoIdentical ? `identical orders (at least ${data.autoIdenticalMin})` : null,
    data.autoMultiples ? `multiples (at least ${data.autoMultiMin}; ≤${data.autoMultiMaxOther} other items each; ≤${data.autoMultiMaxItems} different items per batch)` : null,
  ].filter(Boolean);
  await logEvent(shop, {
    type: "auto_batch_settings",
    detail: `${data.autoBatchEnabled ? `Daily at ${data.autoBatchTime}` : "Schedule off"}; ${rules.length ? rules.join(", ") : "no rules on"}${data.autoRelease ? `; upcoming releases within ${data.autoReleaseDays} day${data.autoReleaseDays === 1 ? "" : "s"}` : ""}`,
    user,
  });
}

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

// Items on open shipments, with their bins, plus any other saved bins
export async function listBins(shop, { q = "", missing = false } = {}) {
  const active = await db.shipment.findMany({
    where: { shop, state: { in: ["waiting", "ready", "batched", "packed", "labeling"] } },
    select: { lines: true, state: true },
  });
  const items = new Map();
  for (const s of active) {
    for (const l of json(s.lines, [])) {
      if (!l.variantId) continue;
      const it = items.get(l.variantId) ?? {
        variantId: l.variantId,
        productId: l.productId,
        title: l.title,
        variantTitle: l.variantTitle,
        sku: l.sku,
        barcode: l.barcode,
        imageUrl: l.imageUrl,
        units: 0,
      };
      if (s.state !== "waiting") it.units += l.quantity;
      items.set(l.variantId, it);
    }
  }
  const saved = await db.productBin.findMany({ where: { shop } });
  for (const b of saved) {
    const it = items.get(b.variantId) ?? { variantId: b.variantId, productId: b.productId, title: b.title ?? "(unknown item)", variantTitle: null, sku: b.sku, barcode: b.barcode, imageUrl: null, units: 0 };
    items.set(b.variantId, { ...it, bin: b.bin, updatedBy: b.updatedBy, updatedAt: b.updatedAt.toISOString() });
  }
  const needle = norm(q);
  return [...items.values()]
    .filter((i) => !missing || !i.bin)
    .filter((i) => !needle || [i.title, i.variantTitle, i.sku, i.barcode, i.bin].some((v) => norm(v).includes(needle)))
    .sort((a, b) => b.units - a.units || binSort(a, b))
    .slice(0, 500);
}

// Saves a bin, and writes it to the variant's "Bin location" in Shopify (push: false to batch that up)
export async function setBin(shop, item, bin, user, { push = true } = {}) {
  if (!item?.variantId) throw new ShippingError("Pick an item first.");
  const clean = String(bin ?? "").trim().slice(0, 40);
  if (!clean) {
    await db.productBin.deleteMany({ where: { shop, variantId: item.variantId } });
    if (push) await pushBins(shop, [{ variantId: item.variantId, bin: "" }]);
    return { variantId: item.variantId, bin: null };
  }
  const data = {
    bin: clean,
    productId: item.productId ?? null,
    sku: item.sku ?? null,
    barcode: item.barcode ?? null,
    title: item.variantTitle ? `${item.title} – ${item.variantTitle}` : item.title ?? null,
    updatedBy: user?.name ?? null,
  };
  await db.productBin.upsert({ where: { shop_variantId: { shop, variantId: item.variantId } }, create: { shop, variantId: item.variantId, ...data }, update: data });
  const sent = push ? await pushBins(shop, [{ variantId: item.variantId, bin: clean }]) : null;
  return { variantId: item.variantId, bin: clean, ...(sent?.errors?.length ? { shopifyError: `Saved here, but Shopify's Bin location field wasn't updated: ${sent.errors[0]}` } : {}) };
}

const FIND_VARIANTS = `#graphql
  query ($q: String!) {
    productVariants(first: 50, query: $q) {
      nodes { id sku barcode title product { id title } }
    }
  }`;

const parseCsvLine = (line) => {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === "\t") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
};

// CSV: "SKU or barcode, bin" per line (a header row is fine)
export async function importBins(shop, admin, text, user) {
  const rows = String(text ?? "")
    .split(/\r?\n/)
    .map(parseCsvLine)
    .filter((r) => r[0] && r[1] !== undefined);
  if (rows.length && /sku|barcode|item|code/i.test(rows[0][0]) && /bin|location|shelf/i.test(rows[0][1] ?? "")) rows.shift();
  if (!rows.length) throw new ShippingError('Nothing to import. Paste lines like "9781234567890, A-12".');
  if (rows.length > 5000) throw new ShippingError("That's more than 5,000 lines; split it into smaller files.");

  // What we already know about: items on shipments and saved bins
  const known = await listBins(shop);
  const byCode = new Map();
  for (const i of known) {
    if (i.sku) byCode.set(norm(i.sku), i);
    if (i.barcode) byCode.set(norm(i.barcode), i);
  }
  // Anything else: look it up in Shopify, 20 codes at a time
  const unknown = [...new Set(rows.map((r) => r[0]).filter((c) => !byCode.has(norm(c))))];
  for (let i = 0; i < unknown.length; i += 20) {
    const part = unknown.slice(i, i + 20);
    const q = part.map((c) => `sku:"${c.replace(/"/g, "")}" OR barcode:"${c.replace(/"/g, "")}"`).join(" OR ");
    const data = await gql(admin, FIND_VARIANTS, { q });
    for (const v of data?.productVariants?.nodes ?? []) {
      const it = {
        variantId: v.id,
        productId: v.product?.id,
        title: v.product?.title,
        variantTitle: v.title && v.title !== "Default Title" ? v.title : null,
        sku: v.sku,
        barcode: v.barcode,
      };
      if (v.sku && !byCode.has(norm(v.sku))) byCode.set(norm(v.sku), it);
      if (v.barcode && !byCode.has(norm(v.barcode))) byCode.set(norm(v.barcode), it);
    }
  }
  let updated = 0;
  const notFound = [];
  const toShopify = [];
  for (const [code, bin] of rows) {
    const it = byCode.get(norm(code));
    if (!it) {
      notFound.push(code);
      continue;
    }
    await setBin(shop, it, bin, user, { push: false });
    toShopify.push({ variantId: it.variantId, bin });
    updated++;
  }
  // All at once to Shopify's Bin location fields
  await pushBins(shop, toShopify, { admin });
  await logEvent(shop, { type: "bins_imported", detail: `${updated} bin${updated === 1 ? "" : "s"} set${notFound.length ? `, ${notFound.length} not found` : ""}`, user });
  return { updated, notFound: notFound.slice(0, 50), notFoundCount: notFound.length };
}

export async function exportBins(shop) {
  const rows = await db.productBin.findMany({ where: { shop }, orderBy: { bin: "asc" } });
  const esc = (v) => (/[",\n]/.test(v ?? "") ? `"${String(v).replace(/"/g, '""')}"` : (v ?? ""));
  return ["SKU,Barcode,Item,Bin", ...rows.map((r) => [r.sku, r.barcode, r.title, r.bin].map(esc).join(","))].join("\n");
}

// ---------------------------------------------------------------------------
// After every shipping refresh: the daily auto-batch, then order tags
// ---------------------------------------------------------------------------

// Batches whose orders have all left (shipped, or fulfilled/cancelled in Shopify or
// another app, e.g. labels bought on Shopify's own pages): Shipped, or Cancelled
// if none of them shipped. Runs after every refresh and when the Batches tab opens.
export async function closeFinishedBatches(shop) {
  const live = await db.batch.findMany({ where: { shop, status: { in: LIVE } }, select: { id: true, tag: true, status: true, packDoneAt: true } });
  if (!live.length) return [];
  const rows = await db.shipment.groupBy({ by: ["batchId", "state"], where: { shop, batchId: { in: live.map((b) => b.id) } }, _count: { _all: true } });
  const counts = new Map();
  for (const r of rows) {
    const c = counts.get(r.batchId) ?? { open: 0, shipped: 0, gone: 0 };
    if (["batched", "packed", "labeling", "ready", "waiting"].includes(r.state)) c.open += r._count._all;
    else if (r.state === "shipped") c.shipped += r._count._all;
    else c.gone += r._count._all;
    counts.set(r.batchId, c);
  }
  const closed = [];
  for (const b of live) {
    const c = counts.get(b.id);
    if (!c || c.open || !(c.shipped + c.gone)) continue; // still work to do, or empty (just made)
    const done = c.shipped > 0;
    const r = await db.batch.updateMany({
      where: { id: b.id, status: { in: LIVE } },
      data: done ? { status: "done", packDoneAt: b.packDoneAt ?? new Date() } : { status: "cancelled", cancelledAt: new Date() },
    });
    if (!r.count) continue;
    closed.push({ id: b.id, tag: b.tag, status: done ? "done" : "cancelled" });
    await logEvent(shop, {
      batchId: b.id,
      type: done ? "batch_done" : "batch_cancelled",
      detail: done
        ? `${b.tag}: every order has shipped${c.gone ? ` (${c.gone} cancelled or closed in Shopify)` : ""}`
        : `${b.tag}: every order was cancelled or closed in Shopify`,
      user: { name: null },
    });
  }
  return closed;
}

onAfterRun(async (shop, admin, step) => {
  // Bin locations edited in Shopify admin: a full check every 30 minutes, in the background
  syncAllBins(shop).catch((e) => console.error(`[bins] sync (${shop}):`, errorMessage(e)));
  const settings = await getShippingSettings(shop);
  if (autoBatchDue(settings)) {
    step("Auto-batching");
    await runAutoBatch(shop, null, { manual: false });
  }
  await closeFinishedBatches(shop);
  step("Updating batch tags on orders");
  await syncBatchTags(shop, admin);
});
