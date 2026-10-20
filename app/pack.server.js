import db from "./db.server";
import { ShippingError, getShippingSettings, isSandboxShop, kick, linesOf, logEvent, noticeOf, shipmentOrder, staffKeyOf, syncOrder } from "./shipping.server";
import { gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Packing: one box (shipment) at a time, every item scanned.
//
// - Opens from a picked batch. Packers work oldest order first, or scan the
//   barcode on a packing slip ("43712" or "43712-2" for part 2) to jump to it.
// - A note or address correction must be acknowledged at the bench before the
//   first scan, every time.
// - Wrong items and extra units are refused. When every unit is scanned the
//   shipment is Packed; when every shipment is, the batch is Packed.
// - Someone with "Override scan mismatches" can pack without a full scan, with a reason.
// ---------------------------------------------------------------------------

const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const norm = (s) => String(s ?? "").trim().toLowerCase();
const itemKey = (l) => l.variantId ?? `title:${l.title}|${l.variantTitle ?? ""}`;
const label = (l) => `${l.title}${l.variantTitle ? ` – ${l.variantTitle}` : ""}`;
const PACKABLE = ["picked", "packing", "packed", "done"];

async function batchFor(shop, batchId) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b) throw new ShippingError("That batch couldn't be found.");
  return b;
}

const flagsFor = async (shop, orderIds) => {
  if (!orderIds.length) return new Map();
  const rows = await db.orderFlag.findMany({ where: { shop, status: "open", orderId: { in: orderIds } } });
  const m = new Map();
  for (const f of rows) m.set(f.orderId, [...(m.get(f.orderId) ?? []), { id: f.id, reason: f.reason, note: f.note, by: f.createdBy }]);
  return m;
};

function viewBox(s, flags, bins) {
  const packed = json(s.packed, {});
  const lines = linesOf(s).map((l) => {
    const key = itemKey(l);
    return {
      key,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      barcode: l.barcode,
      imageUrl: l.imageUrl,
      productId: l.productId,
      qty: l.quantity,
      scanned: Math.min(packed[key] ?? 0, l.quantity),
      bin: bins?.get(l.variantId) ?? null,
    };
  });
  const units = lines.reduce((n, l) => n + l.qty, 0);
  const scanned = lines.reduce((n, l) => n + l.scanned, 0);
  const notice = noticeOf(s);
  return {
    id: s.id,
    orderId: s.orderId,
    orderName: s.orderName,
    orderNumber: s.orderId.split("/").pop(),
    part: s.partCount > 1 ? `${s.partIndex} of ${s.partCount}` : null,
    partIndex: s.partIndex,
    orderCreatedAt: s.orderCreatedAt.toISOString(),
    customerName: s.customerName,
    shippingMethod: s.shippingMethod,
    country: s.country,
    province: s.province,
    state: s.state,
    packedAt: s.packedAt?.toISOString() ?? null,
    packedBy: s.packedBy,
    packOverride: s.packOverride,
    pkg: packageOf(s),
    lines,
    units,
    scanned,
    notice,
    // Acknowledged at the bench for the current version of the notice?
    packAcked: !notice || s.packAckKey === s.noticeKey,
    flags: flags?.get(s.orderId) ?? [],
    stockFlag: s.flag,
  };
}

async function binsFor(shop, shipments) {
  const ids = [...new Set(shipments.flatMap((s) => linesOf(s).map((l) => l.variantId)).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await db.productBin.findMany({ where: { shop, variantId: { in: ids } } });
  return new Map(rows.map((r) => [r.variantId, r.bin]));
}

// ---------------------------------------------------------------------------
// Packages: box and weight entered at the bench. Shopify doesn't let apps fill
// in its label page, so they're shown next to the label button to copy over.
// ---------------------------------------------------------------------------

export const WEIGHT_UNITS = ["lb", "oz", "kg", "g"];
export const DIM_UNITS = ["in", "cm"];
export const PACKAGE_STEPS = ["off", "ask", "required"];
const MAX_WEIGHT = { lb: 150, oz: 2400, kg: 70, g: 70000 };

export function packageOf(s) {
  if (s.pkgWeight == null && !s.pkgBox && s.pkgLength == null) return null;
  return {
    weight: s.pkgWeight,
    weightUnit: s.pkgWeightUnit,
    box: s.pkgBox,
    l: s.pkgLength,
    w: s.pkgWidth,
    h: s.pkgHeight,
    dimUnit: s.pkgDimUnit,
    at: s.pkgAt?.toISOString() ?? null,
    by: s.pkgBy,
  };
}

export const boxesOf = (settings) =>
  json(settings.boxes, [])
    .filter((b) => b && b.name)
    .map((b) => ({ id: String(b.id), name: String(b.name), l: Number(b.l) || null, w: Number(b.w) || null, h: Number(b.h) || null }));

export function packageSettingsOf(settings) {
  return {
    step: PACKAGE_STEPS.includes(settings.packageStep) ? settings.packageStep : "ask",
    weightUnit: WEIGHT_UNITS.includes(settings.weightUnit) ? settings.weightUnit : "lb",
    dimUnit: DIM_UNITS.includes(settings.dimUnit) ? settings.dimUnit : "in",
    boxes: boxesOf(settings),
    packedTag: settings.packedTag !== false,
  };
}

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

// Saves the box and weight for a packed shipment
export async function savePackage(shop, batchId, shipmentId, input, user) {
  const { b, s } = await loadBox(shop, batchId, shipmentId);
  if (s.state === "batched") throw new ShippingError(`Finish packing ${s.orderName} first.`);
  if (s.state === "shipped" || s.state === "closed") throw new ShippingError(`${s.orderName} has already shipped.`);
  const cfg = packageSettingsOf(await getShippingSettings(shop));
  const weight = num(input.weight);
  if (weight !== null && (Number.isNaN(weight) || weight <= 0 || weight > MAX_WEIGHT[cfg.weightUnit]))
    throw new ShippingError(`Enter the weight in ${cfg.weightUnit}, e.g. ${cfg.weightUnit === "lb" ? "1.4" : cfg.weightUnit === "kg" ? "0.6" : "22"}.`);
  if (cfg.step === "required" && weight === null) throw new ShippingError("Enter the weight.");
  let box = null;
  let dims = [null, null, null];
  const preset = input.boxId ? cfg.boxes.find((x) => x.id === String(input.boxId)) : null;
  if (preset) {
    box = preset.name;
    dims = [preset.l, preset.w, preset.h];
  } else {
    dims = [num(input.l), num(input.w), num(input.h)];
    if (dims.some((d) => d !== null && (Number.isNaN(d) || d <= 0 || d > 500))) throw new ShippingError("Enter the box size as three numbers, e.g. 12 × 9 × 3.");
    if (dims.some((d) => d !== null) && dims.some((d) => d === null)) throw new ShippingError("Enter all three box sides, or none.");
    box = String(input.boxName ?? "").trim().slice(0, 60) || null;
  }
  if (weight === null && !box && dims[0] === null) throw new ShippingError("Enter a weight or choose a box.");
  const data = {
    pkgWeight: weight,
    pkgWeightUnit: weight !== null ? cfg.weightUnit : null,
    pkgBox: box,
    pkgLength: dims[0],
    pkgWidth: dims[1],
    pkgHeight: dims[2],
    pkgDimUnit: dims[0] !== null ? cfg.dimUnit : null,
    pkgAt: new Date(),
    pkgBy: user?.name ?? null,
  };
  const saved = await db.shipment.update({ where: { id: s.id }, data });
  await logEvent(shop, {
    shipmentId: s.id,
    batchId: b.id,
    orderName: s.orderName,
    type: "package",
    detail: describePackage(packageOf(saved)),
    user,
  });
  return { ok: true, id: s.id, pkg: packageOf(saved) };
}

export async function savePackageSettings(shop, input, user) {
  const step = PACKAGE_STEPS.includes(input.step) ? input.step : null;
  const weightUnit = WEIGHT_UNITS.includes(input.weightUnit) ? input.weightUnit : null;
  const dimUnit = DIM_UNITS.includes(input.dimUnit) ? input.dimUnit : null;
  if (!step || !weightUnit || !dimUnit) throw new ShippingError("Choose a package setting and units.");
  let boxes = [];
  try {
    boxes = JSON.parse(String(input.boxes ?? "[]"));
  } catch {
    throw new ShippingError("The box list couldn't be read.");
  }
  if (!Array.isArray(boxes) || boxes.length > 50) throw new ShippingError("Up to 50 boxes.");
  const clean = [];
  for (const [i, x] of boxes.entries()) {
    const name = String(x?.name ?? "").trim().slice(0, 60);
    const d = [num(x?.l), num(x?.w), num(x?.h)];
    if (!name && d.every((v) => v === null)) continue;
    if (!name) throw new ShippingError(`Box ${i + 1} needs a name.`);
    if (d.some((v) => v === null || Number.isNaN(v) || v <= 0 || v > 500)) throw new ShippingError(`Enter all three sizes for "${name}".`);
    clean.push({ id: String(x?.id || `b${Date.now().toString(36)}${i}`), name, l: d[0], w: d[1], h: d[2] });
  }
  const before = await getShippingSettings(shop);
  await db.shippingSettings.update({
    where: { shop },
    data: { packageStep: step, weightUnit, dimUnit, boxes: JSON.stringify(clean), packedTag: Boolean(input.packedTag) },
  });
  await logEvent(shop, { type: "package_settings", detail: `${step}, ${weightUnit}/${dimUnit}, ${clean.length} box${clean.length === 1 ? "" : "es"}${input.packedTag ? ", Packed tag on" : ", Packed tag off"}`, user });
  if (before.packedTag !== Boolean(input.packedTag)) kick(shop, 2000);
  return packageSettingsOf({ packageStep: step, weightUnit, dimUnit, boxes: JSON.stringify(clean), packedTag: Boolean(input.packedTag) });
}

const trim = (n) => String(Math.round(n * 100) / 100);
export function describePackage(p) {
  if (!p) return "";
  const dims = p.l != null ? `${trim(p.l)} × ${trim(p.w)} × ${trim(p.h)} ${p.dimUnit}` : null;
  return [p.box, dims, p.weight != null ? `${trim(p.weight)} ${p.weightUnit}` : null].filter(Boolean).join(" · ");
}

// Shopify's order list with this batch's packed, not yet shipped orders, ready
// to select all and "Create shipping labels"
export const bulkLabelQuery = (tag) => `tag:${tag} tag:${PACKED_TAG} -fulfillment_status:shipped`;
export const PACKED_TAG = "Packed";

// The pack bench for a batch: the queue, oldest order first
export async function packQueue(shop, batchId) {
  const b = await batchFor(shop, batchId);
  const rows = await db.shipment.findMany({
    where: { batchId: b.id, state: { in: ["batched", "packed", "labeling", "shipped"] } },
    orderBy: shipmentOrder("oldest"),
  });
  const [flags, bins] = await Promise.all([flagsFor(shop, [...new Set(rows.map((r) => r.orderId))]), binsFor(shop, rows)]);
  const boxes = rows.map((s) => viewBox(s, flags, bins));
  const settings = await getShippingSettings(shop);
  const toLabel = rows.filter((r) => r.state === "packed" || r.state === "labeling");
  // Same items in every box? (bulk labels make sense then: one package, one weight)
  const contents = (s) =>
    linesOf(s)
      .map((l) => `${itemKey(l)}×${l.quantity}`)
      .sort()
      .join("|");
  const identical = rows.length > 0 && rows.every((r) => contents(r) === contents(rows[0]));
  return {
    pkg: packageSettingsOf(settings),
    bulk: {
      query: bulkLabelQuery(b.tag),
      ready: toLabel.filter((r) => r.packTagged).length,
      pending: settings.packedTag === false ? 0 : toLabel.filter((r) => !r.packTagged).length,
      tagging: settings.packedTag !== false,
      identical,
      complete: rows.length > 0 && rows.every((r) => r.state !== "batched"),
    },
    batch: { id: b.id, tag: b.tag, name: b.name, status: b.status, number: b.number, assignees: json(b.assignees, []), packStartedAt: b.packStartedAt?.toISOString() ?? null, packDoneAt: b.packDoneAt?.toISOString() ?? null },
    boxes,
    totals: { shipments: boxes.length, packed: boxes.filter((x) => x.state !== "batched").length },
    canPack: PACKABLE.includes(b.status),
  };
}

async function loadBox(shop, batchId, shipmentId) {
  const b = await batchFor(shop, batchId);
  if (!PACKABLE.includes(b.status)) throw new ShippingError(`${b.tag} needs to be picked before packing.`);
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId), batchId: b.id } });
  if (!s) throw new ShippingError(`That shipment isn't in ${b.tag}.`);
  return { b, s };
}

// Scan on the queue screen: an order barcode from the packing slip ("43712" / "#43712" / "43712-2")
export async function findBox(shop, batchId, code) {
  const b = await batchFor(shop, batchId);
  const m = /^#?\s*(\d+)(?:\s*[-/]\s*(\d+))?$/.exec(String(code ?? "").trim());
  if (!m) return { ok: false, error: `${code} isn't an order number. Scan the barcode on the packing slip.` };
  const rows = await db.shipment.findMany({
    where: { batchId: b.id, orderName: { in: [`#${m[1]}`, m[1]] }, state: { in: ["batched", "packed"] } },
    orderBy: { partIndex: "asc" },
  });
  const pick = m[2] ? rows.find((r) => r.partIndex === Number(m[2])) : rows.find((r) => r.state === "batched") ?? rows[0];
  if (!pick) return { ok: false, error: `Order ${m[1]}${m[2] ? ` part ${m[2]}` : ""} isn't in ${b.tag}.` };
  return { ok: true, id: pick.id };
}

export async function getBox(shop, batchId, shipmentId) {
  const { s } = await loadBox(shop, batchId, shipmentId);
  const [flags, bins] = await Promise.all([flagsFor(shop, [s.orderId]), binsFor(shop, [s])]);
  return viewBox(s, flags, bins);
}

async function startPackingBatch(b) {
  if (b.status === "picked") await db.batch.update({ where: { id: b.id }, data: { status: "packing", packStartedAt: new Date() } });
}

// When every shipment in the batch is packed, the batch is Packed (and back again if one is unpacked)
async function settleBatch(b) {
  const left = await db.shipment.count({ where: { batchId: b.id, state: "batched" } });
  const fresh = await db.batch.findUnique({ where: { id: b.id } });
  // Every box labelled and shipped: the batch is done
  const unshipped = await db.shipment.count({ where: { batchId: b.id, state: { in: ["batched", "packed", "labeling"] } } });
  const shipped = await db.shipment.count({ where: { batchId: b.id, state: "shipped" } });
  if (!unshipped && shipped && ["packing", "packed", "shipping"].includes(fresh.status)) {
    await db.batch.update({ where: { id: b.id }, data: { status: "done", packDoneAt: fresh.packDoneAt ?? new Date() } });
    return;
  }
  if (!left && fresh.status === "packing") await db.batch.update({ where: { id: b.id }, data: { status: "packed", packDoneAt: new Date() } });
  if (left && fresh.status === "packed") await db.batch.update({ where: { id: b.id }, data: { status: "packing", packDoneAt: null } });
}

async function markPacked(shop, b, s, user, override = null) {
  await db.shipment.update({
    where: { id: s.id },
    data: { state: "packed", packedAt: new Date(), packedBy: user?.name ?? null, packOverride: override },
  });
  await logEvent(shop, {
    shipmentId: s.id,
    batchId: b.id,
    orderName: s.orderName,
    type: override ? "packed_override" : "packed",
    detail: override ? `${b.tag}: packed without a full scan (${override})` : `${b.tag}: every item scanned`,
    user,
  });
  await settleBatch(b);
  // Puts the "Packed" tag on the order soon, for buying labels in bulk
  kick(shop, 3000);
}

// A scan at the bench: one unit of an item in this box
export async function packScan(shop, batchId, shipmentId, code, user) {
  const { b, s } = await loadBox(shop, batchId, shipmentId);
  if (s.state !== "batched") return { ok: false, error: `${s.orderName} is already packed.` };
  if (s.noticeKey && s.packAckKey !== s.noticeKey) return { ok: false, needsAck: true, error: "Read and acknowledge the note / address change first." };
  const c = norm(code);
  if (!c) return { ok: false, error: "Nothing scanned." };
  // An order barcode instead of an item: the packer wants another box
  if (/^#?\d+(?:-\d+)?$/.test(c) && !linesOf(s).some((l) => norm(l.barcode) === c || norm(l.sku) === c)) {
    const found = await findBox(shop, batchId, code);
    if (found.ok && found.id !== s.id) return { ok: false, switchTo: found.id, error: `That's another order's slip.` };
  }
  const lines = linesOf(s);
  const packed = json(s.packed, {});
  const matches = lines.filter((l) => norm(l.barcode) === c || norm(l.sku) === c);
  if (!matches.length) return { ok: false, code, error: `${code} isn't in ${s.orderName}. Don't pack it.` };
  const line = matches.find((l) => (packed[itemKey(l)] ?? 0) < l.quantity) ?? matches[0];
  const key = itemKey(line);
  if ((packed[key] ?? 0) >= line.quantity) return { ok: false, code, key, error: `Already have all ${line.quantity} × ${label(line)} for ${s.orderName}.` };

  await startPackingBatch(b);
  // Save the count; retried if two scans land at once
  let saved = null;
  let row = s;
  for (let attempt = 0; attempt < 6 && !saved; attempt++) {
    const counts = json(row.packed, {});
    if ((counts[key] ?? 0) >= line.quantity) return { ok: false, code, key, error: `Already have all ${line.quantity} × ${label(line)} for ${s.orderName}.` };
    counts[key] = (counts[key] ?? 0) + 1;
    const r = await db.shipment.updateMany({ where: { id: s.id, updatedAt: row.updatedAt, state: "batched" }, data: { packed: JSON.stringify(counts) } });
    if (r.count) saved = counts;
    else row = await db.shipment.findUnique({ where: { id: s.id } });
  }
  if (!saved) throw new ShippingError("Couldn't save that scan; please scan again.");
  const complete = lines.every((l) => (saved[itemKey(l)] ?? 0) >= l.quantity);
  if (complete) await markPacked(shop, b, s, user);
  return { ok: true, code, key, scanned: saved[key], qty: line.quantity, title: label(line), complete };
}

// Pack without a full scan (damaged barcode, item swapped with the customer's OK...)
export async function overridePack(shop, batchId, shipmentId, reason, user) {
  const { b, s } = await loadBox(shop, batchId, shipmentId);
  if (s.state !== "batched") throw new ShippingError(`${s.orderName} is already packed.`);
  if (s.noticeKey && s.packAckKey !== s.noticeKey) throw new ShippingError("Read and acknowledge the note / address change first.");
  const why = String(reason ?? "").trim();
  if (!why) throw new ShippingError('Give a reason, e.g. "Barcode damaged, checked by eye".');
  await startPackingBatch(b);
  await markPacked(shop, b, s, user, `${user?.name ?? "Staff"}: ${why.slice(0, 280)}`);
  return { ok: true };
}

// Start the box again: counts cleared, back to "to pack", notice must be acknowledged again
export async function unpack(shop, batchId, shipmentId, user) {
  const { b, s } = await loadBox(shop, batchId, shipmentId);
  if (!["batched", "packed"].includes(s.state)) throw new ShippingError(`${s.orderName} has moved on from packing.`);
  await db.shipment.update({
    where: { id: s.id },
    data: {
      state: "batched", packed: null, packedAt: null, packedBy: null, packOverride: null, packAckKey: null,
      pkgWeight: null, pkgWeightUnit: null, pkgBox: null, pkgLength: null, pkgWidth: null, pkgHeight: null, pkgDimUnit: null, pkgAt: null, pkgBy: null,
    },
  });
  await logEvent(shop, { shipmentId: s.id, batchId: b.id, orderName: s.orderName, type: "unpacked", detail: b.tag, user });
  await settleBatch(b);
  kick(shop, 3000); // takes the "Packed" tag back off
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Labels, one box at a time: the packer buys the label on the order's Shopify
// page (apps can't buy Shopify Shipping labels). When that window closes we
// re-read the order: a bought label fulfils it, so the box becomes Shipped.
// ---------------------------------------------------------------------------

const FO_TRACKING = `#graphql
  query ($id: ID!) {
    fulfillmentOrder(id: $id) {
      id
      status
      fulfillments(first: 5) { nodes { createdAt trackingInfo(first: 2) { company number url } } }
    }
  }`;

export async function labelCheck(shop, admin, batchId, shipmentId) {
  const { b, s } = await loadBox(shop, batchId, shipmentId);
  if (isSandboxShop(shop)) return { ok: true, shipped: false, sandbox: true };
  await syncOrder(shop, admin, s.orderId);
  const fresh = await db.shipment.findUnique({ where: { id: s.id } });
  let tracking = [];
  if (fresh.state === "shipped") {
    const justNow = s.state !== "shipped";
    const data = await gql(admin, FO_TRACKING, { id: s.fulfillmentOrderId }).catch(() => null);
    tracking = (data?.fulfillmentOrder?.fulfillments?.nodes ?? []).flatMap((f) => f.trackingInfo).filter((t) => t.number);
    if (justNow) await logEvent(shop, {
      shipmentId: s.id,
      batchId: b.id,
      orderName: s.orderName,
      type: "label_bought",
      detail: tracking.length ? tracking.map((t) => `${t.company ?? ""} ${t.number}`.trim()).join(", ") : "Fulfilled in Shopify",
    });
    await settleBatch(b);
  }
  return { ok: true, shipped: fresh.state === "shipped", state: fresh.state, tracking };
}

// ---------------------------------------------------------------------------
// Packing slips
// ---------------------------------------------------------------------------

const SLIP_ADDRESSES = `#graphql
  query ($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order { id shippingAddress { validationResultSummary formatted(withName: true, withCompany: true) } }
    }
  }`;

// Slips for some shipments of a batch (all of it when ids is empty), queue order
export async function packingSlips(shop, admin, batchId, ids = []) {
  const b = await batchFor(shop, batchId);
  const rows = await db.shipment.findMany({
    where: { batchId: b.id, state: { in: ["batched", "packed", "labeling", "shipped"] }, ...(ids.length ? { id: { in: ids.map(Number) } } : {}) },
    orderBy: shipmentOrder("oldest"),
  });
  const bins = await binsFor(shop, rows);
  // Ship-to addresses need Shopify's customer-data approval; slips still print without them
  const addr = new Map();
  if (admin) {
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    for (let i = 0; i < orderIds.length; i += 50) {
      try {
        const res = await admin.graphql(SLIP_ADDRESSES, { variables: { ids: orderIds.slice(i, i + 50) } });
        const data = (await res.json())?.data;
        for (const n of data?.nodes ?? []) if (n?.id) addr.set(n.id, n.shippingAddress ?? null);
      } catch {
        break;
      }
    }
  }
  return {
    batch: { id: b.id, tag: b.tag, name: b.name },
    slips: rows.map((s) => {
      const a = addr.get(s.orderId);
      const n = noticeOf(s);
      return {
        id: s.id,
        orderName: s.orderName,
        barcode: `${s.orderName.replace(/^#/, "")}${s.partCount > 1 ? `-${s.partIndex}` : ""}`,
        part: s.partCount > 1 ? `${s.partIndex} of ${s.partCount}` : null,
        orderCreatedAt: s.orderCreatedAt.toISOString(),
        customerName: s.customerName,
        shippingMethod: s.shippingMethod,
        shipTo: a?.formatted?.length
          ? a.formatted
          : n?.shipTo?.length
            ? n.shipTo
            : [s.customerName, [s.province, s.country].filter(Boolean).join(", ")].filter(Boolean),
        note: n?.note ?? s.orderNote ?? null,
        addressWarning: ["WARNING", "ERROR"].includes(a?.validationResultSummary) ? a.validationResultSummary : (n?.address?.level ?? null),
        lines: linesOf(s).map((l) => ({ title: l.title, variantTitle: l.variantTitle, qty: l.quantity, sku: l.sku, bin: bins.get(l.variantId) ?? null })),
      };
    }),
  };
}

export { staffKeyOf };
