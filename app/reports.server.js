import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { runBulkQuery } from "./bulk.server";
import { KEY, NAMESPACE, daysUntil, errorMessage, toDay, todayInStore } from "./preorders.server";

// ---------------------------------------------------------------------------
// Reporting → Reports: lists for the team to work through. Each report is built
// in the background and saved (in the AnalyticsReport table, keyed "report:<id>")
// so it opens instantly; "Run again" rebuilds it.
// ---------------------------------------------------------------------------

export const REPORTS = {
  "archived-future": {
    title: "Archived with a future release date",
    description:
      "Archived products whose release date hasn't arrived yet. Usually one or the other is wrong: unarchive the product, or correct its release date.",
  },
};

const keyOf = (id) => `report:${id}`;
const running = new Map(); // `${shop}|${id}` -> promise

export async function getSavedReport(shop, id) {
  const r = await db.analyticsReport.findUnique({ where: { shop_periodKey: { shop, periodKey: keyOf(id) } } });
  if (!r) return null;
  return {
    id,
    status: r.status,
    step: r.step,
    error: r.error,
    builtAt: r.builtAt?.toISOString() ?? null,
    today: r.toDay,
    rows: r.data ? JSON.parse(r.data) : [],
  };
}

export async function startSavedReport(shop, id, { admin = null } = {}) {
  if (!REPORTS[id]) throw new Error("That report doesn't exist.");
  const run = `${shop}|${id}`;
  if (running.has(run)) return;
  const today = todayInStore();
  const where = { shop_periodKey: { shop, periodKey: keyOf(id) } };
  await db.analyticsReport.upsert({
    where,
    create: { shop, periodKey: keyOf(id), fromDay: today, toDay: today, status: "running", step: "Starting", startedAt: new Date() },
    update: { fromDay: today, toDay: today, status: "running", step: "Starting", error: null, startedAt: new Date() },
  });
  const p = (async () => {
    const step = (text) => db.analyticsReport.update({ where, data: { step: text } }).catch(() => {});
    try {
      const client = admin ?? (await unauthenticated.admin(shop)).admin;
      const rows = await BUILDERS[id](client, today, step);
      await db.analyticsReport.update({ where, data: { status: "done", step: "Finished", data: JSON.stringify(rows), builtAt: new Date(), error: null } });
    } catch (e) {
      console.error(`[reports] ${shop} ${id}:`, errorMessage(e));
      await db.analyticsReport.update({ where, data: { status: "failed", step: "Stopped", error: errorMessage(e).slice(0, 500) } }).catch(() => {});
    } finally {
      running.delete(run);
    }
  })();
  running.set(run, p);
  if (process.env.NODE_ENV === "test") await p;
}

// ---------------------------------------------------------------------------
// Archived products with a release date still to come
// ---------------------------------------------------------------------------

export const ARCHIVED_QUERY = `{
  products(query: "status:archived") {
    edges {
      node {
        id
        legacyResourceId
        title
        vendor
        updatedAt
        category { name }
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
        variants {
          edges {
            node { id sku }
          }
        }
      }
    }
  }
}`;

export async function archivedFutureRows(admin, today, step) {
  await step?.("Reading archived products from Shopify");
  const lines = await runBulkQuery(admin, ARCHIVED_QUERY, { label: "Archived products", onProgress: (t) => step?.(t) });
  const products = new Map();
  for (const l of lines) {
    if (l.__parentId) continue;
    const release = toDay(l.metafield?.value);
    if (!release || release <= today) continue;
    products.set(l.id, {
      id: l.id,
      legacyId: String(l.legacyResourceId ?? l.id.split("/").pop()),
      title: l.title,
      vendor: l.vendor || null,
      category: l.category?.name || null,
      release,
      days: daysUntil(today, release),
      updatedAt: l.updatedAt ?? null,
      skus: [],
    });
  }
  for (const l of lines) {
    if (l.__parentId && l.sku && products.has(l.__parentId)) products.get(l.__parentId).skus.push(l.sku);
  }
  return [...products.values()].sort((a, b) => a.release.localeCompare(b.release) || a.title.localeCompare(b.title));
}

const BUILDERS = { "archived-future": archivedFutureRows };
