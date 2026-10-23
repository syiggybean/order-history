import db from "./db.server";
import { PoError, getPoSettings, listLocations, matchLines } from "./po.server";
import { errorMessage } from "./preorders.server";

// ---------------------------------------------------------------------------
// Importing existing purchase orders from Linnworks (Purchase orders → Import).
//
// Railway variables: LINNWORKS_APP_ID, LINNWORKS_APP_SECRET (from the Linnworks
// developer app) and LINNWORKS_TOKEN (the installation token you get when the app is
// installed on your Linnworks account). Importing never changes stock anywhere, and
// never changes anything in Linnworks: it only reads.
// ---------------------------------------------------------------------------

export class LinnworksError extends Error {}

const AUTH_URL = "https://api.linnworks.net/api/Auth/AuthorizeByApplication";
export const LW_STATUSES = { PENDING: "pending", OPEN: "open", PARTIAL: "partial", DELIVERED: "received" };
const PAGE = 50;
const testing = () => process.env.NODE_ENV === "test";
const sleep = (ms) => new Promise((r) => setTimeout(r, testing() ? 0 : ms));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

export const LINNWORKS_VARS = ["LINNWORKS_APP_ID", "LINNWORKS_APP_SECRET", "LINNWORKS_TOKEN"];
// Which of the three Railway variables aren't there (empty = all set)
export const linnworksMissing = () => LINNWORKS_VARS.filter((k) => !String(process.env[k] ?? "").trim());
export const linnworksConfigured = () => linnworksMissing().length === 0;

// Field names differ in case between Linnworks endpoints: read whichever is there
const pick = (o, ...names) => {
  if (!o) return undefined;
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  const lower = Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n.toLowerCase()] !== undefined && lower[n.toLowerCase()] !== null) return lower[n.toLowerCase()];
  return undefined;
};
const text = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());
// Linnworks dates; its "no date" is year 1
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? null : d;
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

let session = null; // { token, server, until }

async function authorize() {
  if (!linnworksConfigured()) throw new LinnworksError("Linnworks isn't set up: add LINNWORKS_APP_ID, LINNWORKS_APP_SECRET and LINNWORKS_TOKEN in Railway.");
  if (session && session.until > Date.now()) return session;
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ApplicationId: process.env.LINNWORKS_APP_ID, ApplicationSecret: process.env.LINNWORKS_APP_SECRET, Token: process.env.LINNWORKS_TOKEN }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.text();
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  const token = pick(data, "Token", "token");
  const server = pick(data, "Server", "server");
  if (!res.ok || !token || !server) {
    throw new LinnworksError(
      res.status === 401 || res.status === 400
        ? "Linnworks didn't accept the app id, secret and installation token. Check the three LINNWORKS_ variables in Railway."
        : `Linnworks sign-in failed (${res.status}): ${String(pick(data, "Message", "message") ?? body).slice(0, 200)}`,
    );
  }
  // Sessions last a while; sign in again every 30 minutes to be safe
  session = { token, server: String(server).replace(/\/+$/, ""), until: Date.now() + 30 * 60_000 };
  return session;
}
export const resetLinnworksSession = () => {
  session = null;
};

// Linnworks takes form fields; objects go in as JSON
async function call(path, params = {}, attempt = 0) {
  const s = await authorize();
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`${s.server}/api/${path}`, {
    method: "POST",
    headers: { Authorization: s.token, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status === 401 && attempt === 0) {
    session = null;
    return call(path, params, 1);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(2000 * (attempt + 1));
    return call(path, params, attempt + 1);
  }
  const body = await res.text();
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new LinnworksError(`Linnworks returned ${res.status} for ${path}: ${String(pick(data, "Message", "message") ?? body).slice(0, 300)}`);
  return data;
}

// Supplier and location names (Linnworks only gives their ids on a PO)
async function lookups() {
  const [suppliers, locations] = await Promise.all([call("Inventory/GetSuppliers").catch(() => []), call("Inventory/GetStockLocations").catch(() => [])]);
  const sup = new Map();
  for (const s of Array.isArray(suppliers) ? suppliers : []) {
    const id = text(pick(s, "pkSupplierID", "pkSupplierId", "SupplierId"));
    if (id) {
      sup.set(id.toLowerCase(), {
        name: text(pick(s, "SupplierName", "Name")),
        email: text(pick(s, "SupplierEmail", "Email", "ContactEmail")),
        contact: text(pick(s, "ContactName", "Contact")),
        phone: text(pick(s, "TelephoneNumber", "Phone", "Telephone")),
        address: [pick(s, "Address"), pick(s, "AlternativeAddress"), pick(s, "City"), pick(s, "Region"), pick(s, "PostCode"), pick(s, "Country")].map(text).filter(Boolean).join("\n") || null,
      });
    }
  }
  const loc = new Map();
  for (const l of Array.isArray(locations) ? locations : []) {
    const id = text(pick(l, "StockLocationId", "pkStockLocationId", "LocationId"));
    if (id) loc.set(id.toLowerCase(), text(pick(l, "LocationName", "Name")));
  }
  return { sup, loc };
}

const headerView = (h, names) => {
  const id = text(pick(h, "pkPurchaseID", "pkPurchaseId", "PurchaseId"));
  const supplier = names?.sup.get(String(pick(h, "fkSupplierId", "SupplierId") ?? "").toLowerCase());
  return {
    id,
    reference: text(pick(h, "ExternalInvoiceNumber", "Reference")),
    supplierRef: text(pick(h, "SupplierReferenceNumber", "SupplierReference")),
    supplier: supplier?.name ?? null,
    location: names?.loc.get(String(pick(h, "fkLocationId", "LocationId") ?? "").toLowerCase()) ?? null,
    status: String(pick(h, "Status") ?? "").toUpperCase(),
    purchasedAt: date(pick(h, "DateOfPurchase"))?.toISOString() ?? null,
    expectedAt: date(pick(h, "QuotedDeliveryDate"))?.toISOString() ?? null,
    deliveredAt: date(pick(h, "DateOfDelivery"))?.toISOString() ?? null,
    currency: text(pick(h, "Currency")) ?? "USD",
    lines: Number(pick(h, "LineCount")) || null,
    deliveredLines: Number(pick(h, "DeliveredLinesCount")) || 0,
    total: pick(h, "ConvertedGrandTotal", "TotalCost") != null ? Number(pick(h, "ConvertedGrandTotal", "TotalCost")) : null,
  };
};

// One page of Linnworks POs, with which are already here
export async function searchLinnworks(shop, { status = "", from = "", to = "", q = "", page = 1 } = {}) {
  const searchParameter = {
    ...(from ? { DateFrom: new Date(`${from}T00:00:00Z`).toISOString() } : {}),
    ...(to ? { DateTo: new Date(`${to}T23:59:59Z`).toISOString() } : {}),
    ...(LW_STATUSES[status] ? { Status: status } : {}),
    ...(q ? { SearchValue: String(q).trim(), SearchType: "All" } : {}),
    EntriesPerPage: PAGE,
    PageNumber: Math.max(1, Number(page) || 1),
  };
  const [data, names] = await Promise.all([call("PurchaseOrder/Search_PurchaseOrders2", { searchParameter }), lookups()]);
  const list = pick(data, "Result", "Data", "Items") ?? (Array.isArray(data) ? data : []);
  const rows = list.map((h) => headerView(h, names)).filter((r) => r.id);
  const done = await db.purchaseOrder.findMany({ where: { shop, linnworksId: { in: rows.map((r) => r.id.toLowerCase()) } }, select: { id: true, poNumber: true, linnworksId: true } });
  const here = new Map(done.map((d) => [d.linnworksId, d]));
  return {
    rows: rows.map((r) => ({ ...r, imported: here.get(r.id.toLowerCase()) ? { id: here.get(r.id.toLowerCase()).id, poNumber: here.get(r.id.toLowerCase()).poNumber } : null })),
    page: Number(pick(data, "CurrentPageNumber", "PageNumber")) || searchParameter.PageNumber,
    pages: Number(pick(data, "TotalPages")) || 1,
    total: Number(pick(data, "TotalNumberOfRecords", "TotalEntries", "TotalCount")) || rows.length,
  };
}

// ---------------------------------------------------------------------------
// Turning a Linnworks PO into one of ours
// ---------------------------------------------------------------------------

// Linnworks' item "Cost" may be the line total or the unit cost depending on the
// account's settings: whichever adds up to the PO total is the right one.
export function linesFrom(items, header) {
  const live = (items ?? []).filter((i) => !pick(i, "IsDeleted"));
  const raw = live.map((i) => {
    const qty = Math.round(Number(pick(i, "Quantity")) || 0);
    const cost = Number(pick(i, "Cost")) || 0;
    const unit = pick(i, "UnitCost");
    const tax = Number(pick(i, "Tax")) || 0;
    return {
      qty,
      cost,
      unit: unit != null ? Number(unit) : null,
      tax,
      taxRate: Number(pick(i, "TaxRate")) || 0,
      delivered: Math.max(0, Math.round(Number(pick(i, "Delivered")) || 0)),
      sku: text(pick(i, "SKU", "ItemNumber")),
      title: text(pick(i, "ItemTitle", "Title")) ?? text(pick(i, "SKU")) ?? "(no title)",
      barcode: text(pick(i, "BarcodeNumber", "Barcode")),
      supplierCode: text(pick(i, "SupplierCode")),
      supplierBarcode: text(pick(i, "SupplierBarcode")),
      sort: Number(pick(i, "SortOrder")) || 0,
    };
  });
  const goods = Number(pick(header, "TotalCost"));
  const sumLine = raw.reduce((t, r) => t + r.cost, 0);
  const sumUnit = raw.reduce((t, r) => t + r.cost * r.qty, 0);
  // TotalCost is the goods total in Linnworks; pick the reading closest to it
  const costIsUnit = Number.isFinite(goods) && goods > 0 ? Math.abs(sumUnit - goods) < Math.abs(sumLine - goods) : false;
  return raw
    .filter((r) => r.qty > 0)
    .sort((a, b) => a.sort - b.sort)
    .map((r) => {
      const unitCost = r.unit != null ? r.unit : costIsUnit ? r.cost : r.qty ? r.cost / r.qty : 0;
      const subtotal = round2(unitCost * r.qty);
      return {
        sku: r.sku,
        supplierCode: r.supplierCode,
        // Our scanning looks at the supplier barcode: use Linnworks' barcode when there's no supplier one
        supplierBarcode: r.supplierBarcode ?? r.barcode,
        title: r.title.slice(0, 500),
        quantity: r.qty,
        unitCost: round4(unitCost),
        taxRate: r.taxRate,
        tax: round2(r.tax),
        total: round2(subtotal + r.tax),
        received: Math.min(r.delivered, r.qty),
      };
    });
}

async function supplierFor(shop, info) {
  if (!info?.name) return null;
  const found = await db.supplier.findFirst({ where: { shop, name: { equals: info.name, mode: "insensitive" } } });
  if (found) return found;
  const email = info.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(info.email) ? info.email.toLowerCase() : null;
  const contacts = info.contact || email || info.phone ? [{ name: info.contact ?? "", role: "", email: email ?? "", phone: info.phone ?? "", getsPo: Boolean(email) }] : [];
  return db.supplier.create({
    data: { shop, name: info.name.slice(0, 120), emails: email, contacts: JSON.stringify(contacts), contact: info.contact, phone: info.phone, address: info.address, notes: "Added when importing from Linnworks" },
  });
}

async function importOne(shop, admin, lwId, ctx, user) {
  const id = String(lwId).toLowerCase();
  const exists = await db.purchaseOrder.findFirst({ where: { shop, linnworksId: id } });
  if (exists) return { skipped: true, poNumber: exists.poNumber, id: exists.id };
  const data = await call("PurchaseOrder/Get_PurchaseOrder", { pkPurchaseId: lwId });
  const header = pick(data, "PurchaseOrderHeader", "Header") ?? data;
  const items = pick(data, "PurchaseOrderItem", "PurchaseOrderItems", "Items") ?? [];
  const h = headerView(header, ctx.names);
  let lines = linesFrom(items, header);
  if (!lines.length) throw new LinnworksError(`${h.reference ?? lwId}: no items to import.`);
  try {
    lines = (await matchLines(admin, lines)).map((l, i) => ({ ...l, received: lines[i].received }));
  } catch (e) {
    console.error("[linnworks] matching:", errorMessage(e));
  }
  const supplierInfo = ctx.names.sup.get(String(pick(header, "fkSupplierId", "SupplierId") ?? "").toLowerCase());
  const supplier = await supplierFor(shop, supplierInfo);
  // Location: the Shopify location with the same name, else the PO default
  const loc = ctx.locations.find((l) => h.location && l.name.trim().toLowerCase() === h.location.trim().toLowerCase()) ?? ctx.locations.find((l) => l.id === ctx.settings.locationId) ?? ctx.locations[0] ?? null;
  const status = LW_STATUSES[h.status] ?? "open";
  const subtotal = round2(lines.reduce((t, l) => t + l.unitCost * l.quantity, 0));
  const taxTotal = round2(lines.reduce((t, l) => t + l.tax, 0));
  const st = await db.poSettings.update({ where: { shop }, data: { counter: { increment: 1 } } });
  const purchased = h.purchasedAt ? new Date(h.purchasedAt) : new Date();
  const po = await db.purchaseOrder.create({
    data: {
      shop,
      number: st.counter,
      // Keep Linnworks' reference as the PO number people know
      poNumber: (h.reference ?? `${st.prefix}${String(st.counter).padStart(4, "0")}`).slice(0, 60),
      linnworksId: id,
      externalRef: [h.reference && `Linnworks ${h.reference}`, h.supplierRef && `Supplier ref ${h.supplierRef}`].filter(Boolean).join(" · ") || "Linnworks",
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? supplierInfo?.name ?? null,
      supplierEmails: supplier?.emails ?? null,
      supplierAddress: supplier?.address ?? null,
      status,
      currency: h.currency,
      locationId: loc?.id ?? null,
      locationName: loc?.name ?? h.location ?? null,
      expectedAt: h.expectedAt ? new Date(`${h.expectedAt.slice(0, 10)}T00:00:00Z`) : null,
      subtotal,
      taxTotal,
      total: round2(subtotal + taxTotal),
      sourceFile: "Linnworks",
      createdBy: user?.name ?? null,
      createdAt: purchased,
      openedAt: status === "pending" ? null : purchased,
      receivedAt: status === "received" ? (h.deliveredAt ? new Date(h.deliveredAt) : purchased) : null,
    },
  });
  await db.purchaseOrderLine.createMany({
    data: lines.map((l, i) => ({
      poId: po.id,
      position: i + 1,
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
      variantId: l.variantId ?? null,
      inventoryItemId: l.inventoryItemId ?? null,
      shopifyTitle: l.shopifyTitle ?? null,
      imageUrl: l.imageUrl ?? null,
    })),
  });
  const delivered = lines.reduce((t, l) => t + l.received, 0);
  await db.purchaseOrderEvent.create({
    data: {
      shop,
      poId: po.id,
      type: "imported",
      detail: `From Linnworks${h.reference ? ` (${h.reference})` : ""}: ${lines.length} line${lines.length === 1 ? "" : "s"}, status ${h.status || "unknown"}${delivered ? `, ${delivered} units already delivered there` : ""}. Stock unchanged.`,
      by: user?.name ?? null,
    },
  });
  return { id: po.id, poNumber: po.poNumber, lines: lines.length };
}

// Imports run in the background (one Linnworks call per PO); the page follows along
const jobs = new Map();
export const linnworksJob = (shop) => jobs.get(shop) ?? null;

// ids: Linnworks PO ids, or all: the search filter (every page)
export async function startImport(shop, admin, { ids = null, all = null }, user) {
  if (jobs.get(shop)?.running) throw new LinnworksError("An import is already running.");
  if (!ids?.length && !all) throw new LinnworksError("Choose the purchase orders to import.");
  const job = { running: true, startedAt: new Date().toISOString(), by: user?.name ?? null, total: ids?.length ?? null, done: 0, imported: 0, skipped: 0, failed: [], made: [], step: "Starting", error: null };
  jobs.set(shop, job);
  const work = (async () => {
    const [locations, settings] = await Promise.all([listLocations(admin).catch(() => []), getPoSettings(shop)]);
    const names = await lookups();
    const ctx = { locations, settings, names };
    let todo = ids ?? [];
    if (all) {
      job.step = "Finding the purchase orders in Linnworks";
      todo = [];
      for (let page = 1; page <= 400; page++) {
        const r = await searchLinnworks(shop, { ...all, page });
        todo.push(...r.rows.filter((x) => !x.imported).map((x) => x.id));
        job.skipped += r.rows.filter((x) => x.imported).length;
        if (page >= r.pages || !r.rows.length) break;
      }
      job.total = todo.length + job.skipped;
      job.done = job.skipped;
    }
    job.step = "Importing";
    for (const lwId of todo) {
      try {
        const r = await importOne(shop, admin, lwId, ctx, user);
        if (r.skipped) job.skipped++;
        else {
          job.imported++;
          if (job.made.length < 200) job.made.push({ id: r.id, poNumber: r.poNumber });
        }
      } catch (e) {
        job.failed.push({ id: lwId, error: e instanceof LinnworksError || e instanceof PoError ? e.message : errorMessage(e) });
        if (!(e instanceof LinnworksError)) console.error("[linnworks] import:", e);
      }
      job.done++;
    }
    job.step = "Finished";
  })()
    .catch((e) => {
      job.error = e instanceof LinnworksError ? e.message : `The import stopped: ${errorMessage(e)}`;
      if (!(e instanceof LinnworksError)) console.error("[linnworks] import:", e);
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  if (testing()) await work;
  return { ...job };
}
