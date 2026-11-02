import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { runBulkQuery } from "./bulk.server";
import { runShopifyql } from "./inventory-sync.server";
import { errorMessage, todayInStore } from "./preorders.server";

// ---------------------------------------------------------------------------
// Reporting dashboard: one row per product for a period, saved as a snapshot
// so the page opens instantly. The page groups, sorts and makes suggestions
// from these rows (see analytics-logic.js).
//
//   sold, net sales, cost, profit  ← Shopify's sales report (ShopifyQL)
//   ending count                   ← on hand (all locations) now, minus stock
//                                    changes after the period ended
//   starting count                 ← ending count minus stock changes during the
//                                    period (the app's copy of Shopify's stock
//                                    history). Shopify's history doesn't record
//                                    "On hand" itself, so its change is added up
//                                    from the states it's made of (available,
//                                    committed, reserved, damaged, safety stock,
//                                    quality control). "Incoming" isn't on hand.
//   category, vendor, status       ← one bulk read of the catalog
//   supplier                       ← the most recent purchase order in the app
// ---------------------------------------------------------------------------

import { ROWS_VERSION } from "./analytics-logic";
export { ROWS_VERSION };

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
  `FROM sales SHOW net_items_sold, net_sales, cost_of_goods_sold, gross_profit, net_sales_with_cost_recorded GROUP BY product_id, product_title, product_vendor SINCE ${from} UNTIL ${to} ORDER BY net_items_sold DESC LIMIT ${SALES_PAGE} OFFSET ${offset}`;

// Each variant, with its on-hand count at every location (child rows)
// On hand = these states added together (Shopify's definition)
export const ON_HAND_STATES = ["available", "committed", "reserved", "damaged", "safety_stock", "quality_control"];

export const CATALOG = `{
  productVariants {
    edges {
      node {
        id
        sku
        inventoryItem {
          id
          tracked
          inventoryLevels {
            edges {
              node {
                id
                quantities(names: ["on_hand"]) { name quantity }
              }
            }
          }
        }
        product { id title handle vendor status createdAt category { name fullName } }
      }
    }
  }
}`;

export async function buildRows(shop, admin, period, step) {
  // 1. Catalog: every variant with its stock and product details
  await step?.("Reading your catalog from Shopify");
  const lines = await runBulkQuery(admin, CATALOG, { label: "Catalog read", onProgress: (t) => step?.(t) });
  const products = new Map();
  const productOfItem = new Map();
  const productOfVariant = new Map();
  const trackedVariant = new Map(); // variant id -> product row, for stock-tracked variants
  for (const v of lines) {
    if (v.__parentId) continue;
    const p = v.product;
    if (!p?.id) continue;
    if (!products.has(p.id)) {
      products.set(p.id, {
        id: p.id,
        title: p.title,
        handle: p.handle ?? null,
        category: p.category?.name || null,
        categoryPath: p.category?.fullName || null,
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
    if (v.inventoryItem?.tracked !== false) {
      row.tracked = true;
      trackedVariant.set(v.id, row);
    }
    if (v.inventoryItem?.id) productOfItem.set(v.inventoryItem.id, p.id);
    productOfVariant.set(v.id, p.id);
  }
  // On hand at each location (child rows of the variant)
  for (const l of lines) {
    if (!l.__parentId || !Array.isArray(l.quantities)) continue;
    const row = trackedVariant.get(l.__parentId);
    if (!row) continue;
    row.onHand += num(l.quantities.find((q) => q.name === "on_hand")?.quantity);
  }

  // 2. Sales, cost and profit for the period
  await step?.("Reading sales from Shopify's sales report");
  const sales = new Map();
  for (let offset = 0; ; offset += SALES_PAGE) {
    const rows = await shopifyqlPatiently(admin, salesQuery(period.from, period.to, offset), step);
    for (const r of rows) {
      const id = gid(PRODUCT, r.product_id);
      if (!id) continue;
      const s = sales.get(id) ?? { sold: 0, netSales: 0, cost: 0, profit: 0, costedSales: 0, title: null, vendor: null };
      s.sold += num(r.net_items_sold);
      s.netSales += num(r.net_sales);
      s.cost += num(r.cost_of_goods_sold);
      s.profit += num(r.gross_profit);
      s.costedSales += num(r.net_sales_with_cost_recorded);
      s.title ??= r.product_title ?? null;
      s.vendor ??= r.product_vendor || null;
      sales.set(id, s);
    }
    if (rows.length < SALES_PAGE) break;
    await step?.(`Reading sales: ${(offset + rows.length).toLocaleString()} products so far`);
  }

  // 3. Starting and ending counts: work back from on hand now through the
  // stored stock history, first to the end of the period, then to its start
  await step?.("Working out starting and ending counts");
  const start = storeDayStartUtc(period.from);
  const end = storeDayStartUtc(addDays(period.to, 1));
  const changeSums = async (where) => {
    const out = new Map();
    const rows = await db.inventoryAdjustment.groupBy({ by: ["inventoryItemId", "productId"], where: { shop, state: { in: ON_HAND_STATES }, ...where }, _sum: { change: true } });
    for (const m of rows) {
      const pid = productOfItem.get(m.inventoryItemId) ?? m.productId ?? null;
      if (pid) out.set(pid, (out.get(pid) ?? 0) + (m._sum.change ?? 0));
    }
    return out;
  };
  const after = await changeSums({ occurredAt: { gte: end } });
  const during = await changeSums({ occurredAt: { gte: start, lt: end } });
  const history = await historyCoverage(shop);

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

  // 5. One row per product with any sales or stock in the period
  const ids = new Set([...products.keys(), ...sales.keys(), ...during.keys()]);
  const rows = [];
  for (const id of ids) {
    const p = products.get(id);
    const s = sales.get(id);
    // Stock-tracked products only; deleted ones have no count to work back from
    const ending = p?.tracked ? p.onHand - (after.get(id) ?? 0) : null;
    const starting = ending === null ? null : ending - (during.get(id) ?? 0);
    if (!s && !(starting > 0) && !(ending > 0)) continue;
    let copy = null;
    if (!p) copy = await db.catalogProduct.findUnique({ where: { shop_productId: { shop, productId: id } } }).catch(() => null);
    rows.push({
      id,
      title: p?.title ?? s?.title ?? copy?.title ?? "Unknown product",
      category: p?.category ?? null,
      categoryPath: p?.categoryPath ?? null,
      vendor: p?.vendor ?? s?.vendor ?? copy?.vendor ?? null,
      supplier: supplier.get(id) ?? null,
      status: p ? p.status : "deleted",
      createdAt: p?.createdAt ?? null,
      variants: p?.variants ?? 0,
      sku: p?.skus?.length === 1 ? p.skus[0] : null,
      starting,
      sold: s?.sold ?? 0,
      ending,
      netSales: round2(s?.netSales ?? 0),
      cost: round2(s?.cost ?? 0),
      profit: round2(s?.profit ?? 0),
      costedSales: round2(s?.costedSales ?? 0),
    });
  }
  const totals = rows.reduce(
    (t, r) => {
      t.sold += r.sold;
      t.starting += Math.max(0, r.starting ?? 0);
      t.ending += Math.max(0, r.ending ?? 0);
      t.netSales += r.netSales;
      t.cost += r.cost;
      t.profit += r.profit;
      t.costedSales += r.costedSales;
      t.products++;
      return t;
    },
    {
      version: ROWS_VERSION,
      sold: 0,
      starting: 0,
      ending: 0,
      netSales: 0,
      cost: 0,
      profit: 0,
      costedSales: 0,
      products: 0,
      days: period.days,
      from: period.from,
      to: period.to,
      // Starting counts need stock history back to the period's start
      historyFrom: history.from,
      historyComplete: history.complete || (history.from !== null && history.from <= period.from),
    },
  );
  for (const k of ["netSales", "cost", "profit", "costedSales"]) totals[k] = round2(totals[k]);
  return { rows, totals };
}

// How far back the app's copy of the stock history goes
async function historyCoverage(shop) {
  const s = await db.inventorySync.findUnique({ where: { shop } }).catch(() => null);
  if (s?.backfillDone) return { complete: true, from: null };
  // Loading runs newest month first: every month before the one being loaded now is complete
  let plan = [];
  try {
    plan = s?.backfillPlan ? JSON.parse(s.backfillPlan) : [];
  } catch {
    plan = [];
  }
  const done = s && s.backfillIndex > 0 ? plan[s.backfillIndex - 1] : null;
  return { complete: false, from: done?.month ? `${done.month}-01` : null };
}

// Midnight in the store's time zone (Pacific) for a "YYYY-MM-DD" day
function storeDayStartUtc(day) {
  const guess = new Date(`${day}T08:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "longOffset" });
  const off = fmt.formatToParts(guess).find((p) => p.type === "timeZoneName")?.value?.match(/GMT([+-]\d{2}):?(\d{2})?/);
  const minutes = off ? Number(off[1]) * 60 + Math.sign(Number(off[1])) * Number(off[2] ?? 0) : -480;
  return new Date(Date.parse(`${day}T00:00:00Z`) - minutes * 60000);
}
