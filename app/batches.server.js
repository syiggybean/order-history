import db from "./db.server";
import { PACKED_TAG, bulkLabelQuery } from "./pack.server";
import { dayInStore, errorMessage, gql, TIME_ZONE } from "./preorders.server";
import {
  ShippingError,
  getShippingSettings,
  kick,
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
async function assign(shop, batch, ids) {
  if (!ids.length) return 0;
  const r = await db.shipment.updateMany({
    where: { shop, id: { in: ids }, state: "ready", batchId: null },
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
  createdBy: b.createdBy,
  createdAt: b.createdAt.toISOString(),
  pickedAt: b.pickedAt?.toISOString() ?? null,
  pickedBy: b.pickedBy,
  shipments: stats?.shipments ?? 0,
  units: stats?.units ?? 0,
  flagged: stats?.flagged ?? 0,
  oldestOrderAt: stats?.oldest ?? null,
  room: Math.max(0, MAX_BATCH - (stats?.shipments ?? 0)),
});

async function statsFor(batchIds) {
  if (!batchIds.length) return new Map();
  const rows = await db.shipment.findMany({
    where: { batchId: { in: batchIds }, state: { in: ["batched", "packed", "labeling", "shipped"] } },
    select: { batchId: true, units: true, flag: true, orderCreatedAt: true },
  });
  const m = new Map();
  for (const r of rows) {
    const s = m.get(r.batchId) ?? { shipments: 0, units: 0, flagged: 0, oldest: null };
    s.shipments++;
    s.units += r.units;
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
  const status = show === "cancelled" ? ["cancelled"] : show === "done" ? ["done"] : LIVE;
  let batches = await db.batch.findMany({ where: { shop, status: { in: status } }, orderBy: { number: show === "live" ? "asc" : "desc" }, take: 500 });
  if (onlyFor != null) batches = batches.filter((b) => isAssignedTo(b, onlyFor));
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
    for (const l of linesOf(s)) {
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
  let changes = 0;
  for (const r of rows) {
    if (changes >= room) break;
    const want = packedTag && ["packed", "labeling"].includes(r.state);
    if (want === r.packTagged) continue;
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
// Auto-batching
//   Single items: shipments of exactly one unit of one item. An item with more
//   than `autoSingleMin` of them ready gets its own "<item> singles" batch
//   (several if over 250). Its open singles batch is topped up first.
// ---------------------------------------------------------------------------

export async function runAutoBatch(shop, user = null, { manual = true } = {}) {
  const settings = await getShippingSettings(shop);
  const made = [];
  if (settings.autoSingleItem) {
    const min = settings.autoSingleMin ?? 50;
    const ready = await db.shipment.findMany({
      where: { shop, state: "ready", batchId: null, units: 1 },
      orderBy: shipmentOrder("oldest"),
      select: { id: true, lines: true, orderId: true },
    });
    // Orders flagged for review wait until the flag is resolved
    const flagged = new Set(
      (await db.orderFlag.findMany({ where: { shop, status: "open" }, select: { orderId: true } })).map((f) => f.orderId),
    );
    const groups = new Map();
    for (const s of ready) {
      if (flagged.has(s.orderId)) continue;
      const lines = json(s.lines, []);
      if (lines.length !== 1 || lines[0].quantity !== 1) continue;
      const k = itemKey(lines[0]);
      const g = groups.get(k) ?? { key: k, label: lineLabel(lines[0]), ids: [] };
      g.ids.push(s.id);
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      if (g.ids.length <= min) continue;
      const source = `auto:singles:${g.key}`;
      let ids = g.ids;
      // Top up this item's open singles batch first
      const open = await db.batch.findMany({ where: { shop, source, status: "open" }, orderBy: { number: "asc" } });
      for (const b of open) {
        if (!ids.length) break;
        const room = MAX_BATCH - (await batchCount(b.id));
        if (room <= 0) continue;
        const added = await assign(shop, b, ids.slice(0, room));
        ids = ids.slice(room);
        if (added) made.push({ id: b.id, tag: b.tag, name: b.name, added, topUp: true });
      }
      const parts = chunk(ids, MAX_BATCH);
      for (const [i, part] of parts.entries()) {
        const name = `${g.label} singles${parts.length > 1 || open.length ? ` ${open.length + i + 1}` : ""}`;
        const batch = await newBatch(shop, { name, source, user });
        const added = await assign(shop, batch, part);
        made.push({ id: batch.id, tag: batch.tag, name: batch.name, added });
      }
    }
  }
  await db.shippingSettings.update({ where: { shop }, data: { lastAutoBatchAt: new Date() } });
  const total = made.reduce((n, b) => n + b.added, 0);
  await logEvent(shop, {
    type: "auto_batch",
    detail: made.length
      ? made.map((b) => `${b.tag} "${b.name}": ${b.topUp ? "+" : ""}${b.added}`).join(", ")
      : `Nothing to batch (no item had more than ${settings.autoSingleMin ?? 50} single-item shipments ready)`,
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

export async function saveAutoBatchSettings(shop, { enabled, time, singles, min }, user) {
  const t = parseTime(time);
  if (t == null || t >= 24 * 60) throw new ShippingError("Pick a time like 07:00.");
  const n = Math.round(Number(min));
  if (!Number.isFinite(n) || n < 1 || n > 5000) throw new ShippingError("The minimum must be a number from 1 to 5000.");
  const before = await getShippingSettings(shop);
  const data = { autoBatchEnabled: Boolean(enabled), autoBatchTime: String(time).padStart(5, "0"), autoSingleItem: Boolean(singles), autoSingleMin: n };
  // Turning the schedule on after today's time has passed shouldn't fire straight away
  if (data.autoBatchEnabled && !before.autoBatchEnabled && storeMinutes(new Date()) >= t) data.lastAutoBatchAt = new Date();
  await db.shippingSettings.update({ where: { shop }, data });
  await logEvent(shop, {
    type: "auto_batch_settings",
    detail: `${data.autoBatchEnabled ? `Daily at ${data.autoBatchTime}` : "Schedule off"}; single items ${data.autoSingleItem ? `on (more than ${n})` : "off"}`,
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

export async function setBin(shop, item, bin, user) {
  if (!item?.variantId) throw new ShippingError("Pick an item first.");
  const clean = String(bin ?? "").trim().slice(0, 40);
  if (!clean) {
    await db.productBin.deleteMany({ where: { shop, variantId: item.variantId } });
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
  return { variantId: item.variantId, bin: clean };
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
  for (const [code, bin] of rows) {
    const it = byCode.get(norm(code));
    if (!it) {
      notFound.push(code);
      continue;
    }
    await setBin(shop, it, bin, user);
    updated++;
  }
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

onAfterRun(async (shop, admin, step) => {
  const settings = await getShippingSettings(shop);
  if (autoBatchDue(settings)) {
    step("Auto-batching");
    await runAutoBatch(shop, null, { manual: false });
  }
  step("Updating batch tags on orders");
  await syncBatchTags(shop, admin);
});
