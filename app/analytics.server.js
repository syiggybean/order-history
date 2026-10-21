import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { runBulkQuery } from "./bulk.server";
import { runShopifyql } from "./inventory-sync.server";
import { errorMessage, todayInStore } from "./preorders.server";

// ---------------------------------------------------------------------------
// Sell-through analytics: one row per product for a period, saved as a
// snapshot so the page opens instantly. The page groups, sorts and makes
// suggestions from these rows (see analytics-logic.js).
//
//   sold, net sales, cost, profit  ← Shopify's sales report (ShopifyQL)
//   received                       ← the app's copy of Shopify's stock history:
//                                    stock received from suppliers ("Received",
//                                    transfers received, POs received in the app),
//                                    minus moves out to another of your locations
//   on hand, type, vendor, status  ← one bulk read of the catalog
//   supplier                       ← the most recent purchase order in the app
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRODUCT = "gid://shopify/Product/";
const gid = (prefix, v) => {
  if (v == null || v === "") return null;
  const s = String(v);
  return s.startsWith("gid://") ? s : `${prefix}${s}`;
};
const num = (v) => {
  const n = Number(typeof v === "object" && v !== null ? v.amount ?? v.value : v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

export const PERIODS = {
  "30d": { label: "Last 30 days", days: 30 },
  "90d": { label: "Last 90 days", days: 90 },
  "180d": { label: "Last 6 months", days: 182 },
  "365d": { label: "Last 12 months", days: 365 },
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1;

// "90d" or "2026-01-01..2026-03-31" → { key, from, to, days, label }
export function periodRange(key, today = todayInStore()) {
  const k = String(key ?? "90d");
  const custom = k.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (custom && DAY.test(custom[1]) && DAY.test(custom[2]) && custom[1] <= custom[2]) {
    return { key: k, from: custom[1], to: custom[2], days: daysBetween(custom[1], custom[2]), label: `${custom[1]} to ${custom[2]}` };
  }
  const p = PERIODS[k] ?? PERIODS["90d"];
  const realKey = PERIODS[k] ? k : "90d";
  return { key: realKey, from: addDays(today, -(p.days - 1)), to: today, days: p.days, label: p.label };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getReport(shop, key) {
  const r = await db.analyticsReport.findUnique({ where: { shop_periodKey: { shop, periodKey: key } } });
  if (!r) return null;
  return {
    periodKey: r.periodKey,
    from: r.fromDay,
    to: r.toDay,
    status: r.status,
    step: r.step,
    error: r.error,
    builtAt: r.builtAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    rows: r.status === "done" || r.data ? JSON.parse(r.data ?? "[]") : [],
    totals: r.totals ? JSON.parse(r.totals) : null,
  };
}

export async function listReports(shop) {
  const rows = await db.analyticsReport.findMany({ where: { shop }, select: { periodKey: true, builtAt: true, status: true }, orderBy: { builtAt: "desc" } });
  return rows.map((r) => ({ key: r.periodKey, builtAt: r.builtAt?.toISOString() ?? null, status: r.status }));
}

// ---------------------------------------------------------------------------
// Building (background)
// ---------------------------------------------------------------------------

const running = new Map(); // `${shop}|${key}` -> promise

export async function startReport(shop, key, { admin = null } = {}) {
  const period = periodRange(key);
  const id = `${shop}|${period.key}`;
  if (running.has(id)) return period;
  await db.analyticsReport.upsert({
    where: { shop_periodKey: { shop, periodKey: period.key } },
    create: { shop, periodKey: period.key, fromDay: period.from, toDay: period.to, status: "running", step: "Starting", startedAt: new Date() },
    update: { fromDay: period.from, toDay: period.to, status: "running", step: "Starting", error: null, startedAt: new Date() },
  });
  const p = (async () => {
    const step = (text) => db.analyticsReport.update({ where: { shop_periodKey: { shop, periodKey: period.key } }, data: { step: text } }).catch(() => {});
    try {
      const client = admin ?? (await unauthenticated.admin(shop)).admin;
      const { rows, totals } = await buildRows(shop, client, period, step);
      await db.analyticsReport.update({
        where: { shop_periodKey: { shop, periodKey: period.key } },
        data: { status: "done", step: "Finished", data: JSON.stringify(rows), totals: JSON.stringify(totals), builtAt: new Date(), error: null },
      });
    } catch (e) {
      console.error(`[analytics] ${shop} ${period.key}:`, errorMessage(e));
      await db.analyticsReport
        .update({ where: { shop_periodKey: { shop, periodKey: period.key } }, data: { status: "failed", step: "Stopped", error: errorMessage(e).slice(0, 500) } })
        .catch(() => {});
    } finally {
      running.delete(id);
    }
  })();
  running.set(id, p);
  if (process.env.NODE_ENV === "test") await p;
  return period;
}

// The sales report shares Shopify's reporting allowance with the stock
// history sync: wait for it to refill rather than fail
async function shopifyqlPatiently(admin, query, step) {
  for (let attempt = 0; ; attempt++) {
    const res = await runShopifyql(admin, query);
    if (res.rows) return res.rows;
    if (res.rateLimited && attempt < 6) {
      const reset = res.budget?.resetAt ? new Date(res.budget.resetAt).getTime() : Date.now() + 60_000;
      await step?.("Waiting for Shopify's report allowance");
      await sleep(process.env.NODE_ENV === "test" ? 5 : Math.max(5_000, reset - Date.now() + 1_000));
      continue;
    }
    throw new Error(res.parseErrors?.length ? `Shopify couldn't read the sales query: ${res.parseErrors.join("; ")}` : res.error ?? "Shopify's sales report failed");
  }
}

const SALES_PAGE = 5000;
const salesQuery = (from, to, offset) =>
  `FROM sales SHOW net_items_sold, net_sales, cost_of_goods_sold, gross_profit, net_sales_with_cost_recorded GROUP BY product_id, product_title, product_type, product_vendor SINCE ${from} UNTIL ${to} ORDER BY net_items_sold DESC LIMIT ${SALES_PAGE} OFFSET ${offset}`;

const CATALOG = `{
  productVariants {
    edges {
      node {
        id
        sku
        inventoryQuantity
        inventoryItem { id tracked }
        product { id title handle productType vendor status createdAt }
      }
    }
  }
}`;

export async function buildRows(shop, admin, period, step) {
  // 1. Catalog: every variant with its stock and product details
  await step?.("Reading your catalog from Shopify");
  const variants = await runBulkQuery(admin, CATALOG, { label: "Catalog read", onProgress: (t) => step?.(t) });
  const products = new Map();
  const productOfItem = new Map();
  const productOfVariant = new Map();
  for (const v of variants) {
    const p = v.product;
    if (!p?.id) continue;
    if (!products.has(p.id)) {
      products.set(p.id, {
        id: p.id,
        title: p.title,
        handle: p.handle ?? null,
        type: p.productType || null,
        vendor: p.vendor || null,
        status: String(p.status ?? "").toLowerCase() || null,
        createdAt: p.createdAt ?? null,
        onHand: 0,
        tracked: false,
        variants: 0,
        skus: [],
      });
    }
    const row = products.get(p.id);
    row.variants++;
    if (v.sku) row.skus.push(v.sku);
    if (v.inventoryItem?.tracked !== false && Number.isFinite(Number(v.inventoryQuantity))) {
      row.onHand += Number(v.inventoryQuantity);
      row.tracked = true;
    }
    if (v.inventoryItem?.id) productOfItem.set(v.inventoryItem.id, p.id);
    productOfVariant.set(v.id, p.id);
  }

  // 2. Sales, cost and profit for the period
  await step?.("Reading sales from Shopify's sales report");
  const sales = new Map();
  for (let offset = 0; ; offset += SALES_PAGE) {
    const rows = await shopifyqlPatiently(admin, salesQuery(period.from, period.to, offset), step);
    for (const r of rows) {
      const id = gid(PRODUCT, r.product_id);
      if (!id) continue;
      const s = sales.get(id) ?? { sold: 0, netSales: 0, cost: 0, profit: 0, costedSales: 0, title: null, type: null, vendor: null };
      s.sold += num(r.net_items_sold);
      s.netSales += num(r.net_sales);
      s.cost += num(r.cost_of_goods_sold);
      s.profit += num(r.gross_profit);
      s.costedSales += num(r.net_sales_with_cost_recorded);
      s.title ??= r.product_title ?? null;
      s.type ??= r.product_type || null;
      s.vendor ??= r.product_vendor || null;
      sales.set(id, s);
    }
    if (rows.length < SALES_PAGE) break;
    await step?.(`Reading sales: ${(offset + rows.length).toLocaleString()} products so far`);
  }

  // 3. Units received in the period, from the stored stock history
  await step?.("Adding up stock received");
  const start = storeDayStartUtc(period.from);
  const end = storeDayStartUtc(addDays(period.to, 1));
  const received = new Map();
  const moves = await db.inventoryAdjustment.groupBy({
    by: ["inventoryItemId", "productId", "reason"],
    where: {
      shop,
      state: "available",
      occurredAt: { gte: start, lt: end },
      reason: { in: ["received", "movement_received", "movement_created", "movement_updated"] },
    },
    _sum: { change: true },
  });
  // Receiving at one of your locations from another isn't new stock: the
  // matching move out (movement_created/updated) cancels it out
  for (const m of moves) {
    const pid = productOfItem.get(m.inventoryItemId) ?? m.productId ?? null;
    if (!pid) continue;
    const change = m._sum.change ?? 0;
    const counts = m.reason === "received" || m.reason === "movement_received" ? change : Math.min(0, change);
    received.set(pid, (received.get(pid) ?? 0) + counts);
  }

  // 4. Supplier: from the most recent purchase order with this product
  const pos = await db.purchaseOrder.findMany({ where: { shop, supplierName: { not: null } }, select: { id: true, supplierName: true, createdAt: true }, orderBy: { createdAt: "asc" } });
  const poById = new Map(pos.map((p) => [p.id, p]));
  const poLines = pos.length
    ? await db.purchaseOrderLine.findMany({ where: { poId: { in: pos.map((p) => p.id) } }, select: { poId: true, variantId: true, inventoryItemId: true } })
    : [];
  const supplier = new Map();
  for (const l of poLines.sort((a, b) => poById.get(a.poId).createdAt - poById.get(b.poId).createdAt)) {
    const pid = (l.variantId && productOfVariant.get(l.variantId)) || (l.inventoryItemId && productOfItem.get(l.inventoryItemId));
    if (pid) supplier.set(pid, poById.get(l.poId).supplierName);
  }

  // 5. One row per product with any activity or stock
  const ids = new Set([...products.keys(), ...sales.keys(), ...received.keys()]);
  const rows = [];
  for (const id of ids) {
    const p = products.get(id);
    const s = sales.get(id);
    const got = Math.max(0, received.get(id) ?? 0);
    if (!s && !got && !(p && p.onHand > 0)) continue;
    let copy = null;
    if (!p) copy = await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId: id } } }).catch(() => null);
    rows.push({
      id,
      title: p?.title ?? s?.title ?? copy?.title ?? "Unknown product",
      type: p?.type ?? s?.type ?? copy?.productType ?? null,
      vendor: p?.vendor ?? s?.vendor ?? copy?.vendor ?? null,
      supplier: supplier.get(id) ?? null,
      status: p ? p.status : "deleted",
      createdAt: p?.createdAt ?? null,
      variants: p?.variants ?? 0,
      sku: p?.skus?.length === 1 ? p.skus[0] : null,
      sold: s?.sold ?? 0,
      received: got,
      onHand: p?.tracked ? p.onHand : null,
      netSales: round2(s?.netSales ?? 0),
      cost: round2(s?.cost ?? 0),
      profit: round2(s?.profit ?? 0),
      costedSales: round2(s?.costedSales ?? 0),
    });
  }
  const totals = rows.reduce(
    (t, r) => {
      t.sold += r.sold;
      t.received += r.received;
      t.netSales += r.netSales;
      t.cost += r.cost;
      t.profit += r.profit;
      t.costedSales += r.costedSales;
      t.products++;
      return t;
    },
    { sold: 0, received: 0, netSales: 0, cost: 0, profit: 0, costedSales: 0, products: 0, days: period.days, from: period.from, to: period.to },
  );
  for (const k of ["netSales", "cost", "profit", "costedSales"]) totals[k] = round2(totals[k]);
  return { rows, totals };
}

// Midnight in the store's time zone (Pacific) for a "YYYY-MM-DD" day
function storeDayStartUtc(day) {
  const guess = new Date(`${day}T08:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
  const off = fmt.formatToParts(guess).find((p) => p.type === "timeZoneName")?.value?.match(/GMT([+-]\d{2}):?(\d{2})?/);
  const minutes = off ? Number(off[1]) * 60 + Math.sign(Number(off[1])) * Number(off[2] ?? 0) : -480;
  return new Date(Date.parse(`${day}T00:00:00Z`) - minutes * 60000);
}
