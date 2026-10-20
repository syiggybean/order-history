import db from "./db.server";
import { PENDING_WINDOW_MS, UNDO_URI_PREFIX } from "./inventory-sync.server";

// ---------------------------------------------------------------------------
// Reading the inventory log. Everything here comes from the app's own
// database, so it's instant and doesn't use Shopify's reporting budget.
//
// A "change" is one adjustment group for one item at one location, e.g.
// an order taking 1 unit: available -1, committed +1.
// ---------------------------------------------------------------------------

// Reason codes as Shopify stores them → the wording Shopify admin shows for
// them (e.g. "shrinkage" is "Theft or loss" in the admin's reason picker).
// Codes not listed here are shown as-is.
const REASONS = {
  correction: "Correction",
  cycle_count_available: "Count",
  received: "Received",
  restock: "Return restock",
  damaged: "Damaged",
  shrinkage: "Theft or loss",
  promotion: "Promotion or donation",
  quality_control: "Quality control",
  safety_stock: "Safety stock",
  other: "Other",
  manual_adjustment: "Manually adjusted",
  movement_created: "Transfer created",
  movement_updated: "Transfer updated",
  movement_received: "Transfer received",
  movement_canceled: "Transfer canceled",
  reservation_created: "Reservation created",
  reservation_deleted: "Reservation deleted",
  reservation_updated: "Reservation updated",
  purchase: "Order",
  order_edit: "Order edit",
  fulfillment: "Fulfillment",
  return: "Return",
  cancellation: "Order canceled",
};

const STATES = {
  available: "available",
  on_hand: "on hand",
  committed: "committed",
  reserved: "reserved",
  incoming: "incoming",
  damaged: "damaged",
  quality_control: "quality control",
  safety_stock: "safety stock",
};

export const reasonLabel = (r) =>
  r ? REASONS[r] ?? r.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : null;

export const whoLabel = (staff, app) => (staff && app ? `${staff} · ${app}` : staff ?? app ?? "Unknown");

// Who filter → Prisma where (null means "not set")
const whoWhere = (who) => (who ? { appName: who.app ?? null, staffName: who.staff ?? null } : {});

// ---------------------------------------------------------------------------
// Kinds of activity, for filtering lists of changes
// ---------------------------------------------------------------------------

const ORDER_REASONS = ["purchase", "order_edit", "fulfillment", "return", "cancellation"];
const isUndoRow = { OR: [{ groupId: { startsWith: "undo-" } }, { referenceUri: { startsWith: "gid://order-history/InventoryUndo/" } }] };
const notUndoRow = {
  AND: [
    { OR: [{ groupId: null }, { NOT: { groupId: { startsWith: "undo-" } } }] },
    { OR: [{ referenceUri: null }, { NOT: { referenceUri: { startsWith: "gid://order-history/InventoryUndo/" } } }] },
  ],
};
const orderRow = { OR: [{ reason: { in: ORDER_REASONS } }, { referenceType: "Order" }] };
const notOrderRow = {
  AND: [
    { OR: [{ reason: null }, { reason: { notIn: ORDER_REASONS } }] },
    { OR: [{ referenceType: null }, { NOT: { referenceType: "Order" } }] },
  ],
};

export const KIND_OPTIONS = {
  all: { label: "All activity" },
  manual: { label: "Manual staff changes" },
  apps: { label: "App changes" },
  orders: { label: "Orders and fulfillment" },
  undos: { label: "Undos" },
};

function kindWhere(kind) {
  switch (kind) {
    // Staff editing stock themselves (in Shopify admin, POS stock counts, etc.)
    // plus undos made in this app
    case "manual":
      return { OR: [{ AND: [{ staffName: { not: null } }, notOrderRow, notUndoRow] }, isUndoRow] };
    // Apps changing stock on their own (e.g. Linnworks), not orders or undos
    case "apps":
      return { AND: [{ appName: { not: null } }, { staffName: null }, notOrderRow, notUndoRow] };
    case "orders":
      return orderRow;
    case "undos":
      return isUndoRow;
    default:
      return null;
  }
}

export const SINCE_OPTIONS = {
  "7d": { label: "Last 7 days", days: 7 },
  "30d": { label: "Last 30 days", days: 30 },
  "90d": { label: "Last 90 days", days: 90 },
  "365d": { label: "Last 12 months", days: 365 },
  all: { label: "All time", days: null },
};

// ---------------------------------------------------------------------------
// Store-time days ("YYYY-MM-DD" in Pacific time) → exact instants
// ---------------------------------------------------------------------------

const STORE_TZ = "America/Los_Angeles";
const offsetFmt = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TZ, timeZoneName: "longOffset" });

function storeOffsetMinutes(at) {
  const name = offsetFmt.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
}

// Midnight at the start of a store-time day, as a Date
export function storeDayStart(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return null;
  const [y, m, d] = day.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  // Guess with the offset near that time, then correct with the offset at the
  // guessed instant (handles the days clocks change)
  const guess = utcMidnight - storeOffsetMinutes(new Date(utcMidnight)) * 60 * 1000;
  return new Date(utcMidnight - storeOffsetMinutes(new Date(guess)) * 60 * 1000);
}

// Builds the time part of a query from a preset ("30d") or a custom from/to
function timeWhere({ since, from, to }) {
  const range = {};
  const fromDate = from ? storeDayStart(from) : since ? sinceDate(since) : null;
  if (fromDate) range.gte = fromDate;
  if (to) {
    const end = storeDayStart(to);
    if (end) range.lt = new Date(end.getTime() + 24 * 3600 * 1000 );
  }
  return Object.keys(range).length ? { occurredAt: range } : {};
}

// ---------------------------------------------------------------------------
// Undo markers
// ---------------------------------------------------------------------------

// Changes that belong to orders, returns, transfers or reservations can't be
// undone here: reversing one side of those would leave Shopify inconsistent.
const NOT_UNDOABLE = /^(purchase|order_edit|fulfillment|return|cancellation|reservation_|movement_)/;

export const undoIdFromRows = (rows) => {
  for (const r of rows) {
    if (r.groupId?.startsWith("undo-")) return Number(r.groupId.slice(5));
    if (r.referenceUri?.startsWith(UNDO_URI_PREFIX)) return Number(r.referenceUri.slice(UNDO_URI_PREFIX.length));
    if (r.referenceType === "InventoryUndo" && /^\d+$/.test(r.referenceId ?? "")) return Number(r.referenceId);
  }
  return null;
};

const sinceDate = (key) => {
  const days = SINCE_OPTIONS[key]?.days;
  return days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
};

export async function itemNames(shop, itemIds) {
  const infos = await db.inventoryItemInfo.findMany({
    where: { shop, inventoryItemId: { in: [...new Set(itemIds.filter(Boolean))] } },
  });
  return new Map(
    infos.map((i) => [
      i.inventoryItemId,
      {
        productId: i.productId,
        name: `${i.productTitle ?? "Unknown product"}${i.variantTitle && i.variantTitle !== "Default Title" ? ` · ${i.variantTitle}` : ""}`,
        variant: i.variantTitle && i.variantTitle !== "Default Title" ? i.variantTitle : null,
        sku: i.sku,
      },
    ]),
  );
}

const NO_UNDOS = { byKey: new Map(), byId: new Map() };

function buildChange(key, rows, names, undos = NO_UNDOS) {
  const first = rows[0];
  const parts = rows
    .filter((r) => r.change !== 0)
    .map((r) => ({ state: r.state, label: STATES[r.state] ?? r.state.replace(/_/g, " "), change: r.change }))
    .sort((a, b) => (a.state === "available" ? -1 : b.state === "available" ? 1 : 0));
  const ref = rows.find((r) => r.referenceType || r.referenceUri) ?? first;
  const orderId =
    ref.referenceType === "Order" ? ref.referenceId ?? ref.referenceUri?.match(/(\d+)$/)?.[1] ?? null : null;
  const n = names.get(first.inventoryItemId);

  return {
    key,
    pending: false,
    at: first.occurredAt.toISOString(),
    parts,
    available: parts.find((p) => p.state === "available")?.change ?? null,
    staff: first.staffName,
    app: first.appName,
    who: whoLabel(first.staffName, first.appName),
    reason: first.reason,
    reasonLabel: reasonLabel(first.reason),
    location: rows.map((r) => r.locationName).find(Boolean) ?? null,
    inventoryItemId: first.inventoryItemId,
    productId: n?.productId ?? first.productId,
    item: n?.name ?? first.sku ?? "Unknown item",
    variant: n?.variant ?? null,
    sku: n?.sku ?? first.sku,
    order: orderId ? { id: orderId } : null,
    adjustmentIds: rows.map((r) => r.adjustmentId),
    ...undoInfo(key, rows, first, orderId, parts, undos),
  };
}

function undoInfo(key, rows, first, orderId, parts, undos) {
  const undoId = undoIdFromRows(rows);
  if (undoId) {
    const u = undos.byId.get(undoId);
    return {
      isUndo: true,
      who: u ? `${u.userName ?? "Staff member"} · Undo` : whoLabel(first.staffName, first.appName),
      reasonLabel: u?.originalAt ? `Undo of change from ${new Date(u.originalAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: STORE_TZ })}` : "Undo",
      undoable: false,
    };
  }
  const done = undos.byKey.get(key);
  if (done) {
    return { undoneBy: { name: done.userName ?? "Staff member", at: done.createdAt.toISOString() }, undoable: false };
  }
  const available = parts.find((p) => p.state === "available")?.change ?? 0;
  // Stock the pre-order countdowns put on sale or held back: undoing it here
  // would upset the sales limit, so it's managed on the countdowns page
  if (rows.some((r) => r.referenceUri?.startsWith("gid://order-history/PreorderWindow/"))) {
    return { undoable: false, reasonLabel: "Pre-order limit (countdowns)" };
  }
  // Only plain stock changes. Moves between states (e.g. available → damaged)
  // would be left half-reversed.
  const plainStock = parts.every((p) => p.state === "available" || p.state === "on_hand");
  const undoable =
    available !== 0 &&
    plainStock &&
    !orderId &&
    !NOT_UNDOABLE.test(first.reason ?? "") &&
    rows.every((r) => r.inventoryItemId && r.locationId);
  return { undoable };
}

async function loadUndos(shop, keys, rowLists) {
  const ids = rowLists.map(undoIdFromRows).filter(Boolean);
  const list = await db.inventoryUndo.findMany({
    where: { shop, status: "applied", OR: [{ originalKey: { in: keys } }, { id: { in: ids } }] },
  });
  return {
    byKey: new Map(list.map((u) => [u.originalKey, u])),
    byId: new Map(list.map((u) => [u.id, u])),
  };
}

// Live entries whose full record hasn't arrived from Shopify yet
async function pendingEntries(shop, where) {
  const events = await db.inventoryEvent.findMany({
    where: {
      shop,
      detailsStatus: "pending",
      occurredAt: { gte: new Date(Date.now() - PENDING_WINDOW_MS) },
      ...(where.inventoryItemId ? { inventoryItemId: where.inventoryItemId } : {}),
      ...(where.productId ? { productId: where.productId } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: 50,
  });
  // Our own undos already show from their placeholder row
  const undos = events.length
    ? await db.inventoryUndo.findMany({
        where: { shop, status: "applied", createdAt: { gte: new Date(Date.now() - PENDING_WINDOW_MS) } },
      })
    : [];
  const isOurUndo = (e) =>
    undos.some(
      (u) =>
        u.inventoryItemId === e.inventoryItemId &&
        u.locationId === e.locationId &&
        u.delta === e.change &&
        Math.abs(u.createdAt.getTime() - e.occurredAt.getTime()) < 5 * 60 * 1000,
    );
  return events
    .filter((e) => e.change !== null && !isOurUndo(e))
    .map((e) => ({
      key: `pending-${e.id}`,
      pending: true,
      at: e.occurredAt.toISOString(),
      parts: [{ state: "available", label: "available", change: e.change }],
      available: e.change,
      who: null,
      reasonLabel: null,
      location: e.locationName,
      inventoryItemId: e.inventoryItemId,
      productId: e.productId,
      item: `${e.productTitle ?? "Unknown product"}${e.variantTitle && e.variantTitle !== "Default Title" ? ` · ${e.variantTitle}` : ""}`,
      sku: e.sku,
      order: null,
    }));
}

// Changes, newest first.
// filter: { productId?, inventoryItemId?, who?, since? ("30d"), from?, to? ("YYYY-MM-DD") }
// Returns { changes, hasMore }. Pending live entries are included on page 1
// when not filtering by who or a past date range.
export async function listChanges(shop, filter = {}, { page = 1, pageSize = 10 } = {}) {
  const time = timeWhere(filter);
  const since = Boolean(time.occurredAt);
  const where = {
    shop,
    ...(filter.productId ? { productId: filter.productId } : {}),
    ...(filter.inventoryItemId ? { inventoryItemId: filter.inventoryItemId } : {}),
    ...time,
    ...whoWhere(filter.who),
  };
  const kind = kindWhere(filter.kind);
  if (kind) where.AND = [kind];

  // For the whole store, look at recent days first and widen only if needed,
  // so the database never has to sort the entire history at once.
  // Filtered lists (one item or product) are small enough to sort directly.
  const skip = (page - 1) * pageSize;
  const narrow = Boolean(filter.productId || filter.inventoryItemId);
  const windows = narrow || since ? [null] : [2, 14, 60, 365, null];
  let groups = [];
  for (const days of windows) {
    const windowWhere = days
      ? { ...where, occurredAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } }
      : where;
    groups = await db.inventoryAdjustment.groupBy({
      by: ["groupId", "inventoryItemId", "locationId"],
      where: windowWhere,
      _max: { occurredAt: true },
      orderBy: { _max: { occurredAt: "desc" } },
      skip,
      take: pageSize + 1,
    });
    if (groups.length > pageSize) break; // enough for this page and to know there's more
  }
  const hasMore = groups.length > pageSize;
  const shown = groups.slice(0, pageSize);

  const rows = shown.length
    ? await db.inventoryAdjustment.findMany({
        where: {
          shop,
          OR: shown.map((g) => ({ groupId: g.groupId, inventoryItemId: g.inventoryItemId, locationId: g.locationId })),
        },
        orderBy: { occurredAt: "desc" },
      })
    : [];

  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.groupId}|${r.inventoryItemId}|${r.locationId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const names = await itemNames(shop, rows.map((r) => r.inventoryItemId));
  const undos = await loadUndos(shop, [...byKey.keys()], [...byKey.values()]);
  let changes = shown
    .map((g) => {
      const key = `${g.groupId}|${g.inventoryItemId}|${g.locationId}`;
      return byKey.has(key) ? buildChange(key, byKey.get(key), names, undos) : null;
    })
    .filter(Boolean);

  // Notifications without details yet can't be sorted into kinds, so they
  // only show under "All activity"
  if (page === 1 && !filter.who && !filter.to && !kind) {
    const pending = await pendingEntries(shop, where);
    changes = [...pending, ...changes];
  }

  return { changes, hasMore };
}

// One change by its key ("groupId|inventoryItemId|locationId"), or null
export async function getChange(shop, key) {
  const [groupId, inventoryItemId, locationId] = String(key ?? "").split("|");
  if (!inventoryItemId || !locationId) return null;
  const rows = await db.inventoryAdjustment.findMany({
    where: { shop, groupId: groupId === "null" ? null : groupId, inventoryItemId, locationId },
    orderBy: { occurredAt: "desc" },
  });
  if (!rows.length) return null;
  const names = await itemNames(shop, [inventoryItemId]);
  const undos = await loadUndos(shop, [key], [rows]);
  return buildChange(key, rows, names, undos);
}

// Who changed stock: count of changes and net change to available stock
export async function whoSummary(shop, sinceKey) {
  const since = sinceDate(sinceKey);
  const rows = await db.inventoryAdjustment.groupBy({
    by: ["appName", "staffName"],
    where: { shop, state: "available", ...(since ? { occurredAt: { gte: since } } : {}) },
    _count: { _all: true },
    _sum: { change: true },
  });
  return rows
    .map((r) => ({
      app: r.appName,
      staff: r.staffName,
      who: whoLabel(r.staffName, r.appName),
      changes: r._count._all,
      net: r._sum.change ?? 0,
    }))
    .sort((a, b) => b.changes - a.changes);
}

// The items one app or person changed
export async function whoItems(shop, who, sinceKey) {
  const since = sinceDate(sinceKey);
  const rows = await db.inventoryAdjustment.groupBy({
    by: ["inventoryItemId"],
    where: { shop, state: "available", ...whoWhere(who), ...(since ? { occurredAt: { gte: since } } : {}) },
    _count: { _all: true },
    _sum: { change: true },
    _max: { occurredAt: true },
  });
  const names = await itemNames(shop, rows.map((r) => r.inventoryItemId));
  return rows
    .map((r) => ({
      inventoryItemId: r.inventoryItemId,
      item: names.get(r.inventoryItemId)?.name ?? "Unknown item",
      sku: names.get(r.inventoryItemId)?.sku ?? null,
      changes: r._count._all,
      net: r._sum.change ?? 0,
      lastAt: r._max.occurredAt?.toISOString() ?? null,
    }))
    .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

export async function itemName(shop, inventoryItemId) {
  return (await itemNames(shop, [inventoryItemId])).get(inventoryItemId) ?? null;
}

// Who has changed one product's stock (for the product page filter)
export async function whoForProduct(shop, productId) {
  const rows = await db.inventoryAdjustment.groupBy({
    by: ["appName", "staffName"],
    where: { shop, productId, state: "available" },
    _count: { _all: true },
  });
  return rows
    .map((r) => ({ app: r.appName, staff: r.staffName, who: whoLabel(r.staffName, r.appName), changes: r._count._all }))
    .sort((a, b) => b.changes - a.changes);
}
