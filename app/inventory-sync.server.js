import db from "./db.server";
import { unauthenticated } from "./shopify.server";

// ---------------------------------------------------------------------------
// Inventory history sync
//
// Shopify's inventory history (ShopifyQL) allows roughly one query per minute,
// so a single worker per shop runs one query at a time and waits for the
// budget to refill between queries. Work is picked in this order:
//
//   1. Live:      new changes since the last read. Triggered by Shopify's
//                 inventory notifications, never on a timer.
//   2. Re-check:  once a day, yesterday is read again in full, to catch
//                 anything a notification missed or that arrived late.
//   3. Backfill:  all older history, newest month first. Resumes after restarts.
//
// Every adjustment is stored once (by Shopify's adjustment ID), so overlapping
// reads are harmless.
// ---------------------------------------------------------------------------

const DATASET = "inventory_adjustment_history";
const TIME_ZONE = "America/Los_Angeles";
const DEFAULT_PAGE = 5000;
const MIN_PAGE = 250;
const LIVE_OVERLAP = 200; // re-read a few rows in case Shopify adds them late
const PENDING_RETRY_MS = 2 * 60 * 1000; // re-check for unmatched live entries this often
export const PENDING_WINDOW_MS = 30 * 60 * 1000; // give up matching after this long

// Undos made in the app carry this reference so they can be recognised
export const UNDO_URI_PREFIX = "gid://order-history/InventoryUndo/";
const ERROR_RETRY_MS = 5 * 60 * 1000;
const RECHECK_AFTER_HOUR = 3; // re-check yesterday after 3 AM store time

// Set INVENTORY_SYNC_PAUSED=true in Railway to stop all history reads.
const ENV_PAUSED = /^(1|true|yes)$/i.test(process.env.INVENTORY_SYNC_PAUSED ?? "");
// Optional: the database's storage size in MB (e.g. 5000). The sync pauses
// itself when the database reaches 85% of it.
const DB_MAX_MB = Number(process.env.INVENTORY_DB_MAX_MB) || null;
const DB_PAUSE_AT = 0.85;

export const isDiskFull = (e) =>
  /no space left|disk full|could not extend|53100|could not write to file/i.test(String(e?.message ?? e));

const pausedInMemory = new Map(); // shop -> reason (if the database can't even record the pause)

export async function databaseSizeMb() {
  try {
    const [r] = await db.$queryRaw`SELECT pg_database_size(current_database())::bigint AS size`;
    return Math.round(Number(r.size) / 1024 / 1024);
  } catch {
    return null;
  }
}

const FIELDS = [
  "second",
  "inventory_adjustment_id",
  "inventory_adjustment_group_id",
  "inventory_item_id",
  "product_variant_id",
  "product_variant_sku",
  "inventory_state",
  "inventory_change_reason",
  "inventory_app_name",
  "staff_member_name",
  "reference_document_type",
  "reference_document_id",
  "reference_document_uri",
  "inventory_location_id",
  "inventory_location_name",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Dates (store time)
// ---------------------------------------------------------------------------

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" });
export const today = () => dayFmt.format(new Date());
const hourNow = () => Number(hourFmt.format(new Date()));

export function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${month}-${String(last).padStart(2, "0")}`;
  const t = today();
  return { from: `${month}-01`, to: end > t ? t : end };
}

// ---------------------------------------------------------------------------
// ShopifyQL
// ---------------------------------------------------------------------------

const SHOPIFYQL = `#graphql
  query ($q: String!) {
    shopifyqlQuery(query: $q) {
      tableData { columns { name } rows }
      parseErrors
    }
  }`;

function readBudget(source) {
  const c = source?.extensions?.shopifyqlCost ?? source?.shopifyqlCost ?? null;
  return c ? { available: c.currentlyAvailable ?? null, resetAt: c.windowResetAt ?? null } : null;
}

// One attempt. Returns { rows } or { rateLimited | tooLarge | parseErrors | error }, plus budget.
export async function runShopifyql(admin, query) {
  try {
    const res = await admin.graphql(SHOPIFYQL, { variables: { q: query } });
    const json = await res.json();
    const r = json.data?.shopifyqlQuery;
    const budget = readBudget(json);
    if (r?.parseErrors?.length) return { parseErrors: r.parseErrors, budget };
    return { rows: r?.tableData?.rows ?? [], budget };
  } catch (e) {
    const text =
      e?.body?.errors?.graphQLErrors?.map((x) => x.message).join("; ") || e?.message || String(e);
    const budget = readBudget(e?.body) ?? readBudget(e?.body?.errors?.response) ?? null;
    if (/rate limit|throttl|429/i.test(text) || e?.response?.status === 429) return { rateLimited: true, budget, error: text };
    if (/too large|RESPONSE_TOO_LARGE/i.test(text)) return { tooLarge: true, budget, error: text };
    return { error: text, budget };
  }
}

const rangeQuery = (from, to, limit, offset) =>
  `FROM ${DATASET} SHOW inventory_adjustment_change GROUP BY ${FIELDS.join(", ")} SINCE ${from} UNTIL ${to} ORDER BY second ASC, inventory_adjustment_id ASC LIMIT ${limit} OFFSET ${offset}`;

const PLAN_QUERY = `FROM ${DATASET} SHOW inventory_adjustment_count GROUP BY month SINCE -10y ORDER BY month DESC`;

// ---------------------------------------------------------------------------
// Storing rows
// ---------------------------------------------------------------------------

const clean = (v) => (v === null || v === undefined || v === "" || v === "—" ? null : String(v));
const gid = (type, id) => {
  const v = clean(id);
  if (!v) return null;
  return v.startsWith("gid://") ? v : `gid://shopify/${type}/${v}`;
};

// Product and variant names for inventory items (cached in InventoryItemInfo)
async function ensureItemInfo(shop, admin, itemIds) {
  const unique = [...new Set(itemIds.filter(Boolean))];
  if (!unique.length) return new Map();

  const known = await db.inventoryItemInfo.findMany({ where: { shop, inventoryItemId: { in: unique } } });
  const map = new Map(known.map((k) => [k.inventoryItemId, k]));
  const missing = unique.filter((id) => !map.has(id));

  for (let i = 0; i < missing.length; i += 250) {
    const batch = missing.slice(i, i + 250);
    try {
      const res = await admin.graphql(
        `#graphql
        query ($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem { id sku variant { id title product { id title } } }
          }
        }`,
        { variables: { ids: batch } },
      );
      const nodes = (await res.json()).data?.nodes ?? [];
      const rows = nodes
        .filter((n) => n?.id)
        .map((n) => ({
          shop,
          inventoryItemId: n.id,
          variantId: n.variant?.id ?? null,
          variantTitle: n.variant?.title ?? null,
          productId: n.variant?.product?.id ?? null,
          productTitle: n.variant?.product?.title ?? null,
          sku: n.sku ?? null,
        }));
      if (rows.length) await db.inventoryItemInfo.createMany({ data: rows, skipDuplicates: true });
      for (const r of rows) map.set(r.inventoryItemId, r);
    } catch (e) {
      console.error("[inventory-sync] item lookup failed:", e?.message ?? e);
    }
  }
  return map;
}

async function storeRows(shop, admin, rows) {
  if (DB_MAX_MB) {
    const mb = await databaseSizeMb();
    if (mb !== null && mb >= DB_MAX_MB * DB_PAUSE_AT) {
      const err = new Error(`Database is at ${mb} MB of ${DB_MAX_MB} MB`);
      err.dbLimit = true;
      throw err;
    }
  }
  const useful = rows.filter((r) => clean(r.inventory_state) && r.inventory_state !== "system" && clean(r.inventory_adjustment_id));
  if (!useful.length) return 0;

  const info = await ensureItemInfo(shop, admin, useful.map((r) => gid("InventoryItem", r.inventory_item_id)));

  const data = useful.map((r) => {
    const itemId = gid("InventoryItem", r.inventory_item_id);
    const i = info.get(itemId);
    return {
      shop,
      adjustmentId: String(r.inventory_adjustment_id),
      groupId: clean(r.inventory_adjustment_group_id),
      occurredAt: new Date(r.second),
      inventoryItemId: itemId,
      productId: i?.productId ?? null,
      locationId: gid("Location", r.inventory_location_id),
      locationName: clean(r.inventory_location_name),
      state: String(r.inventory_state),
      change: Math.trunc(Number(r.inventory_adjustment_change ?? 0)),
      reason: clean(r.inventory_change_reason),
      appName: clean(r.inventory_app_name),
      staffName: clean(r.staff_member_name),
      referenceType: clean(r.reference_document_type),
      referenceId: clean(r.reference_document_id),
      // Order changes are identified by order ID; keep the longer reference only for other kinds
      referenceUri: clean(r.reference_document_type) === "Order" ? null : clean(r.reference_document_uri),
    };
  });

  const { count } = await db.inventoryAdjustment.createMany({ data, skipDuplicates: true });
  return count;
}

// An undo is shown straight away from a placeholder row. When Shopify's own
// record of it arrives, the placeholder is swapped for the real record.
export async function linkUndos(shop) {
  const open = await db.inventoryUndo.findMany({
    where: { shop, status: "applied", linkedAt: null, createdAt: { gte: new Date(Date.now() - 3 * 24 * 3600 * 1000) } },
  });
  for (const u of open) {
    const uri = `${UNDO_URI_PREFIX}${u.id}`;
    const placeholder = `undo-${u.id}`;
    const groupNumber = u.shopifyGroupId?.match(/(\d+)$/)?.[1];
    const notPlaceholder = { NOT: { groupId: { startsWith: "undo-" } } };
    const real =
      (groupNumber &&
        (await db.inventoryAdjustment.findFirst({
          where: { shop, groupId: groupNumber, inventoryItemId: u.inventoryItemId, locationId: u.locationId },
        }))) ||
      (await db.inventoryAdjustment.findFirst({ where: { shop, referenceUri: uri, ...notPlaceholder } })) ||
      (await db.inventoryAdjustment.findFirst({
        where: {
          shop,
          ...notPlaceholder,
          inventoryItemId: u.inventoryItemId,
          locationId: u.locationId,
          state: "available",
          change: u.delta,
          reason: "correction", // never an order or other change that happens to match
          referenceUri: null,
          occurredAt: {
            gte: new Date(u.createdAt.getTime() - 10 * 60 * 1000),
            lte: new Date(u.createdAt.getTime() + 10 * 60 * 1000),
          },
        },
      }));
    if (!real) continue;
    await db.$transaction([
      db.inventoryAdjustment.updateMany({
        where: { shop, groupId: real.groupId, inventoryItemId: u.inventoryItemId, locationId: u.locationId },
        data: { referenceUri: uri },
      }),
      db.inventoryAdjustment.deleteMany({ where: { shop, groupId: placeholder } }),
      db.inventoryUndo.update({ where: { id: u.id }, data: { linkedAt: new Date() } }),
    ]);
  }
}

// Live entries recorded from notifications are "pending" until the matching
// history row arrives; then they're hidden in favour of the full record.
async function matchPending(shop) {
  const now = Date.now();
  await db.inventoryEvent.updateMany({
    where: { shop, detailsStatus: "pending", occurredAt: { lt: new Date(now - PENDING_WINDOW_MS) } },
    data: { detailsStatus: "expired" },
  });

  const pending = await db.inventoryEvent.findMany({ where: { shop, detailsStatus: "pending" }, take: 500 });
  for (const ev of pending) {
    const match = await db.inventoryAdjustment.findFirst({
      where: {
        shop,
        inventoryItemId: ev.inventoryItemId,
        locationId: ev.locationId,
        state: "available",
        occurredAt: {
          gte: new Date(ev.occurredAt.getTime() - 5 * 60 * 1000),
          lte: new Date(ev.occurredAt.getTime() + 5 * 60 * 1000),
        },
      },
      orderBy: { occurredAt: "desc" },
    });
    if (match) {
      await db.inventoryEvent.update({
        where: { id: ev.id },
        data: { detailsStatus: "matched", adjustmentId: match.adjustmentId },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

async function getState(shop) {
  return (
    (await db.inventorySync.findUnique({ where: { shop } })) ??
    (await db.inventorySync.create({ data: { shop, pageSize: DEFAULT_PAGE } }))
  );
}

const setState = (shop, data) => db.inventorySync.update({ where: { shop }, data });

export async function getSyncStatus(shop) {
  const s = await getState(shop);
  const plan = s.backfillPlan ? JSON.parse(s.backfillPlan) : null;
  const pending = await db.inventoryEvent.count({ where: { shop, detailsStatus: "pending" } });
  const stored = await db.inventoryAdjustment.count({ where: { shop } });
  return {
    paused: ENV_PAUSED || s.paused || pausedInMemory.has(shop),
    pausedReason: ENV_PAUSED
      ? "Paused by the INVENTORY_SYNC_PAUSED setting in Railway."
      : s.pausedReason ?? pausedInMemory.get(shop) ?? null,
    dbSizeMb: await databaseSizeMb(),
    dbMaxMb: DB_MAX_MB,
    planned: Boolean(plan),
    expectedRows: s.expectedRows,
    backfillRows: s.backfillRows,
    backfillDone: s.backfillDone,
    backfillMonth: plan && !s.backfillDone ? plan[s.backfillIndex]?.month ?? null : null,
    monthsLeft: plan && !s.backfillDone ? Math.max(0, plan.length - s.backfillIndex) : 0,
    lastLiveSyncAt: s.lastLiveSyncAt?.toISOString() ?? null,
    lastQueryAt: s.lastQueryAt?.toISOString() ?? null,
    lastError: s.lastError,
    working: running.has(shop),
    pending,
    stored,
  };
}

// ---------------------------------------------------------------------------
// Jobs: each runs exactly one query and records what's next
// ---------------------------------------------------------------------------

function pickJob(s, pendingCount, now) {
  if (s.paused) return null;
  const lastLive = s.lastLiveSyncAt?.getTime() ?? 0;
  const requested = s.liveRequestedAt && s.liveRequestedAt.getTime() > lastLive;
  const catchingUp = s.liveDay && s.liveDay < today();
  const retryPending = pendingCount > 0 && now - lastLive > PENDING_RETRY_MS;
  if (requested || catchingUp || retryPending) return "live";
  if (s.recheckDay) return "recheck";
  if (!s.backfillPlan) return "plan";
  if (!s.backfillDone) return "backfill";
  return null;
}

// Handles a failed query; returns true if the worker should keep going
async function handleFailure(shop, s, res, label) {
  const reset = res.budget?.resetAt ? new Date(res.budget.resetAt).getTime() : null;
  if (res.rateLimited) {
    await setState(shop, { nextQueryAt: new Date(Math.max(reset ?? 0, Date.now() + 60_000)) });
    return true;
  }
  if (res.tooLarge && s.pageSize > MIN_PAGE) {
    await setState(shop, { pageSize: Math.max(MIN_PAGE, Math.floor(s.pageSize / 2)), nextQueryAt: new Date(Date.now() + 60_000) });
    return true;
  }
  const msg = res.parseErrors?.join("; ") ?? res.error ?? "Unknown error";
  console.error(`[inventory-sync] ${label} failed:`, msg);
  await setState(shop, { lastError: `${label}: ${msg}`, nextQueryAt: new Date(Date.now() + ERROR_RETRY_MS) });
  // A query Shopify can't parse won't fix itself; stop until something changes
  return !res.parseErrors;
}

const afterQuery = (res) => {
  const reset = res.budget?.resetAt ? new Date(res.budget.resetAt).getTime() : null;
  // If budget remains, go again right away; otherwise wait for the refill
  const wait = res.budget?.available > 0 ? 1000 : Math.max(1000, (reset ?? Date.now() + 60_000) - Date.now() + 500);
  return { lastQueryAt: new Date(), nextQueryAt: new Date(Date.now() + wait), lastError: null };
};

async function runJob(job, shop, admin, s) {
  if (job === "plan") {
    const res = await runShopifyql(admin, PLAN_QUERY);
    if (!res.rows) return handleFailure(shop, s, res, "Planning history load");
    const plan = res.rows
      .map((r) => ({ month: String(r.month).slice(0, 7), count: Number(r.inventory_adjustment_count ?? 0) }))
      .filter((m) => m.count > 0)
      .sort((a, b) => b.month.localeCompare(a.month));
    await setState(shop, {
      ...afterQuery(res),
      backfillPlan: JSON.stringify(plan),
      expectedRows: plan.reduce((n, m) => n + m.count, 0),
      backfillIndex: 0,
      backfillOffset: 0,
      backfillDone: plan.length === 0,
    });
    return true;
  }

  if (job === "backfill") {
    const plan = JSON.parse(s.backfillPlan);
    const month = plan[s.backfillIndex];
    if (!month) {
      await setState(shop, { backfillDone: true });
      return true;
    }
    const { from, to } = monthRange(month.month);
    const res = await runShopifyql(admin, rangeQuery(from, to, s.pageSize, s.backfillOffset));
    if (!res.rows) return handleFailure(shop, s, res, `Loading ${month.month}`);
    await storeRows(shop, admin, res.rows);
    const full = res.rows.length >= s.pageSize;
    const nextIndex = full ? s.backfillIndex : s.backfillIndex + 1;
    await setState(shop, {
      ...afterQuery(res),
      backfillRows: s.backfillRows + res.rows.length,
      backfillIndex: nextIndex,
      backfillOffset: full ? s.backfillOffset + res.rows.length : 0,
      backfillDone: nextIndex >= plan.length,
    });
    return true;
  }

  if (job === "recheck") {
    const day = s.recheckDay;
    const res = await runShopifyql(admin, rangeQuery(day, day, s.pageSize, s.recheckOffset));
    if (!res.rows) return handleFailure(shop, s, res, `Re-checking ${day}`);
    await storeRows(shop, admin, res.rows);
    const full = res.rows.length >= s.pageSize;
    await setState(shop, {
      ...afterQuery(res),
      recheckDay: full ? day : null,
      recheckOffset: full ? s.recheckOffset + res.rows.length : 0,
    });
    await linkUndos(shop).catch((e) => console.error("Linking undos failed:", e));
    await matchPending(shop);
    return true;
  }

  if (job === "live") {
    const t = today();
    const day = s.liveDay ?? t;
    const offset = Math.max(0, s.liveOffset - LIVE_OVERLAP);
    const res = await runShopifyql(admin, rangeQuery(day, day, s.pageSize, offset));
    if (!res.rows) return handleFailure(shop, s, res, "Reading new changes");
    await storeRows(shop, admin, res.rows);

    const full = res.rows.length >= s.pageSize;
    const readTo = Math.max(s.liveOffset, offset + res.rows.length);
    let next;
    if (full) next = { liveDay: day, liveOffset: readTo }; // more to read on this day
    else if (day < t) next = { liveDay: addDays(day, 1), liveOffset: 0 }; // day finished, move on
    else next = { liveDay: day, liveOffset: readTo, lastLiveSyncAt: new Date() }; // up to date

    await setState(shop, { ...afterQuery(res), ...next });
    await linkUndos(shop).catch((e) => console.error("Linking undos failed:", e));
    await matchPending(shop);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const running = new Set();

async function pause(shop, reason) {
  pausedInMemory.set(shop, reason);
  console.error(`[inventory-sync] paused: ${reason}`);
  await setState(shop, { paused: true, pausedReason: reason }).catch(() => {});
}

export async function setPaused(shop, paused) {
  await getState(shop);
  if (paused) {
    await setState(shop, { paused: true, pausedReason: "Paused by an admin." });
  } else {
    pausedInMemory.delete(shop);
    await setState(shop, { paused: false, pausedReason: null, lastError: null, nextQueryAt: null });
    kick(shop);
  }
}

export function kick(shop) {
  if (ENV_PAUSED || pausedInMemory.has(shop)) return;
  if (running.has(shop)) return;
  running.add(shop);
  (async () => {
    try {
      for (;;) {
        let s = await getState(shop);
        const pendingCount = await db.inventoryEvent.count({ where: { shop, detailsStatus: "pending" } });
        const job = pickJob(s, pendingCount, Date.now());
        if (!job) break;

        const wait = (s.nextQueryAt?.getTime() ?? 0) - Date.now();
        if (wait > 0) {
          await sleep(wait);
          s = await getState(shop); // pick up anything that changed while waiting
        }

        const { admin } = await unauthenticated.admin(shop);
        const keepGoing = await runJob(job, shop, admin, s);
        if (!keepGoing) break;
      }
    } catch (e) {
      if (e?.dbLimit) {
        await pause(shop, `${e.message}, so loading history was paused to keep the app working.`);
      } else if (isDiskFull(e)) {
        await pause(shop, "The database ran out of storage space, so loading history was paused to keep the app working.");
      } else {
        console.error("[inventory-sync] worker stopped:", e?.message ?? e);
        await setState(shop, { lastError: e?.message ?? String(e), nextQueryAt: new Date(Date.now() + ERROR_RETRY_MS) }).catch(() => {});
      }
    } finally {
      running.delete(shop);
    }
  })();
}

// Called whenever Shopify reports an inventory change. Bursts (e.g. a bulk
// sync touching thousands of items) are collapsed into one request.
const lastRequest = new Map();
export async function requestLiveSync(shop) {
  if (ENV_PAUSED || pausedInMemory.has(shop)) return;
  const now = Date.now();
  if (now - (lastRequest.get(shop) ?? 0) < 5000) return kick(shop);
  lastRequest.set(shop, now);
  await getState(shop);
  await setState(shop, { liveRequestedAt: new Date(now) });
  kick(shop);
}

// Every 5 minutes: queue yesterday's re-check once a day, and restart the
// worker if there's backfill left (e.g. after a deploy).
async function tick() {
  if (ENV_PAUSED) return;
  const sessions = await db.session.findMany({ where: { isOnline: false }, select: { shop: true } });
  for (const shop of new Set(sessions.map((s) => s.shop))) {
    const s = await getState(shop);
    const yesterday = addDays(today(), -1);
    if (hourNow() >= RECHECK_AFTER_HOUR && s.lastRecheckQueued !== yesterday) {
      await setState(shop, { recheckDay: yesterday, recheckOffset: 0, lastRecheckQueued: yesterday });
    }
    kick(shop);
  }
}

if (!globalThis.__inventorySyncTimer) {
  const run = () => tick().catch((e) => console.error("[inventory-sync] tick:", e?.message ?? e));
  globalThis.__inventorySyncTimer = setInterval(run, 5 * 60 * 1000);
  setTimeout(run, 30 * 1000);
}
