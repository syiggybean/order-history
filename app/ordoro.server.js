import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { runBulkQuery } from "./bulk.server";
import { addressKey, addressText } from "./blocklist.server";
import { errorMessage } from "./preorders.server";

// ---------------------------------------------------------------------------
// Shopify ↔ Ordoro order reconciliation, for cleaning up before offboarding
// Ordoro. A run reads both systems for a date range, pairs the orders and
// stores only the ones that differ. Staff mark them resolved/ignored and keep
// research notes; re-running updates the differences and keeps the notes.
//
// Ordoro: https://api.ordoro.com, Basic auth with an API key + secret
// (Settings → Account Settings → API Keys). 500 requests a minute.
// ---------------------------------------------------------------------------

export class OrdoroError extends Error {}

const ORDORO = "https://api.ordoro.com";
const PAGE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const testing = () => process.env.NODE_ENV === "test";

export const ordoroConfigured = () => Boolean(process.env.ORDORO_API_KEY && process.env.ORDORO_API_SECRET);

export const ISSUE_TYPES = {
  missing_ordoro: "Not in Ordoro",
  missing_shopify: "Not in Shopify",
  shipped: "Shipped status",
  tracking: "Tracking",
  items: "Items / quantities",
  cancelled: "Cancelled",
  address: "Shipping address",
  total: "Order total",
};
export const STATUSES = { open: "Open", resolved: "Resolved", ignored: "Ignored", fixed: "Now matches" };

const clean = (v) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const money = (n) => Math.round(Number(n || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Ordoro
// ---------------------------------------------------------------------------

async function ordoroGet(path) {
  const auth = Buffer.from(`${process.env.ORDORO_API_KEY}:${process.env.ORDORO_API_SECRET}`).toString("base64");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ORDORO}${path}`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) {
      throw new OrdoroError("Ordoro didn't accept the API key and secret. Check ORDORO_API_KEY and ORDORO_API_SECRET in Railway (API access needs Ordoro's Premium plan or above).");
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(testing() ? 5 : 5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new OrdoroError(`Ordoro returned ${res.status} for ${path.split("?")[0]}`);
    return res.json();
  }
}

const COUNTRIES = { "united states": "US", "united states of america": "US", usa: "US", canada: "CA", "united kingdom": "GB", australia: "AU" };
const countryCode = (c) => {
  const s = clean(c);
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRIES[s.toLowerCase()] ?? s;
};

// One Ordoro order → the fields we compare
export function normalizeOrdoro(o) {
  const ship = o.shipping_info ?? {};
  const trackings = [ship.tracking_number, ...(Array.isArray(ship.package_tracking) ? ship.package_tracking : [ship.package_tracking])]
    .flatMap((t) => (typeof t === "string" ? [t] : t && typeof t === "object" ? [t.tracking_number ?? t.tracking] : []))
    .map(clean)
    .filter(Boolean);
  const status = String(o.status ?? "").toLowerCase();
  const a = o.shipping_address ?? {};
  return {
    number: String(o.order_number ?? o.id),
    parent: clean(o.parent_order_number),
    placedAt: o.order_placed_date ?? o.created_date ?? null,
    status,
    cancelled: Boolean(o.cancelled_date) || /cancel/.test(status),
    shipped: /shipped|dropshipped/.test(status) || Boolean(ship.ship_date && !ship.void),
    tracking: [...new Set(trackings.map((t) => t.toUpperCase().replace(/\s+/g, "")))],
    lines: (o.lines ?? []).map((l) => ({ sku: clean(l.sku), qty: Number(l.quantity) || 0, name: l.product_name ?? null })),
    cartOrderId: clean((o.lines ?? []).map((l) => l.cart_order_id).find(Boolean)),
    address: {
      name: clean(a.name),
      address1: clean(a.street1),
      address2: clean(a.street2),
      city: clean(a.city),
      province_code: clean(a.state),
      zip: clean(a.zip),
      country_code: countryCode(a.country),
    },
    total: o.financial?.grand_total != null ? money(o.financial.grand_total) : null,
    channel: o.sales_channel?.id != null ? String(o.sales_channel.id) : null,
  };
}

// Orders Ordoro split into several shipments → one order again
export function combineSplits(list) {
  const groups = new Map();
  for (const o of list) {
    const root = o.parent ?? o.number;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  }
  return [...groups.entries()].map(([root, parts]) => {
    if (parts.length === 1) return { ...parts[0], number: root, parts: [parts[0].number] };
    const main = parts.find((p) => p.number === root) ?? parts[0];
    const live = parts.filter((p) => !p.cancelled);
    const lines = new Map();
    for (const p of live.length ? live : parts) for (const l of p.lines) lines.set(l.sku ?? "(no SKU)", (lines.get(l.sku ?? "(no SKU)") ?? 0) + l.qty);
    return {
      ...main,
      number: root,
      parts: parts.map((p) => p.number),
      cancelled: parts.every((p) => p.cancelled),
      shipped: live.length > 0 && live.every((p) => p.shipped),
      tracking: [...new Set(parts.flatMap((p) => p.tracking))],
      lines: [...lines.entries()].map(([sku, qty]) => ({ sku: sku === "(no SKU)" ? null : sku, qty })),
      total: main.total ?? parts.reduce((t, p) => t + (p.total ?? 0), 0),
      cartOrderId: parts.map((p) => p.cartOrderId).find(Boolean) ?? null,
    };
  });
}

export async function fetchOrdoro(fromDay, toDay, step) {
  // Ordoro filters by when it imported the order; widen a little and filter by order date
  const after = new Date(Date.parse(`${fromDay}T00:00:00Z`) - 3 * 86400000).toISOString();
  const lo = Date.parse(`${fromDay}T00:00:00-08:00`);
  const hi = Date.parse(`${toDay}T23:59:59-07:00`);
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const body = await ordoroGet(`/v3/order?created_after=${encodeURIComponent(after)}&limit=${PAGE}&offset=${offset}`);
    const list = body?.order ?? [];
    for (const o of list) {
      const n = normalizeOrdoro(o);
      const t = n.placedAt ? Date.parse(n.placedAt) : null;
      if (t === null || (t >= lo && t <= hi)) out.push(n);
    }
    await step?.(`Reading Ordoro: ${Math.min(offset + list.length, body?.count ?? offset + list.length).toLocaleString()} of ${(body?.count ?? 0).toLocaleString()} orders`);
    if (list.length < PAGE || offset + PAGE >= (body?.count ?? 0)) break;
    await sleep(testing() ? 0 : 150);
  }
  return combineSplits(out);
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

const shopifyOrdersQuery = (fromDay, toDay) => `{
  orders(query: "created_at:>='${fromDay}T00:00:00-08:00' AND created_at:<='${toDay}T23:59:59-07:00'") {
    edges {
      node {
        id
        legacyResourceId
        name
        createdAt
        cancelledAt
        test
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount } }
        shippingAddress { name address1 address2 city provinceCode zip countryCodeV2 }
        fulfillments { status trackingInfo { number } }
        lineItems { edges { node { sku currentQuantity requiresShipping name } } }
      }
    }
  }
}`;

export async function fetchShopify(admin, fromDay, toDay, step) {
  const rows = await runBulkQuery(admin, shopifyOrdersQuery(fromDay, toDay), { label: "Reading Shopify orders", onProgress: step });
  const orders = new Map();
  for (const r of rows) {
    if (r.__parentId) {
      const o = orders.get(r.__parentId);
      if (o && r.currentQuantity > 0) o.allLines.push({ sku: clean(r.sku), qty: Number(r.currentQuantity) || 0, ships: r.requiresShipping !== false, name: r.name });
      continue;
    }
    orders.set(r.id, {
      id: r.id,
      legacyId: String(r.legacyResourceId ?? r.id.split("/").pop()),
      name: r.name,
      number: String(r.name ?? "").replace(/^#/, ""),
      placedAt: r.createdAt,
      test: Boolean(r.test),
      cancelled: Boolean(r.cancelledAt),
      fulfillment: r.displayFulfillmentStatus ?? null,
      shipped: r.displayFulfillmentStatus === "FULFILLED",
      tracking: [
        ...new Set(
          (r.fulfillments ?? [])
            .filter((f) => !/CANCELLED|ERROR|FAILURE/.test(f.status ?? ""))
            .flatMap((f) => (f.trackingInfo ?? []).map((t) => clean(t.number)))
            .filter(Boolean)
            .map((t) => t.toUpperCase().replace(/\s+/g, "")),
        ),
      ],
      address: r.shippingAddress ?? null,
      total: money(r.currentTotalPriceSet?.shopMoney?.amount),
      allLines: [],
    });
  }
  for (const o of orders.values()) {
    o.lines = o.allLines.filter((l) => l.ships);
    o.shipsAnything = o.lines.length > 0 || o.allLines.length === 0;
  }
  return [...orders.values()];
}

// ---------------------------------------------------------------------------
// Pairing and comparing
// ---------------------------------------------------------------------------

// "M-1001", "1-1001", "1001-2" → "1001"
export const orderDigits = (s) => {
  const m = String(s ?? "").match(/(?:^|[^\d])?(\d{3,})(?:-\d{1,2})?$/);
  return m ? m[1] : null;
};

const lineMap = (lines) => {
  const m = new Map();
  for (const l of lines) m.set(l.sku ?? "(no SKU)", (m.get(l.sku ?? "(no SKU)") ?? 0) + l.qty);
  return m;
};
const linesText = (m) => [...m.entries()].sort().map(([sku, q]) => `${q} × ${sku}`).join(", ") || "none";

export function compareOrders(s, o) {
  const issues = [];
  const add = (type, shopify, ordoro) => issues.push({ type, label: ISSUE_TYPES[type], shopify, ordoro });
  if (s.cancelled !== o.cancelled) add("cancelled", s.cancelled ? "Cancelled" : "Not cancelled", o.cancelled ? "Cancelled" : "Not cancelled");
  const bothCancelled = s.cancelled && o.cancelled;
  if (!bothCancelled) {
    if (s.shipped !== o.shipped) add("shipped", s.shipped ? "Shipped" : `Not shipped (${String(s.fulfillment ?? "unfulfilled").toLowerCase().replace(/_/g, " ")})`, o.shipped ? "Shipped" : `Not shipped (${o.status || "no status"})`);
    const st = [...s.tracking].sort().join(", ");
    const ot = [...o.tracking].sort().join(", ");
    if ((s.tracking.length || o.tracking.length) && st !== ot) add("tracking", st || "No tracking", ot || "No tracking");
    const sm = lineMap(s.lines);
    const om = lineMap(o.lines);
    const keys = new Set([...sm.keys(), ...om.keys()]);
    if ([...keys].some((k) => (sm.get(k) ?? 0) !== (om.get(k) ?? 0))) add("items", linesText(sm), linesText(om));
    const sk = addressKey(s.address);
    const ok = addressKey(o.address);
    if (sk && ok && sk !== ok) add("address", addressText(s.address), addressText(o.address));
    if (o.total !== null && Math.abs(s.total - o.total) > 0.01) add("total", `$${s.total.toFixed(2)}`, `$${o.total.toFixed(2)}`);
  }
  return issues;
}

// Both lists → [{ key, shopify, ordoro, issues }] for the ones that differ
export function reconcile(shopifyOrders, ordoroOrders) {
  const byLegacy = new Map();
  const byDigits = new Map();
  for (const s of shopifyOrders) {
    byLegacy.set(s.legacyId, s);
    if (s.number) byDigits.set(orderDigits(s.number) ?? s.number, s);
  }
  const matched = new Set();
  const pairs = [];
  const unmatchedOrdoro = [];
  for (const o of ordoroOrders) {
    const s = (o.cartOrderId && byLegacy.get(o.cartOrderId.replace(/\D/g, ""))) || byDigits.get(orderDigits(o.number));
    if (s && !matched.has(s.id)) {
      matched.add(s.id);
      pairs.push([s, o]);
    } else unmatchedOrdoro.push(o);
  }
  // Ordoro channels that are your Shopify store: the ones whose orders matched
  const shopifyChannels = new Set(pairs.map(([, o]) => o.channel).filter(Boolean));
  const out = [];
  let excluded = 0;
  for (const [s, o] of pairs) {
    const issues = compareOrders(s, o);
    if (issues.length) out.push({ key: `s:${s.legacyId}`, shopify: s, ordoro: o, issues });
  }
  for (const s of shopifyOrders) {
    if (matched.has(s.id)) continue;
    if (s.test || !s.shipsAnything) {
      excluded++;
      continue;
    }
    out.push({ key: `s:${s.legacyId}`, shopify: s, ordoro: null, issues: [{ type: "missing_ordoro", label: ISSUE_TYPES.missing_ordoro, shopify: s.name, ordoro: "No matching order" }] });
  }
  let otherChannels = 0;
  for (const o of unmatchedOrdoro) {
    // Orders from Ordoro's other sales channels (Amazon, manual…) aren't expected in Shopify
    if (shopifyChannels.size && o.channel && !shopifyChannels.has(o.channel)) {
      otherChannels++;
      continue;
    }
    out.push({ key: `o:${o.number}`, shopify: null, ordoro: o, issues: [{ type: "missing_shopify", label: ISSUE_TYPES.missing_shopify, shopify: "No matching order", ordoro: o.number }] });
  }
  return { mismatches: out, stats: { shopify: shopifyOrders.length, ordoro: ordoroOrders.length, matched: pairs.length, excluded, otherChannels, noMatchesAtAll: pairs.length === 0 && shopifyOrders.length > 0 && ordoroOrders.length > 0 } };
}

// ---------------------------------------------------------------------------
// Runs (background) and saving
// ---------------------------------------------------------------------------

const running = new Map();
export const isRunning = (shop) => running.has(shop);

export async function startRun(shop, { fromDay, toDay }, user, { admin = null } = {}) {
  if (!ordoroConfigured()) throw new OrdoroError("Add ORDORO_API_KEY and ORDORO_API_SECRET in Railway first.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(toDay ?? "") || fromDay > toDay) throw new OrdoroError("Choose a valid date range.");
  if (running.has(shop)) throw new OrdoroError("A comparison is already running.");
  const run = await db.ordoroRun.create({ data: { shop, fromDay, toDay, status: "running", step: "Starting", startedBy: user?.name ?? null } });
  const step = (text) => db.ordoroRun.update({ where: { id: run.id }, data: { step: text } }).catch(() => {});
  const p = (async () => {
    try {
      const client = admin ?? (await unauthenticated.admin(shop)).admin;
      await step("Reading Shopify orders");
      const shopifyOrders = await fetchShopify(client, fromDay, toDay, step);
      await step("Reading Ordoro orders");
      const ordoroOrders = await fetchOrdoro(fromDay, toDay, step);
      await step("Comparing");
      const { mismatches, stats } = reconcile(shopifyOrders, ordoroOrders);
      const counts = await saveMismatches(shop, run.id, fromDay, toDay, mismatches);
      await db.ordoroRun.update({ where: { id: run.id }, data: { status: "done", step: "Finished", finishedAt: new Date(), counts: JSON.stringify({ ...stats, ...counts }) } });
    } catch (e) {
      console.error(`[ordoro] ${shop}:`, errorMessage(e));
      await db.ordoroRun.update({ where: { id: run.id }, data: { status: "failed", step: "Stopped", error: errorMessage(e).slice(0, 500), finishedAt: new Date() } }).catch(() => {});
    } finally {
      running.delete(shop);
    }
  })();
  running.set(shop, p);
  if (testing()) await p;
  return run.id;
}

const brief = (s, o) => ({
  shopify: s ? { name: s.name, legacyId: s.legacyId, placedAt: s.placedAt, cancelled: s.cancelled, fulfillment: s.fulfillment, tracking: s.tracking, total: s.total, lines: s.lines, address: s.address } : null,
  ordoro: o ? { number: o.number, parts: o.parts, placedAt: o.placedAt, status: o.status, cancelled: o.cancelled, shipped: o.shipped, tracking: o.tracking, total: o.total, lines: o.lines, address: o.address, channel: o.channel } : null,
});

async function saveMismatches(shop, runId, fromDay, toDay, mismatches) {
  const now = new Date();
  let added = 0;
  let reopened = 0;
  for (const m of mismatches) {
    const placedAt = new Date((m.shopify ?? m.ordoro).placedAt ?? now);
    const data = {
      orderName: m.shopify?.name ?? `Ordoro ${m.ordoro.number}`,
      shopifyOrderId: m.shopify?.legacyId ?? null,
      ordoroNumber: m.ordoro?.number ?? null,
      placedAt,
      issues: JSON.stringify(m.issues),
      issueTypes: `,${m.issues.map((i) => i.type).join(",")},`,
      detail: JSON.stringify(brief(m.shopify, m.ordoro)),
      lastRunId: runId,
      lastSeenAt: now,
    };
    const existing = await db.ordoroIssue.findUnique({ where: { shop_key: { shop, key: m.key } } });
    if (!existing) {
      await db.ordoroIssue.create({ data: { shop, key: m.key, ...data, status: "open" } });
      added++;
    } else {
      // It matched last time but differs again: back to open
      const reopen = existing.status === "fixed";
      if (reopen) reopened++;
      await db.ordoroIssue.update({ where: { id: existing.id }, data: { ...data, ...(reopen ? { status: "open", statusBy: null, statusAt: now } : {}) } });
    }
  }
  // In this date range, not different any more: the data was fixed
  const lo = new Date(`${fromDay}T00:00:00-08:00`);
  const hi = new Date(`${toDay}T23:59:59-07:00`);
  const { count: fixed } = await db.ordoroIssue.updateMany({
    where: { shop, placedAt: { gte: lo, lte: hi }, NOT: { lastRunId: runId }, status: { in: ["open"] } },
    data: { status: "fixed", statusAt: now, statusBy: "Re-check" },
  });
  return { found: mismatches.length, added, reopened, fixed };
}

// ---------------------------------------------------------------------------
// Reading and editing
// ---------------------------------------------------------------------------

export async function latestRun(shop) {
  const r = await db.ordoroRun.findFirst({ where: { shop }, orderBy: { id: "desc" } });
  if (!r) return null;
  return {
    id: r.id,
    fromDay: r.fromDay,
    toDay: r.toDay,
    status: r.status,
    step: r.step,
    error: r.error,
    startedBy: r.startedBy,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    counts: r.counts ? JSON.parse(r.counts) : null,
  };
}

export async function listIssues(shop, { status = "open", type = "", q = "", page = 1, pageSize = 50 } = {}) {
  const text = String(q ?? "").trim();
  const where = {
    shop,
    ...(status && status !== "all" ? { status } : {}),
    ...(type && ISSUE_TYPES[type] ? { issueTypes: { contains: `,${type},` } } : {}),
    ...(text
      ? {
          OR: [
            { orderName: { contains: text, mode: "insensitive" } },
            { ordoroNumber: { contains: text, mode: "insensitive" } },
            { shopifyOrderId: { contains: text } },
            { notes: { some: { body: { contains: text, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
  const [rows, total, byStatus, all] = await Promise.all([
    db.ordoroIssue.findMany({ where, orderBy: [{ placedAt: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { _count: { select: { notes: true } } } }),
    db.ordoroIssue.count({ where }),
    db.ordoroIssue.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
    db.ordoroIssue.findMany({ where: { shop, status: status && status !== "all" ? status : undefined }, select: { issueTypes: true } }),
  ]);
  const byType = {};
  for (const r of all) for (const t of r.issueTypes.split(",").filter(Boolean)) byType[t] = (byType[t] ?? 0) + 1;
  return {
    rows: rows.map(issueView),
    total,
    page,
    pageSize,
    counts: { byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])), byType },
  };
}

const issueView = (r) => ({
  id: r.id,
  key: r.key,
  orderName: r.orderName,
  shopifyOrderId: r.shopifyOrderId,
  ordoroNumber: r.ordoroNumber,
  placedAt: r.placedAt.toISOString(),
  issues: JSON.parse(r.issues),
  status: r.status,
  statusBy: r.statusBy,
  statusAt: r.statusAt?.toISOString() ?? null,
  lastSeenAt: r.lastSeenAt.toISOString(),
  notes: r._count?.notes ?? 0,
});

export async function issueDetail(shop, id) {
  const r = await db.ordoroIssue.findFirst({ where: { shop, id: Number(id) }, include: { notes: { orderBy: { createdAt: "asc" } } } });
  if (!r) throw new OrdoroError("That order couldn't be found.");
  return {
    ...issueView({ ...r, _count: { notes: r.notes.length } }),
    detail: JSON.parse(r.detail ?? "{}"),
    notes: r.notes.map((n) => ({ id: n.id, body: n.body, by: n.by, at: n.createdAt.toISOString() })),
  };
}

export async function setIssueStatus(shop, id, status, user) {
  if (!["open", "resolved", "ignored"].includes(status)) throw new OrdoroError("Unknown status.");
  const r = await db.ordoroIssue.findFirst({ where: { shop, id: Number(id) } });
  if (!r) throw new OrdoroError("That order couldn't be found.");
  await db.ordoroIssue.update({ where: { id: r.id }, data: { status, statusBy: user?.name ?? null, statusAt: new Date() } });
}

export async function addIssueNote(shop, id, body, user) {
  const text = String(body ?? "").trim();
  if (!text) throw new OrdoroError("Write a note first.");
  const r = await db.ordoroIssue.findFirst({ where: { shop, id: Number(id) } });
  if (!r) throw new OrdoroError("That order couldn't be found.");
  return db.ordoroNote.create({ data: { shop, issueId: r.id, body: text.slice(0, 5000), by: user?.name ?? null } });
}

export async function deleteIssueNote(shop, noteId, user) {
  const n = await db.ordoroNote.findFirst({ where: { shop, id: Number(noteId) } });
  if (!n) throw new OrdoroError("That note couldn't be found.");
  if (n.by && user?.name && n.by !== user.name && !user.isAdmin && !user.isOwner) throw new OrdoroError("Only the person who wrote a note (or an admin) can delete it.");
  await db.ordoroNote.delete({ where: { id: n.id } });
}

// Everything matching a filter, for CSV export
export async function exportIssues(shop, filter) {
  const { rows } = await listIssues(shop, { ...filter, page: 1, pageSize: 20000 });
  const notes = await db.ordoroNote.findMany({ where: { shop, issueId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "asc" } });
  const byIssue = new Map();
  for (const n of notes) byIssue.set(n.issueId, [...(byIssue.get(n.issueId) ?? []), `${n.by ?? "Staff"}: ${n.body}`]);
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["Order", "Shopify order ID", "Ordoro order", "Placed", "Status", "Problems", "Shopify says", "Ordoro says", "Notes"].join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.orderName,
        r.shopifyOrderId,
        r.ordoroNumber,
        r.placedAt.slice(0, 10),
        STATUSES[r.status],
        r.issues.map((i) => i.label).join("; "),
        r.issues.map((i) => `${i.label}: ${i.shopify}`).join("; "),
        r.issues.map((i) => `${i.label}: ${i.ordoro}`).join("; "),
        (byIssue.get(r.id) ?? []).join(" | "),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n");
}
