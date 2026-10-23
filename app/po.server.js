import { randomUUID } from "node:crypto";
import db from "./db.server";
import { errorMessage, gql } from "./preorders.server";
import { RECEIVE_ADDS_STOCK } from "./po-template";

// ---------------------------------------------------------------------------
// Purchase orders
//   pending  → open (emailed/exported, or by hand) → partial → received → closed
//   Lines come from a CSV (SKU, Supplier Code, Supplier Barcode, Title,
//   Quantity, Unit Cost, Tax Rate, Tax; Total is worked out). Lines are
//   matched to Shopify variants by SKU (then barcode) so receiving adds stock.
// ---------------------------------------------------------------------------

export class PoError extends Error {}

export const STATUSES = ["pending", "open", "partial", "received", "closed"];
export const STATUS_LABELS = { pending: "Pending", open: "Open", partial: "Partially received", received: "Received", closed: "Closed" };
export const PO_URI_PREFIX = "gid://order-history/PurchaseOrder/";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// RFC 4180-ish: quotes, doubled quotes, commas/newlines inside quotes, BOM,
// and semicolon- or tab-separated files from spreadsheets set to other locales
export function parseCsvText(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": (firstLine.match(/,/g) || []).length, ";": (firstLine.match(/;/g) || []).length, "\t": (firstLine.match(/\t/g) || []).length };
  const sep = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ""));
}

const HEADERS = {
  sku: ["sku", "item sku", "variant sku", "our sku"],
  supplierCode: ["supplier code", "supplier sku", "vendor code", "vendor sku", "supplier item code", "item code", "supplier part number"],
  supplierBarcode: ["supplier barcode", "barcode", "upc", "ean", "isbn", "gtin", "vendor barcode"],
  title: ["title", "description", "item", "name", "product", "product title", "item name"],
  quantity: ["quantity", "qty", "order qty", "units", "quantity ordered"],
  unitCost: ["unit cost", "cost", "unit price", "price", "cost price", "unit cost price"],
  taxRate: ["tax rate", "tax %", "tax percent", "vat rate", "gst rate", "tax rate %"],
  tax: ["tax", "tax amount", "vat", "gst", "line tax"],
  total: ["total", "line total", "amount", "total cost", "extended cost"],
};
const normHeader = (h) => String(h ?? "").trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").replace(/[()]/g, "");

export function mapHeaders(row) {
  const map = {};
  row.forEach((h, i) => {
    const n = normHeader(h);
    for (const [key, names] of Object.entries(HEADERS)) {
      if (map[key] === undefined && names.includes(n)) map[key] = i;
    }
  });
  return map;
}

// "$1,234.50", "1.234,50" (European), "(5.00)" → numbers
export function parseMoney(v) {
  let s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()\s$€£¥]/g, "").replace(/^-/, "");
  if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^\d+,\d{1,4}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

// "8.25", "8.25%", "0.0825" → 8.25 (percent)
export function parseRate(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const hasPct = s.includes("%");
  const n = parseMoney(s.replace("%", ""));
  if (n === null || Number.isNaN(n)) return NaN;
  return hasPct || n >= 1 ? n : round4(n * 100);
}

// A line's numbers. Tax: the file's figure if given, else quantity × cost × rate.
export function lineMath({ quantity, unitCost, taxRate, tax }) {
  const net = round2(quantity * unitCost);
  const t = tax === null || tax === undefined || Number.isNaN(tax) ? round2((net * (taxRate || 0)) / 100) : round2(tax);
  return { net, tax: t, total: round2(net + t) };
}

// Text of a CSV → lines plus any problems, ready to preview
export function linesFromCsv(text) {
  const rows = parseCsvText(text);
  if (rows.length < 2) throw new PoError("The file needs a header row and at least one line.");
  const map = mapHeaders(rows[0]);
  const missing = ["title", "quantity", "unitCost"].filter((k) => map[k] === undefined);
  if (map.sku === undefined && map.supplierCode === undefined && map.supplierBarcode === undefined) missing.push("sku");
  if (missing.length) {
    const names = { title: "Title", quantity: "Quantity", unitCost: "Unit Cost", sku: "SKU (or Supplier Code / Supplier Barcode)" };
    throw new PoError(`Couldn't find these columns: ${missing.map((m) => names[m]).join(", ")}. Expected headers: SKU, Supplier Code, Supplier Barcode, Title, Quantity, Unit Cost, Tax Rate, Tax.`);
  }
  const cell = (r, k) => (map[k] === undefined ? "" : String(r[map[k]] ?? "").trim());
  const lines = [];
  const warnings = [];
  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const title = cell(r, "title");
    const qtyRaw = parseMoney(cell(r, "quantity"));
    if (!title && !cell(r, "sku") && (qtyRaw === null || qtyRaw === 0)) return; // blank / totals row
    if (/^(sub)?total|^tax$|^grand total/i.test(title) && !cell(r, "sku")) return; // a summary row at the bottom
    const problems = [];
    const quantity = qtyRaw === null || Number.isNaN(qtyRaw) ? NaN : qtyRaw;
    if (!Number.isInteger(quantity) || quantity <= 0) problems.push("quantity must be a whole number above 0");
    const unitCost = parseMoney(cell(r, "unitCost"));
    if (unitCost === null || Number.isNaN(unitCost) || unitCost < 0) problems.push("unit cost isn't a number");
    const taxRate = parseRate(cell(r, "taxRate"));
    if (Number.isNaN(taxRate) || taxRate < 0 || taxRate > 100) problems.push("tax rate isn't a percentage");
    const taxIn = parseMoney(cell(r, "tax"));
    if (Number.isNaN(taxIn)) problems.push("tax isn't a number");
    if (problems.length) {
      warnings.push({ row: rowNo, level: "error", text: `Row ${rowNo}${title ? ` (${title})` : ""}: ${problems.join(", ")}.` });
      return;
    }
    const m = lineMath({ quantity, unitCost, taxRate: taxRate ?? 0, tax: taxIn });
    // Tax given and rate given but they disagree
    if (taxIn !== null && taxRate) {
      const expect = round2((m.net * taxRate) / 100);
      if (Math.abs(expect - m.tax) > 0.01) warnings.push({ row: rowNo, level: "warning", text: `Row ${rowNo} (${title}): tax ${m.tax.toFixed(2)} doesn't match ${taxRate}% of ${m.net.toFixed(2)} (${expect.toFixed(2)}). The file's tax was kept.` });
    }
    const totalIn = parseMoney(cell(r, "total"));
    if (totalIn !== null && !Number.isNaN(totalIn) && Math.abs(totalIn - m.total) > 0.01) {
      warnings.push({ row: rowNo, level: "warning", text: `Row ${rowNo} (${title}): the file's total ${totalIn.toFixed(2)} was replaced with ${m.total.toFixed(2)} (quantity × unit cost + tax).` });
    }
    lines.push({
      sku: cell(r, "sku") || null,
      supplierCode: cell(r, "supplierCode") || null,
      supplierBarcode: cell(r, "supplierBarcode") || null,
      title: title || cell(r, "sku") || "(no title)",
      quantity,
      unitCost: round4(unitCost),
      taxRate: taxRate ?? 0,
      tax: m.tax,
      total: m.total,
      // No rate and no tax in the file: the supplier's default can fill it in
      ...(taxRate === null && taxIn === null ? { noRate: true } : {}),
    });
  });
  if (!lines.length) throw new PoError(warnings.length ? "None of the rows could be read. See the problems listed." : "The file has no lines.");
  const sum = totalsOf(lines);
  return { lines, warnings, totals: sum };
}

export function totalsOf(lines) {
  const subtotal = round2(lines.reduce((t, l) => t + round2(l.quantity * l.unitCost), 0));
  const taxTotal = round2(lines.reduce((t, l) => t + l.tax, 0));
  return { subtotal, taxTotal, total: round2(subtotal + taxTotal), units: lines.reduce((t, l) => t + l.quantity, 0) };
}

// ---------------------------------------------------------------------------
// Settings, suppliers, locations
// ---------------------------------------------------------------------------

export async function getPoSettings(shop) {
  return db.poSettings.upsert({ where: { shop }, create: { shop }, update: {} });
}

const LOCATIONS = `#graphql
  query PoLocations { locations(first: 50) { nodes { id name isActive address { formatted } } } }`;

export async function listLocations(admin) {
  const data = await gql(admin, LOCATIONS);
  return (data?.locations?.nodes ?? []).filter((l) => l.isActive).map((l) => ({ id: l.id, name: l.name, address: (l.address?.formatted ?? []).join("\n") }));
}

export async function savePoSettings(shop, input) {
  const prefix = String(input.prefix ?? "PO-").replace(/[^A-Za-z0-9\-_/#]/g, "").slice(0, 12);
  return db.poSettings.update({
    where: { shop },
    data: {
      prefix: prefix || "PO-",
      locationId: input.locationId || null,
      ...(input.emailSubject !== undefined ? { emailSubject: String(input.emailSubject).slice(0, 300) || null } : {}),
      ...(input.emailBody !== undefined ? { emailBody: String(input.emailBody).slice(0, 10000) || null } : {}),
    },
  });
}

export async function listSuppliers(shop, { archived = false } = {}) {
  return db.supplier.findMany({ where: { shop, ...(archived ? {} : { archived: false }) }, orderBy: { name: "asc" } });
}

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s.]{2,}$/;
export const splitEmails = (s) =>
  String(s ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

// A supplier's points of contact (up to 3). Suppliers saved before contacts existed:
// their contact name/phone and email list become the contacts, all getting POs as before.
export const MAX_CONTACTS = 3;
const cleanContact = (c) => ({
  name: String(c?.name ?? "").trim().slice(0, 120),
  role: String(c?.role ?? "").trim().slice(0, 80),
  email: String(c?.email ?? "").trim().toLowerCase().slice(0, 200),
  phone: String(c?.phone ?? "").trim().slice(0, 60),
  getsPo: Boolean(c?.getsPo),
});
export function contactsOf(s) {
  let saved = null;
  try {
    saved = s?.contacts ? JSON.parse(s.contacts) : null;
  } catch {
    saved = null;
  }
  if (Array.isArray(saved)) return saved.slice(0, MAX_CONTACTS).map(cleanContact);
  const emails = splitEmails(s?.emails);
  const list = [];
  if (s?.contact || s?.phone || emails.length) list.push({ name: s?.contact ?? "", role: "", email: emails[0] ?? "", phone: s?.phone ?? "", getsPo: Boolean(emails[0]) });
  for (const e of emails.slice(1, MAX_CONTACTS)) list.push({ name: "", role: "", email: e, phone: "", getsPo: true });
  return list;
}
// Who gets a PO unless someone picks otherwise
export const poRecipients = (contacts) => contacts.filter((c) => c.getsPo && c.email);

// A PO's supplier contacts as they are now (or, if the supplier was removed, the emails saved on the PO)
export async function poContacts(shop, po) {
  const s = po.supplierId ? await db.supplier.findFirst({ where: { shop, id: Number(po.supplierId) } }) : null;
  if (s) return contactsOf(s);
  return splitEmails(po.supplierEmails).map((email) => ({ name: "", role: "", email, phone: "", getsPo: true }));
}

export async function saveSupplier(shop, input) {
  const name = String(input.name ?? "").trim().slice(0, 120);
  if (!name) throw new PoError("The supplier needs a name.");
  const contacts = (Array.isArray(input.contacts) ? input.contacts : contactsOf(input)).map(cleanContact).filter((c) => c.name || c.email || c.phone || c.role);
  if (contacts.length > MAX_CONTACTS) throw new PoError(`Up to ${MAX_CONTACTS} contacts per supplier.`);
  const bad = contacts.filter((c) => c.email && !EMAIL.test(c.email)).map((c) => c.email);
  if (bad.length) throw new PoError(`Not a valid email: ${bad.join(", ")}`);
  for (const c of contacts) if (!c.email) c.getsPo = false;
  // Someone with an email should get POs: the first one, if nobody was chosen
  if (!contacts.some((c) => c.getsPo)) {
    const first = contacts.find((c) => c.email);
    if (first) first.getsPo = true;
  }
  const emails = poRecipients(contacts).map((c) => c.email);
  const rate = input.taxRate === "" || input.taxRate == null ? null : parseRate(input.taxRate);
  if (Number.isNaN(rate) || rate < 0 || rate > 100) throw new PoError("Default tax rate should be a percentage, e.g. 8.25.");
  const data = {
    name,
    emails: emails.join(", ") || null,
    contacts: JSON.stringify(contacts),
    // The first contact, for anything that reads a single contact
    contact: contacts[0]?.name || null,
    phone: contacts[0]?.phone || null,
    address: String(input.address ?? "").trim().slice(0, 1000) || null,
    taxRate: rate,
    notes: String(input.notes ?? "").trim().slice(0, 2000) || null,
    archived: Boolean(input.archived),
  };
  if (input.id) {
    const s = await db.supplier.findFirst({ where: { shop, id: Number(input.id) } });
    if (!s) throw new PoError("That supplier couldn't be found.");
    return db.supplier.update({ where: { id: s.id }, data });
  }
  return db.supplier.create({ data: { shop, ...data } });
}

// ---------------------------------------------------------------------------
// Matching lines to Shopify
// ---------------------------------------------------------------------------

const VARIANTS = `#graphql
  query PoVariants($q: String!) {
    productVariants(first: 250, query: $q) {
      nodes { id sku barcode displayName inventoryItem { id } product { featuredMedia { preview { image { url } } } } }
    }
  }`;

const quote = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;

// Finds each line's Shopify variant: SKU first, then the supplier barcode
export async function matchLines(admin, lines) {
  const skus = [...new Set(lines.map((l) => l.sku).filter(Boolean))];
  const barcodes = [...new Set(lines.filter((l) => l.supplierBarcode).map((l) => l.supplierBarcode))];
  const bySku = new Map();
  const byBarcode = new Map();
  const run = async (field, values, into) => {
    for (let i = 0; i < values.length; i += 40) {
      const q = values.slice(i, i + 40).map((v) => `${field}:${quote(v)}`).join(" OR ");
      const data = await gql(admin, VARIANTS, { q });
      for (const v of data?.productVariants?.nodes ?? []) {
        const key = String(field === "sku" ? v.sku : v.barcode ?? "").trim().toLowerCase();
        if (key && !into.has(key)) into.set(key, v);
      }
    }
  };
  await run("sku", skus, bySku);
  await run("barcode", barcodes, byBarcode);
  return lines.map((l) => {
    const v = (l.sku && bySku.get(l.sku.toLowerCase())) || (l.supplierBarcode && byBarcode.get(l.supplierBarcode.toLowerCase())) || null;
    return {
      ...l,
      variantId: v?.id ?? null,
      inventoryItemId: v?.inventoryItem?.id ?? null,
      shopifyTitle: v?.displayName ?? null,
      imageUrl: v?.product?.featuredMedia?.preview?.image?.url ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// POs
// ---------------------------------------------------------------------------

async function logPo(shop, poId, type, detail, user) {
  await db.purchaseOrderEvent.create({ data: { shop, poId, type, detail: detail ?? null, by: user?.name ?? null } });
}

export async function getPo(shop, id) {
  const po = await db.purchaseOrder.findFirst({ where: { shop, id: Number(id) } });
  if (!po) throw new PoError("That purchase order couldn't be found.");
  return po;
}

export async function createPo(shop, admin, { lines, supplierId, locationId, expectedAt, supplierNote, sourceFile, currency }, user) {
  if (!Array.isArray(lines) || !lines.length) throw new PoError("Add at least one line.");
  if (lines.length > 2000) throw new PoError("Up to 2,000 lines per PO.");
  const supplier = supplierId ? await db.supplier.findFirst({ where: { shop, id: Number(supplierId) } }) : null;
  if (supplierId && !supplier) throw new PoError("That supplier couldn't be found.");
  const clean = lines.map((l, i) => {
    const quantity = Math.round(Number(l.quantity));
    const unitCost = round4(Number(l.unitCost));
    const useDefault = l.noRate && supplier?.taxRate != null;
    const taxRate = useDefault ? supplier.taxRate : Number(l.taxRate) || 0;
    if (useDefault) l = { ...l, tax: null };
    if (!Number.isFinite(quantity) || quantity <= 0) throw new PoError(`Line ${i + 1}: quantity must be above 0.`);
    if (!Number.isFinite(unitCost) || unitCost < 0) throw new PoError(`Line ${i + 1}: unit cost isn't a number.`);
    const m = lineMath({ quantity, unitCost, taxRate, tax: l.tax === "" || l.tax == null ? null : Number(l.tax) });
    return {
      sku: l.sku ? String(l.sku).slice(0, 120) : null,
      supplierCode: l.supplierCode ? String(l.supplierCode).slice(0, 120) : null,
      supplierBarcode: l.supplierBarcode ? String(l.supplierBarcode).slice(0, 120) : null,
      title: String(l.title ?? "").slice(0, 500) || "(no title)",
      quantity,
      unitCost,
      taxRate,
      tax: m.tax,
      total: m.total,
    };
  });
  const settings = await getPoSettings(shop);
  let matched = clean;
  let location = null;
  try {
    matched = await matchLines(admin, clean);
    const locs = await listLocations(admin);
    location = locs.find((l) => l.id === (locationId || settings.locationId)) ?? locs[0] ?? null;
  } catch (e) {
    console.error("[po] matching:", errorMessage(e));
  }
  const totals = totalsOf(matched);
  // Next number, safely
  const st = await db.poSettings.update({ where: { shop }, data: { counter: { increment: 1 } } });
  const po = await db.purchaseOrder.create({
    data: {
      shop,
      number: st.counter,
      poNumber: `${st.prefix}${String(st.counter).padStart(4, "0")}`,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      supplierEmails: supplier?.emails ?? null,
      supplierAddress: supplier?.address ?? null,
      currency: currency || "USD",
      locationId: location?.id ?? null,
      locationName: location?.name ?? null,
      expectedAt: expectedAt ? new Date(expectedAt) : null,
      supplierNote: String(supplierNote ?? "").trim().slice(0, 2000) || null,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      sourceFile: sourceFile ? String(sourceFile).slice(0, 200) : null,
      createdBy: user?.name ?? null,
    },
  });
  await db.purchaseOrderLine.createMany({ data: matched.map((l, i) => ({ ...l, poId: po.id, position: i + 1 })) });
  await logPo(shop, po.id, "created", `${matched.length} line${matched.length === 1 ? "" : "s"}${sourceFile ? ` from ${sourceFile}` : ""}`, user);
  return po;
}

export async function updatePo(shop, admin, id, input, user) {
  const po = await getPo(shop, id);
  if (po.status === "closed") throw new PoError("Closed POs can't be changed.");
  const data = {};
  if (input.supplierId !== undefined) {
    const s = input.supplierId ? await db.supplier.findFirst({ where: { shop, id: Number(input.supplierId) } }) : null;
    Object.assign(data, { supplierId: s?.id ?? null, supplierName: s?.name ?? null, supplierEmails: s?.emails ?? null, supplierAddress: s?.address ?? null });
  }
  if (input.expectedAt !== undefined) data.expectedAt = input.expectedAt ? new Date(input.expectedAt) : null;
  if (input.supplierNote !== undefined) data.supplierNote = String(input.supplierNote ?? "").trim().slice(0, 2000) || null;
  if (input.locationId !== undefined) {
    if (po.status !== "pending" && po.status !== "open") throw new PoError("The receiving location can't change once items have been received.");
    const locs = await listLocations(admin);
    const l = locs.find((x) => x.id === input.locationId);
    if (!l) throw new PoError("That location couldn't be found.");
    Object.assign(data, { locationId: l.id, locationName: l.name });
  }
  if (input.lines !== undefined) {
    if (po.status !== "pending") throw new PoError("Lines can only be changed while the PO is pending.");
    // Check-ins point at these lines: replacing them would lose the counts
    if (await db.purchaseOrderLine.count({ where: { poId: po.id, checkedIn: { gt: 0 } } })) {
      throw new PoError("Items on this PO have been checked in on the Receiving page, so its lines can't be changed. Undo those check-ins first.");
    }
    const lines = input.lines.map((l, i) => {
      const quantity = Math.round(Number(l.quantity));
      const unitCost = round4(Number(l.unitCost));
      if (!Number.isFinite(quantity) || quantity <= 0) throw new PoError(`Line ${i + 1}: quantity must be above 0.`);
      if (!Number.isFinite(unitCost) || unitCost < 0) throw new PoError(`Line ${i + 1}: unit cost isn't a number.`);
      const taxRate = Number(l.taxRate) || 0;
      const m = lineMath({ quantity, unitCost, taxRate, tax: l.taxOverride ? Number(l.tax) : null });
      return { sku: l.sku || null, supplierCode: l.supplierCode || null, supplierBarcode: l.supplierBarcode || null, title: String(l.title ?? "") || "(no title)", quantity, unitCost, taxRate, tax: m.tax, total: m.total };
    });
    if (!lines.length) throw new PoError("Keep at least one line.");
    let matched = lines;
    try {
      matched = await matchLines(admin, lines);
    } catch (e) {
      console.error("[po] matching:", errorMessage(e));
    }
    await db.purchaseOrderLine.deleteMany({ where: { poId: po.id } });
    await db.purchaseOrderLine.createMany({ data: matched.map((l, i) => ({ ...l, poId: po.id, position: i + 1 })) });
    Object.assign(data, totalsOf(matched));
    delete data.units;
  }
  const out = await db.purchaseOrder.update({ where: { id: po.id }, data });
  await logPo(shop, po.id, "edited", Object.keys(input).join(", "), user);
  return out;
}

export async function rematch(shop, admin, id, user) {
  const po = await getPo(shop, id);
  const lines = await db.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { position: "asc" } });
  const matched = await matchLines(admin, lines);
  let n = 0;
  for (const l of matched) {
    await db.purchaseOrderLine.update({ where: { id: l.id }, data: { variantId: l.variantId, inventoryItemId: l.inventoryItemId, shopifyTitle: l.shopifyTitle, imageUrl: l.imageUrl } });
    if (l.variantId) n++;
  }
  await logPo(shop, po.id, "matched", `${n} of ${lines.length} lines found in Shopify`, user);
  return { matched: n, of: lines.length };
}

// Status changes staff can make by hand
export async function setStatus(shop, id, to, user) {
  const po = await getPo(shop, id);
  const allowed = {
    open: ["pending"],
    pending: ["open"],
    closed: ["open", "partial", "received"],
    reopen: ["closed"],
  };
  if (!allowed[to]?.includes(po.status)) throw new PoError(`A ${STATUS_LABELS[po.status].toLowerCase()} PO can't be ${to === "reopen" ? "reopened" : `marked ${to}`}.`);
  const now = new Date();
  let data;
  if (to === "open") data = { status: "open", openedAt: po.openedAt ?? now };
  else if (to === "pending") data = { status: "pending" };
  else if (to === "closed") data = { status: "closed", closedAt: now, closedBy: user?.name ?? null };
  else data = { status: await receivedStatus(po.id), closedAt: null, closedBy: null };
  const out = await db.purchaseOrder.update({ where: { id: po.id }, data });
  await logPo(shop, po.id, "status", `${STATUS_LABELS[po.status]} → ${STATUS_LABELS[out.status]}`, user);
  return out;
}

// Sending or exporting a pending PO opens it
export async function markSent(shop, id, { how, to = null }, user) {
  const po = await getPo(shop, id);
  const now = new Date();
  const data = how === "email" ? { sentAt: now, sentTo: to } : { exportedAt: now };
  if (po.status === "pending") Object.assign(data, { status: "open", openedAt: now });
  await db.purchaseOrder.update({ where: { id: po.id }, data });
  await logPo(shop, po.id, how === "email" ? "emailed" : "exported", how === "email" ? `To ${to}` : "PDF", user);
  if (po.status === "pending") await logPo(shop, po.id, "status", "Pending → Open", user);
}

export async function deletePo(shop, id, user) {
  const po = await getPo(shop, id);
  if (po.status !== "pending") throw new PoError("Only pending POs can be deleted. Close it instead.");
  await db.purchaseOrderLine.deleteMany({ where: { poId: po.id } });
  await db.purchaseOrderNote.deleteMany({ where: { poId: po.id } });
  await db.purchaseOrderEvent.deleteMany({ where: { poId: po.id } });
  await db.purchaseOrder.delete({ where: { id: po.id } });
  console.log(`[po] ${shop}: ${po.poNumber} deleted by ${user?.name ?? "staff"}`);
}

async function receivedStatus(poId) {
  const lines = await db.purchaseOrderLine.findMany({ where: { poId } });
  const got = lines.reduce((t, l) => t + l.received, 0);
  if (!got) return "open";
  return lines.every((l) => l.received >= l.quantity) ? "received" : "partial";
}

// ---------------------------------------------------------------------------
// Receiving: adds stock in Shopify at the PO's location
// ---------------------------------------------------------------------------

const ADJUST = `#graphql
  mutation PoReceive($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id }
      userErrors { field message code }
    }
  }`;

// counts: { [lineId]: units received now }
export async function receive(shop, admin, id, counts, user) {
  const po = await getPo(shop, id);
  if (!["open", "partial", "pending"].includes(po.status)) throw new PoError(`A ${STATUS_LABELS[po.status].toLowerCase()} PO can't be received into.`);
  const lines = await db.purchaseOrderLine.findMany({ where: { poId: po.id } });
  const byId = new Map(lines.map((l) => [l.id, l]));
  const todo = [];
  for (const [lineId, raw] of Object.entries(counts ?? {})) {
    const n = Math.round(Number(raw));
    if (!n) continue;
    const l = byId.get(Number(lineId));
    if (!l) throw new PoError("A line on this PO couldn't be found. Reload and try again.");
    if (n < 0) throw new PoError(`${l.title}: enter a positive number.`);
    if (l.received + n > l.quantity) throw new PoError(`${l.title}: only ${l.quantity - l.received} left to receive.`);
    todo.push({ l, n });
  }
  if (!todo.length) throw new PoError("Enter how many of each item arrived.");
  const toStock = RECEIVE_ADDS_STOCK ? todo.filter((x) => x.l.inventoryItemId) : [];
  if (toStock.length && !po.locationId) throw new PoError("Choose the location this PO is received at first.");
  if (toStock.length) {
    const data = await gql(admin, ADJUST, {
      key: randomUUID(),
      input: {
        name: "available",
        reason: "received",
        referenceDocumentUri: `${PO_URI_PREFIX}${po.id}`,
        changes: toStock.map(({ l, n }) => ({ delta: n, inventoryItemId: l.inventoryItemId, locationId: po.locationId, changeFromQuantity: null })),
      },
    });
    const errs = data?.inventoryAdjustQuantities?.userErrors ?? [];
    if (errs.length) throw new PoError(`Shopify didn't add the stock: ${errs.map((e) => e.message).join("; ")}`);
  }
  for (const { l, n } of todo) await db.purchaseOrderLine.update({ where: { id: l.id }, data: { received: { increment: n } } });
  const status = await receivedStatus(po.id);
  const now = new Date();
  await db.purchaseOrder.update({
    where: { id: po.id },
    data: { status, ...(po.status === "pending" ? { openedAt: now } : {}), ...(status === "received" ? { receivedAt: now } : {}) },
  });
  const units = todo.reduce((t, x) => t + x.n, 0);
  const off = RECEIVE_ADDS_STOCK ? todo.filter((x) => !x.l.inventoryItemId).reduce((t, x) => t + x.n, 0) : 0;
  await logPo(
    shop,
    po.id,
    "received",
    `${units} unit${units === 1 ? "" : "s"} at ${po.locationName ?? "the location"}${
      !RECEIVE_ADDS_STOCK ? " (recorded only: stock in Shopify not changed)" : off ? ` (${off} not in Shopify, so not added to stock)` : ""
    }`,
    user,
  );
  if (status !== po.status) await logPo(shop, po.id, "status", `${STATUS_LABELS[po.status]} → ${STATUS_LABELS[status]}`, user);
  return { status, units, notStocked: off, stockChanged: RECEIVE_ADDS_STOCK };
}

// A scan while receiving: which line is it? (SKU, supplier barcode or code)
export function lineForScan(lines, code) {
  const c = String(code ?? "").trim().toLowerCase();
  if (!c) return null;
  const open = lines.filter((l) => l.received < l.quantity);
  const hit = (l) => [l.sku, l.supplierBarcode, l.supplierCode].some((v) => v && String(v).trim().toLowerCase() === c);
  return open.find(hit) ?? lines.find(hit) ?? null;
}

// ---------------------------------------------------------------------------
// Notes (private) and reading
// ---------------------------------------------------------------------------

export async function addNote(shop, id, body, user) {
  const po = await getPo(shop, id);
  const text = String(body ?? "").trim();
  if (!text) throw new PoError("Write a note first.");
  return db.purchaseOrderNote.create({ data: { shop, poId: po.id, body: text.slice(0, 5000), by: user?.name ?? null } });
}

export async function deleteNote(shop, noteId, user) {
  const n = await db.purchaseOrderNote.findFirst({ where: { shop, id: Number(noteId) } });
  if (!n) throw new PoError("That note couldn't be found.");
  if (n.by && user?.name && n.by !== user.name && !user.isAdmin && !user.isOwner) throw new PoError("Only the person who wrote a note (or an admin) can delete it.");
  await db.purchaseOrderNote.delete({ where: { id: n.id } });
}

const iso = (d) => (d ? d.toISOString() : null);
export function viewPo(po, lines = null) {
  return {
    id: po.id,
    poNumber: po.poNumber,
    status: po.status,
    supplierId: po.supplierId,
    supplierName: po.supplierName,
    supplierEmails: po.supplierEmails,
    supplierAddress: po.supplierAddress,
    currency: po.currency,
    locationId: po.locationId,
    locationName: po.locationName,
    expectedAt: iso(po.expectedAt),
    supplierNote: po.supplierNote,
    subtotal: po.subtotal,
    taxTotal: po.taxTotal,
    total: po.total,
    sourceFile: po.sourceFile,
    externalRef: po.externalRef ?? null,
    createdBy: po.createdBy,
    createdAt: iso(po.createdAt),
    openedAt: iso(po.openedAt),
    sentAt: iso(po.sentAt),
    sentTo: po.sentTo,
    exportedAt: iso(po.exportedAt),
    receivedAt: iso(po.receivedAt),
    closedAt: iso(po.closedAt),
    ...(lines
      ? {
          lines: lines.map((l) => ({
            id: l.id,
            position: l.position,
            sku: l.sku,
            supplierCode: l.supplierCode,
            supplierBarcode: l.supplierBarcode,
            title: l.title,
            quantity: l.quantity,
            unitCost: l.unitCost,
            taxRate: l.taxRate,
            tax: l.tax,
            total: l.total,
            received: l.received,
            checkedIn: l.checkedIn ?? 0,
            variantId: l.variantId,
            matched: Boolean(l.inventoryItemId),
            shopifyTitle: l.shopifyTitle,
            imageUrl: l.imageUrl,
          })),
        }
      : {}),
  };
}

export async function poDetail(shop, id) {
  const po = await getPo(shop, id);
  const [lines, notes, events] = await Promise.all([
    db.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { position: "asc" } }),
    db.purchaseOrderNote.findMany({ where: { poId: po.id }, orderBy: { createdAt: "desc" } }),
    db.purchaseOrderEvent.findMany({ where: { poId: po.id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return {
    po: viewPo(po, lines),
    notes: notes.map((n) => ({ id: n.id, body: n.body, by: n.by, at: n.createdAt.toISOString() })),
    events: events.map((e) => ({ id: e.id, type: e.type, detail: e.detail, by: e.by, at: e.createdAt.toISOString() })),
  };
}

export async function listPos(shop, { status = "", q = "", take = 200 } = {}) {
  const text = String(q ?? "").trim();
  const rows = await db.purchaseOrder.findMany({
    where: {
      shop,
      ...(status === "active" ? { status: { in: ["pending", "open", "partial"] } } : STATUSES.includes(status) ? { status } : {}),
      ...(text ? { OR: [{ poNumber: { contains: text, mode: "insensitive" } }, { supplierName: { contains: text, mode: "insensitive" } }] } : {}),
    },
    orderBy: { number: "desc" },
    take,
  });
  const ids = rows.map((r) => r.id);
  const lines = ids.length ? await db.purchaseOrderLine.groupBy({ by: ["poId"], where: { poId: { in: ids } }, _sum: { quantity: true, received: true }, _count: { _all: true } }) : [];
  const by = new Map(lines.map((l) => [l.poId, l]));
  const counts = await db.purchaseOrder.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } });
  return {
    pos: rows.map((p) => ({ ...viewPo(p), lineCount: by.get(p.id)?._count._all ?? 0, units: by.get(p.id)?._sum.quantity ?? 0, received: by.get(p.id)?._sum.received ?? 0 })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
  };
}
