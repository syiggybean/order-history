import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { KEY, NAMESPACE, errorMessage, gql, toDay, todayInStore } from "./preorders.server";
import { WindowError, addProduct, saveWindow, toStoreInput } from "./preorder-windows.server";
import { getSettings } from "./preorder-notify.server";

// ---------------------------------------------------------------------------
// Automatic countdowns
//
// Once someone has looked at the preview and approved it, every active product
// whose release (publication) date is still to come gets a countdown:
//   - pre-orders open straight away (no "pre-orders are open" email, since
//     these are already on pre-order),
//   - they close at the end of the release date, and follow it if it moves,
//   - after that the countdown comes off the page and the normal Add to cart
//     shows (changeable per product),
//   - "Continue selling when out of stock" is never touched.
// Products from excluded vendors (publishers) or suppliers are left alone, and
// so is anything unticked in a preview or taken out of the countdowns.
// After approval it runs every hour for new products.
// ---------------------------------------------------------------------------

export const AUTO_USER = { name: "Automatic countdowns" };
const RUN_MS = 60 * 60 * 1000;

const list = (s) => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const norm = (s) => String(s ?? "").trim().toLowerCase();

export function autoSettings(settings) {
  return {
    on: Boolean(settings.autoCountdowns),
    approvedAt: settings.autoApprovedAt?.toISOString?.() ?? null,
    approvedBy: settings.autoApprovedBy ?? null,
    vendors: list(settings.autoExcludeVendors).map(String),
    suppliers: list(settings.autoExcludeSuppliers).map(Number).filter(Boolean),
    lastRunAt: settings.autoLastRunAt?.toISOString?.() ?? null,
    lastSummary: settings.autoLastSummary ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reading the catalog
// ---------------------------------------------------------------------------

const PRODUCTS_QUERY = `#graphql
  query ($after: String) {
    products(first: 200, after: $after, query: "status:active") {
      nodes {
        id
        title
        vendor
        featuredMedia { preview { image { url(transform: { maxWidth: 80 }) } } }
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

// Active products with a release date after today
async function upcomingProducts(admin, today = todayInStore()) {
  const out = [];
  let after = null;
  for (let page = 0; page < 500; page++) {
    const data = await gql(admin, PRODUCTS_QUERY, { after });
    const conn = data?.products;
    for (const p of conn?.nodes ?? []) {
      const release = toDay(p.metafield?.value);
      if (!release || release <= today) continue;
      out.push({
        productId: p.id,
        title: p.title,
        vendor: p.vendor || "",
        imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
        release,
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

// Supplier id → product ids, from purchase order lines
async function supplierProducts(shop) {
  const pos = await db.purchaseOrder.findMany({
    where: { shop, supplierId: { not: null } },
    select: { id: true, supplierId: true },
  });
  if (!pos.length) return new Map();
  const supplierOf = new Map(pos.map((p) => [p.id, p.supplierId]));
  const lines = await db.purchaseOrderLine.findMany({
    where: { poId: { in: pos.map((p) => p.id) }, variantId: { not: null } },
    select: { poId: true, variantId: true },
  });
  const variantIds = [...new Set(lines.map((l) => l.variantId))];
  const productOf = new Map();
  for (let i = 0; i < variantIds.length; i += 1000) {
    const chunk = variantIds.slice(i, i + 1000);
    const [cat, info] = await Promise.all([
      db.catalogVariant.findMany({ where: { shop, variantId: { in: chunk } }, select: { variantId: true, productId: true } }),
      db.inventoryItemInfo.findMany({ where: { shop, variantId: { in: chunk } }, select: { variantId: true, productId: true } }),
    ]);
    for (const r of [...info, ...cat]) if (r.productId) productOf.set(r.variantId, r.productId);
  }
  const out = new Map(); // supplierId → Set(productId)
  for (const l of lines) {
    const productId = productOf.get(l.variantId);
    const supplierId = supplierOf.get(l.poId);
    if (!productId || !supplierId) continue;
    if (!out.has(supplierId)) out.set(supplierId, new Set());
    out.get(supplierId).add(productId);
  }
  return out;
}

export async function listSuppliers(shop) {
  const rows = await db.supplier.findMany({ where: { shop, archived: false }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return rows;
}

// ---------------------------------------------------------------------------
// The preview: what automatic countdowns would add now
// ---------------------------------------------------------------------------

// Every upcoming product, each marked with why it would be left out (if it would)
export async function buildPreview(shop, admin, { vendors = null, suppliers = null } = {}) {
  const settings = await getSettings(shop);
  const auto = autoSettings(settings);
  const excludedVendors = new Set((vendors ?? auto.vendors).map(norm));
  const excludedSuppliers = (suppliers ?? auto.suppliers).map(Number);
  const [products, existing, skips, bySupplier, supplierRows] = await Promise.all([
    upcomingProducts(admin),
    db.preorderWindow.findMany({ where: { shop }, select: { productId: true } }),
    db.preorderAutoSkip.findMany({ where: { shop } }),
    supplierProducts(shop),
    db.supplier.findMany({ where: { shop }, select: { id: true, name: true } }),
  ]);
  const inGroup = new Set(existing.map((w) => w.productId));
  const skipped = new Map(skips.map((s) => [s.productId, s]));
  const supplierName = new Map(supplierRows.map((s) => [s.id, s.name]));
  const suppliersOf = new Map(); // productId → [supplier names]
  for (const [sid, ids] of bySupplier) {
    for (const pid of ids) {
      if (!suppliersOf.has(pid)) suppliersOf.set(pid, []);
      suppliersOf.get(pid).push({ id: sid, name: supplierName.get(sid) ?? `Supplier ${sid}` });
    }
  }

  const rows = products.map((p) => {
    const sup = suppliersOf.get(p.productId) ?? [];
    let reason = null;
    if (inGroup.has(p.productId)) reason = "already";
    else if (excludedVendors.has(norm(p.vendor))) reason = "vendor";
    else if (sup.some((s) => excludedSuppliers.includes(s.id))) reason = "supplier";
    else if (skipped.has(p.productId)) reason = skipped.get(p.productId).reason === "removed" ? "removed" : "unticked";
    const skip = skipped.has(p.productId) ? (skipped.get(p.productId).reason === "removed" ? "removed" : "unticked") : null;
    return { ...p, suppliers: sup.map((s) => s.name), supplierIds: sup.map((s) => s.id), inGroup: inGroup.has(p.productId), skip, reason };
  });
  rows.sort((a, b) => a.release.localeCompare(b.release) || a.title.localeCompare(b.title));

  // Every vendor with upcoming products, for the exclusion list
  const vendorCounts = {};
  for (const r of rows) vendorCounts[r.vendor || ""] = (vendorCounts[r.vendor || ""] ?? 0) + 1;
  return {
    today: todayInStore(),
    rows,
    toAdd: rows.filter((r) => !r.reason).length,
    vendors: Object.entries(vendorCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function saveExclusions(shop, { vendors, suppliers }) {
  await getSettings(shop);
  const v = [...new Set((vendors ?? []).map((x) => String(x).trim()).filter(Boolean))].sort();
  const s = [...new Set((suppliers ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  return db.preorderSettings.update({
    where: { shop },
    data: { autoExcludeVendors: JSON.stringify(v), autoExcludeSuppliers: JSON.stringify(s) },
  });
}

export async function turnOff(shop) {
  await getSettings(shop);
  return db.preorderSettings.update({ where: { shop }, data: { autoCountdowns: false } });
}

// Lets a product be added automatically again
export async function allowAgain(shop, productIds) {
  return db.preorderAutoSkip.deleteMany({ where: { shop, productId: { in: productIds.map(String) } } });
}

export async function listSkips(shop) {
  const rows = await db.preorderAutoSkip.findMany({ where: { shop }, orderBy: { createdAt: "desc" } });
  return rows.map((r) => ({ productId: r.productId, title: r.title, reason: r.reason, by: r.by, createdAt: r.createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

const jobs = new Map(); // shop → { state, total, done, added, errors, startedAt, finishedAt }
export const autoJob = (shop) => jobs.get(shop) ?? null;

// One product: added, opened now, closes at the end of its release date
async function addOne(shop, admin, p, user) {
  const w = await addProduct(shop, admin, p.productId, user);
  const row = await db.preorderWindow.findUnique({ where: { id: w.id } });
  if (row.opensAt || row.closesAt) return false; // set up by someone already
  await db.preorderWindow.update({ where: { id: w.id }, data: { auto: true, keepSelling: true, quietOpen: true, releaseDay: p.release } });
  await saveWindow(shop, admin, w.id, { opens: toStoreInput(new Date()), closes: "", limits: null, closesRule: "release" }, user);
  return true;
}

// Adds every product the preview would add. Runs in the background; `admin`
// is the request's when started from the page.
async function addAll(shop, admin, rows, user, job) {
  job.total = rows.length;
  for (const p of rows) {
    try {
      if (await addOne(shop, admin, p, user)) job.added.push(p.title);
    } catch (e) {
      job.errors.push(`${p.title}: ${e instanceof WindowError ? e.message : errorMessage(e)}`);
      // Leave it set up but closed-off for a person to look at: the row stays,
      // so the next run won't keep retrying it
    }
    job.done++;
  }
}

const summaryOf = (job) =>
  `${job.added.length} added${job.errors.length ? `, ${job.errors.length} couldn't be` : ""}`;

// Approval from the preview: unticked products are remembered as left out,
// exclusions are saved, everything else is added, and automatic countdowns
// stay on for new products from now on.
export async function approve(shop, admin, { vendors, suppliers, untick = [] }, user) {
  if (autoJob(shop)?.state === "running") throw new WindowError("Countdowns are already being added. Wait for that to finish.");
  await saveExclusions(shop, { vendors, suppliers });
  const name = user?.name ?? null;
  for (const productId of untick) {
    await db.preorderAutoSkip.upsert({
      where: { shop_productId: { shop, productId: String(productId) } },
      create: { shop, productId: String(productId), reason: "unticked", by: name },
      update: { reason: "unticked", by: name },
    });
  }
  const preview = await buildPreview(shop, admin);
  // Titles for the left-out list
  for (const r of preview.rows) {
    if (r.reason === "unticked") await db.preorderAutoSkip.update({ where: { shop_productId: { shop, productId: r.productId } }, data: { title: r.title } }).catch(() => null);
  }
  await db.preorderSettings.update({
    where: { shop },
    data: { autoCountdowns: true, autoApprovedAt: new Date(), autoApprovedBy: name },
  });
  return runAdd(shop, admin, preview.rows.filter((r) => !r.reason), user ?? AUTO_USER);
}

function runAdd(shop, admin, rows, user) {
  const job = { state: "running", total: rows.length, done: 0, added: [], errors: [], startedAt: new Date().toISOString(), finishedAt: null };
  jobs.set(shop, job);
  addAll(shop, admin, rows, user, job)
    .catch((e) => job.errors.push(errorMessage(e)))
    .finally(async () => {
      job.state = "done";
      job.finishedAt = new Date().toISOString();
      await db.preorderSettings
        .update({ where: { shop }, data: { autoLastRunAt: new Date(), autoLastSummary: summaryOf(job) } })
        .catch(() => null);
      if (job.added.length || job.errors.length) {
        await db.preorderLog
          .create({
            data: {
              shop,
              productId: "",
              title: "Automatic countdowns",
              action: "countdowns",
              detail: `${summaryOf(job)}${job.errors.length ? `: ${job.errors.slice(0, 5).join("; ")}` : ""}`.slice(0, 1000),
            },
          })
          .catch(() => null);
      }
    });
  return job;
}

// Hourly: new products with an upcoming release date
export async function runAuto(shop, admin) {
  const settings = await getSettings(shop);
  if (!settings.autoCountdowns) return null;
  if (autoJob(shop)?.state === "running") return null;
  const preview = await buildPreview(shop, admin);
  const rows = preview.rows.filter((r) => !r.reason);
  if (!rows.length) {
    await db.preorderSettings.update({ where: { shop }, data: { autoLastRunAt: new Date(), autoLastSummary: "Nothing new to add" } });
    return null;
  }
  const job = runAdd(shop, admin, rows, AUTO_USER);
  return job;
}

const lastRun = new Map();
export async function autoTick(now = Date.now()) {
  const shops = await db.preorderSettings.findMany({ where: { autoCountdowns: true }, select: { shop: true } });
  for (const { shop } of shops) {
    if (now - (lastRun.get(shop) ?? 0) < RUN_MS) continue;
    lastRun.set(shop, now);
    try {
      const { admin } = await unauthenticated.admin(shop);
      await runAuto(shop, admin);
    } catch (e) {
      console.error(`[preorder-auto] ${shop}:`, errorMessage(e));
    }
  }
}

if (!globalThis.__preorderAutoTimer && process.env.NODE_ENV !== "test") {
  const tick = () => autoTick().catch((e) => console.error("[preorder-auto] tick:", errorMessage(e)));
  globalThis.__preorderAutoTimer = setInterval(tick, 5 * 60 * 1000);
  setTimeout(tick, 90 * 1000);
}
