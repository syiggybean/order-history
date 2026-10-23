import db from "./db.server";
import { ShippingError, getShippingSettings, isSandboxShop, linesOf, logEvent, syncOrder } from "./shipping.server";
import { boxesOf, packageSettingsOf } from "./pack.server";
import { errorMessage, gql } from "./preorders.server";
import { unauthenticated } from "./shopify.server";

// ---------------------------------------------------------------------------
// Shipping labels bought in the app (Shopify Shipping, API 2026-07+).
//
// - One box at the pack bench, using the box and weight entered there.
// - A whole batch at once when every box holds the same items, before or
//   after packing, with one box/weight for all.
// - Buying a label fulfils the order in Shopify. A box labelled before it's
//   packed stays on the pack bench until it's packed, then counts as shipped.
// - The label files (PDF or ZPL) come back from Shopify for printing and
//   downloading. Voiding a label is still done on the order's Shopify page.
//
// Needs: write_orders + write_merchant_managed_fulfillment_orders, the
// Shopify Shipping terms accepted, and staff with "Buy shipping labels".
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const testing = () => process.env.NODE_ENV === "test";
const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

const WEIGHT = { lb: "POUNDS", oz: "OUNCES", kg: "KILOGRAMS", g: "GRAMS" };
const LENGTH = { in: "INCHES", cm: "CENTIMETERS" };

const PURCHASE = `#graphql
  mutation LabelPurchase($input: ShippingLabelPurchaseInput!) {
    shippingLabelPurchase(shippingLabelPurchase: $input) {
      shippingLabelPurchaseResult { id status done }
      userErrors { field message code }
    }
  }`;

const RESULT = `#graphql
  query LabelPurchaseResult($id: ID!) {
    node(id: $id) {
      ... on ShippingLabelPurchaseResult {
        id
        status
        done
        errors { code message }
        shippingLabels {
          id
          trackingInfo { company number url }
          shippingDocuments { documentType format url }
        }
      }
    }
  }`;

const LABEL = `#graphql
  query LabelDocs($id: ID!) {
    shippingLabel(id: $id) {
      id
      cancellable
      printed
      trackingInfo { company number url }
      shippingDocuments { documentType format url printedAt }
    }
  }`;

// The package for a box: an explicit choice (bulk "apply to all") wins, then
// what was entered at the bench, then the default box from settings
export function packageFor(s, cfg, override = null) {
  const o = override ?? {};
  const preset = o.boxId ? cfg.boxes.find((b) => b.id === String(o.boxId)) : null;
  const fromBench = s.pkgLength != null ? { l: s.pkgLength, w: s.pkgWidth, h: s.pkgHeight, dimUnit: s.pkgDimUnit, name: s.pkgBox } : null;
  const benchPreset = !fromBench && s.pkgBox ? cfg.boxes.find((b) => b.name === s.pkgBox) : null;
  const def = cfg.boxes.find((b) => b.id === cfg.defaultBoxId) ?? null;
  const box =
    (preset && { l: preset.l, w: preset.w, h: preset.h, dimUnit: cfg.dimUnit, name: preset.name, wt: preset.wt }) ||
    (o.l != null && { l: Number(o.l), w: Number(o.w), h: Number(o.h), dimUnit: cfg.dimUnit, name: o.boxName || null, wt: null }) ||
    (fromBench && { ...fromBench, wt: cfg.boxes.find((b) => b.name === s.pkgBox)?.wt ?? null }) ||
    (benchPreset && { l: benchPreset.l, w: benchPreset.w, h: benchPreset.h, dimUnit: cfg.dimUnit, name: benchPreset.name, wt: benchPreset.wt }) ||
    (def && { l: def.l, w: def.w, h: def.h, dimUnit: cfg.dimUnit, name: def.name, wt: def.wt });
  const weight = o.weight != null && o.weight !== "" ? { value: Number(o.weight), unit: cfg.weightUnit } : s.pkgWeight != null ? { value: s.pkgWeight, unit: s.pkgWeightUnit ?? cfg.weightUnit } : null;
  return { box: box || null, weight };
}

export function purchaseInput(s, pkg, { notify = true, shipDate = null } = {}) {
  if (!pkg.box || !(pkg.box.l > 0 && pkg.box.w > 0 && pkg.box.h > 0)) throw new ShippingError(`Choose a box (or enter its size) for ${s.orderName}.`);
  if (pkg.weight && !(pkg.weight.value > 0)) throw new ShippingError(`Enter a weight above 0 for ${s.orderName}.`);
  // Ship date: today (a few minutes ahead, it can't be in the past) or a chosen day at noon
  const now = Date.now();
  let when = new Date(now + 5 * 60 * 1000);
  if (shipDate && /^\d{4}-\d{2}-\d{2}$/.test(shipDate)) {
    const noon = new Date(`${shipDate}T12:00:00-08:00`);
    if (noon.getTime() > when.getTime()) when = noon;
  }
  return {
    fulfillmentOrderId: s.fulfillmentOrderId,
    shippingDatetime: when.toISOString(),
    notifyCustomer: Boolean(notify),
    packageInfo: {
      customPackage: {
        type: "BOX",
        dimensions: { length: pkg.box.l, width: pkg.box.w, height: pkg.box.h, unit: LENGTH[pkg.box.dimUnit] ?? "INCHES" },
        weight: { value: Number(pkg.box.wt) > 0 ? Number(pkg.box.wt) : 0, unit: WEIGHT[pkg.weight?.unit] ?? "POUNDS" },
      },
    },
    ...(pkg.weight ? { totalWeight: { value: pkg.weight.value, unit: WEIGHT[pkg.weight.unit] ?? "POUNDS" } } : {}),
  };
}

const trackingOf = (label) => (label?.trackingInfo ? [label.trackingInfo].flat().filter((t) => t?.number) : []);

// The shipment belongs to that batch (people limited to their batches are checked on the batch)
export async function assertInBatch(shop, batchId, shipmentId) {
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId), batchId: Number(batchId) }, select: { id: true } });
  if (!s) throw new ShippingError("That shipment isn't in this batch.");
}

// Buys one label. Returns { ok, id, orderName, tracking } or { ok:false, error }.
export async function buyLabel(shop, admin, shipmentId, options = {}, user) {
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId) } });
  if (!s) throw new ShippingError("That shipment couldn't be found.");
  if (isSandboxShop(shop)) throw new ShippingError("Labels can't be bought in the sandbox.");
  if (s.labelId && s.labelStatus === "bought") return { ok: true, id: s.id, orderName: s.orderName, already: true, tracking: json(s.labelTracking, []) };
  if (s.labelStatus === "buying" && s.labelResultId) return finishPurchase(shop, admin, s, user);
  if (!["batched", "packed"].includes(s.state)) throw new ShippingError(`${s.orderName} can't have a label bought now (${s.state}).`);
  if (s.state === "batched" && !options.beforePacking) throw new ShippingError(`Pack ${s.orderName} first, or buy labels for the whole batch.`);
  const cfg = await labelConfig(shop);
  const pkg = packageFor(s, cfg, options.override);
  const input = purchaseInput(s, pkg, { notify: options.notify ?? cfg.notify, shipDate: options.shipDate });

  await db.shipment.update({ where: { id: s.id }, data: { labelStatus: "buying", labelError: null, labelEarly: s.state === "batched" } });
  let data;
  try {
    data = await gql(admin, PURCHASE, { input });
  } catch (e) {
    await db.shipment.update({ where: { id: s.id }, data: { labelStatus: "failed", labelError: errorMessage(e).slice(0, 500) } });
    return { ok: false, id: s.id, orderName: s.orderName, error: errorMessage(e) };
  }
  const r = data?.shippingLabelPurchase;
  const errs = r?.userErrors ?? [];
  if (errs.length || !r?.shippingLabelPurchaseResult?.id) {
    const msg = friendly(errs) || "Shopify didn't start the purchase.";
    await db.shipment.update({ where: { id: s.id }, data: { labelStatus: "failed", labelError: msg.slice(0, 500) } });
    return { ok: false, id: s.id, orderName: s.orderName, error: msg };
  }
  const fresh = await db.shipment.update({ where: { id: s.id }, data: { labelResultId: r.shippingLabelPurchaseResult.id } });
  return finishPurchase(shop, admin, fresh, user);
}

const FRIENDLY = {
  TERMS_OF_SERVICE_NOT_ACCEPTED: "Accept the Shopify Shipping terms in Shopify (Settings → Shipping and delivery) first.",
  ACCESS_DENIED: "You need Shopify's “Buy shipping labels” permission (ask the store owner to add it to your staff account).",
  RATES_NOT_FOUND: "Shopify found no shipping rates for this box. Check the address, box size and weight.",
  MISSING_SHIPPING_RATE: "Shopify found no shipping rates for this box. Check the address, box size and weight.",
  INVALID_PACKAGE_DIMENSIONS: "The box size isn't accepted by the carrier.",
  TOTAL_WEIGHT_ZERO: "Enter the weight (products have no weight set in Shopify).",
  MISSING_HS_CODE: "International: add HS codes to the products in Shopify.",
  MISSING_COUNTRY_OF_ORIGIN: "International: add the country of origin to the products in Shopify.",
  CARRIER_NOT_SUPPORTED: "This carrier can't be bought through apps (e.g. FedEx). Buy it on the order's Shopify page.",
  FULFILLMENT_ORDER_INVALID: "Shopify says this order can't be fulfilled right now (on hold, already fulfilled, or no address).",
  PHONE_NUMBER_NOT_FULLY_QUALIFIED_DESTINATION: "The customer's phone number needs a country code for this service.",
};
const friendly = (errs) => (errs ?? []).map((e) => FRIENDLY[e.code] ?? e.message).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" ");

// Waits for Shopify to finish an asynchronous purchase (up to ~45 seconds)
async function finishPurchase(shop, admin, s, user) {
  for (let i = 0; i < 30; i++) {
    const res = (await gql(admin, RESULT, { id: s.labelResultId }))?.node;
    if (res?.status === "PURCHASED" || (res?.done && res.shippingLabels?.length)) {
      const label = res.shippingLabels[0];
      const tracking = trackingOf(label);
      await db.shipment.update({
        where: { id: s.id },
        data: { labelStatus: "bought", labelId: label?.id ?? null, labelTracking: JSON.stringify(tracking), labelBoughtAt: new Date(), labelBoughtBy: user?.name ?? null, labelError: null },
      });
      await logEvent(shop, {
        shipmentId: s.id,
        batchId: s.batchId,
        orderName: s.orderName,
        type: "label_bought",
        detail: `${tracking.map((t) => `${t.company ?? ""} ${t.number}`.trim()).join(", ") || "Label bought"} (in the app${s.labelEarly ? ", before packing" : ""})`,
        user,
      });
      // The label fulfils the order: pick that up (a box not packed yet stays on the bench)
      await syncOrder(shop, admin, s.orderId).catch((e) => console.error("[labels] sync after purchase:", errorMessage(e)));
      return { ok: true, id: s.id, orderName: s.orderName, tracking };
    }
    if (res?.status === "PURCHASE_FAILED" || (res?.done && !res.shippingLabels?.length)) {
      const msg = friendly(res.errors) || "The carrier didn't sell the label.";
      await db.shipment.update({ where: { id: s.id }, data: { labelStatus: "failed", labelError: msg.slice(0, 500), labelResultId: null } });
      await logEvent(shop, { shipmentId: s.id, batchId: s.batchId, orderName: s.orderName, type: "label_failed", detail: msg, user });
      return { ok: false, id: s.id, orderName: s.orderName, error: msg };
    }
    await sleep(testing() ? 1 : 1500);
  }
  // Still going: leave it as buying; the next check (or a retry) picks it up
  return { ok: false, id: s.id, orderName: s.orderName, pending: true, error: "Shopify is still buying this label. Check again in a moment." };
}

// Labels for several boxes, one after another. Only for boxes with the same items.
export async function buyLabels(shop, admin, batchId, options = {}, user) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b) throw new ShippingError("That batch couldn't be found.");
  const rows = await db.shipment.findMany({ where: { batchId: b.id, state: { in: ["batched", "packed", "labeling", "shipped"] } }, orderBy: { orderCreatedAt: "asc" } });
  if (!identicalContents(rows)) throw new ShippingError(`Every box in ${b.tag} must hold the same items to buy labels for all of them at once.`);
  const todo = rows.filter((r) => ["batched", "packed"].includes(r.state) && r.labelStatus !== "bought");
  const results = [];
  for (const s of todo) {
    try {
      results.push(await buyLabel(shop, admin, s.id, { ...options, beforePacking: true }, user));
    } catch (e) {
      results.push({ ok: false, id: s.id, orderName: s.orderName, error: e instanceof ShippingError ? e.message : errorMessage(e) });
    }
    await sleep(testing() ? 0 : 300);
  }
  return { tag: b.tag, results, bought: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// The same, in the background: big batches take a few minutes. The page polls bulkStatus.
const bulkJobs = new Map(); // `${shop}|${batchId}` -> progress
export function bulkStatus(shop, batchId) {
  return bulkJobs.get(`${shop}|${Number(batchId)}`) ?? null;
}
export async function startBulkLabels(shop, batchId, options, user, { admin = null } = {}) {
  const key = `${shop}|${Number(batchId)}`;
  if (bulkJobs.get(key)?.running) throw new ShippingError("Labels for this batch are already being bought.");
  if (isSandboxShop(shop)) throw new ShippingError("Labels can't be bought in the sandbox.");
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b) throw new ShippingError("That batch couldn't be found.");
  const rows = await db.shipment.findMany({ where: { batchId: b.id, state: { in: ["batched", "packed", "labeling", "shipped"] } } });
  if (!identicalContents(rows)) throw new ShippingError(`Every box in ${b.tag} must hold the same items to buy labels for all of them at once.`);
  const todo = rows.filter((r) => ["batched", "packed"].includes(r.state) && r.labelStatus !== "bought");
  if (!todo.length) throw new ShippingError("Every box in this batch already has a label.");
  // Check the package before spending anything
  const cfg = await labelConfig(shop);
  purchaseInput(todo[0], packageFor(todo[0], cfg, options.override), options);
  const job = { running: true, total: todo.length, done: 0, bought: 0, failed: 0, results: [], startedAt: new Date().toISOString(), by: user?.name ?? null, tag: b.tag };
  bulkJobs.set(key, job);
  const p = (async () => {
    try {
      const client = admin ?? (await unauthenticated.admin(shop)).admin;
      for (const s of todo) {
        let r;
        try {
          r = await buyLabel(shop, client, s.id, { ...options, beforePacking: true }, user);
        } catch (e) {
          r = { ok: false, id: s.id, orderName: s.orderName, error: e instanceof ShippingError ? e.message : errorMessage(e) };
        }
        job.results.push({ id: r.id, orderName: r.orderName, ok: r.ok, error: r.error ?? null, tracking: r.tracking ?? [] });
        job.done++;
        if (r.ok) job.bought++;
        else job.failed++;
        // Account-wide problems: stop rather than fail every box the same way
        if (!r.ok && /terms|permission|Buy shipping labels/i.test(r.error ?? "")) {
          job.stopped = r.error;
          break;
        }
        await sleep(testing() ? 0 : 300);
      }
      await logEvent(shop, { batchId: b.id, type: "labels_bulk", detail: `${b.tag}: ${job.bought} label${job.bought === 1 ? "" : "s"} bought${job.failed ? `, ${job.failed} failed` : ""}`, user });
    } catch (e) {
      job.stopped = errorMessage(e);
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  })();
  if (testing()) await p;
  return job;
}

const contentsKey = (s) =>
  linesOf(s)
    .map((l) => `${l.variantId ?? `title:${l.title}|${l.variantTitle ?? ""}`}×${l.quantity}`)
    .sort()
    .join("|");
export const identicalContents = (rows) => rows.length > 0 && rows.every((r) => contentsKey(r) === contentsKey(rows[0]));

// Settings needed to buy: units, saved boxes (with empty weights), default box, notify
export async function labelConfig(shop) {
  const settings = await getShippingSettings(shop);
  const cfg = packageSettingsOf(settings);
  return { ...cfg, boxes: boxesOf(settings), defaultBoxId: settings.labelBoxId ?? null, notify: settings.labelNotify !== false };
}

// ---------------------------------------------------------------------------
// Label files
// ---------------------------------------------------------------------------

async function documentsFor(admin, labelId) {
  const label = (await gql(admin, LABEL, { id: labelId }))?.shippingLabel;
  if (!label) throw new ShippingError("Shopify couldn't find that label. It may have been voided.");
  return label;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new ShippingError(`The label file couldn't be downloaded (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

// One shipment's label: { filename, contentType, format, data (base64) }
export async function labelFile(shop, admin, shipmentId, user) {
  const s = await db.shipment.findFirst({ where: { shop, id: Number(shipmentId) } });
  if (!s?.labelId) throw new ShippingError("This label wasn't bought in the app, so its file isn't available here. Reprint it from the order's Shopify page.");
  const label = await documentsFor(admin, s.labelId);
  const doc = label.shippingDocuments.find((d) => d.documentType === "LABEL") ?? label.shippingDocuments[0];
  if (!doc?.url) throw new ShippingError("Shopify didn't return a label file.");
  const bytes = await download(doc.url);
  const format = doc.format === "ZPL" ? "ZPL" : "PDF";
  await db.shipment.update({ where: { id: s.id }, data: { labelPrintedAt: new Date() } });
  return {
    filename: `${s.orderName.replace(/^#/, "")}${s.partCount > 1 ? `-${s.partIndex}` : ""} label.${format === "ZPL" ? "zpl" : "pdf"}`,
    contentType: format === "ZPL" ? "text/plain" : "application/pdf",
    format,
    data: bytes.toString("base64"),
    customs: label.shippingDocuments.some((d) => d.documentType === "CUSTOMS_FORM"),
  };
}

// Every label in a batch bought in the app, as one file to print in one go
export async function batchLabelFile(shop, admin, batchId, user) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) } });
  if (!b) throw new ShippingError("That batch couldn't be found.");
  const rows = await db.shipment.findMany({ where: { batchId: b.id, labelId: { not: null }, labelStatus: "bought" }, orderBy: { orderCreatedAt: "asc" } });
  if (!rows.length) throw new ShippingError("No labels have been bought in the app for this batch yet.");
  const files = [];
  for (const s of rows) {
    const label = await documentsFor(admin, s.labelId);
    const doc = label.shippingDocuments.find((d) => d.documentType === "LABEL");
    if (doc?.url) files.push({ format: doc.format === "ZPL" ? "ZPL" : "PDF", bytes: await download(doc.url) });
  }
  await db.shipment.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { labelPrintedAt: new Date() } });
  if (files.every((f) => f.format === "ZPL")) {
    return { filename: `${b.tag} labels.zpl`, contentType: "text/plain", format: "ZPL", count: files.length, data: Buffer.from(files.map((f) => f.bytes.toString("utf8")).join("\n")).toString("base64") };
  }
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();
  for (const f of files.filter((x) => x.format === "PDF")) {
    const src = await PDFDocument.load(f.bytes);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return { filename: `${b.tag} labels.pdf`, contentType: "application/pdf", format: "PDF", count: files.length, data: Buffer.from(await out.save()).toString("base64") };
}

export const labelView = (s) => ({
  status: s.labelStatus ?? null,
  error: s.labelError ?? null,
  tracking: json(s.labelTracking, []),
  boughtAt: s.labelBoughtAt?.toISOString() ?? null,
  boughtBy: s.labelBoughtBy ?? null,
  printedAt: s.labelPrintedAt?.toISOString() ?? null,
  early: Boolean(s.labelEarly),
  inApp: Boolean(s.labelId),
});
