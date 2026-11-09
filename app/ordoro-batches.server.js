import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { errorMessage, gql } from "./preorders.server";
import { OrdoroError, normalizeOrdoro, ordoroConfigured, ordoroGet, orderDigits } from "./ordoro.server";
import { getShippingSettings, logEvent, syncOrder } from "./shipping.server";

// ---------------------------------------------------------------------------
// Ordoro batches → MonkeyBean (a one-time move; re-running refreshes them)
//
// Each active Ordoro batch becomes Ordoro-Batch-NNNN (source "ordoro"), listed
// on its own tab. Its orders come in as they stand:
//   shipped in Ordoro and fulfilled in Shopify → shipped
//   not shipped, ready in MonkeyBean            → in the batch, not picked yet
//     (Ordoro doesn't report picking or packing)
//   not shipped, waiting in MonkeyBean          → in the batch as a pre-batch:
//     picking waits for the release date (or Pick early), like batching ahead
// Ordoro takes precedence over MonkeyBean's own pre-batches: an order sitting in
// one (not yet packed) moves to the Ordoro batch; a pre-batch left empty is cancelled.
//   shipped in Ordoro, NOT fulfilled in Shopify → flagged, and the batch is
//     locked (no picking, packing, labels…) until each is reconciled
// Anything else that doesn't line up (already in another batch, not found,
// cancelled) is noted on the batch without locking it.
// ---------------------------------------------------------------------------

export class OrdoroBatchError extends Error {}

export const SOURCE = "ordoro";
const tagFor = (n) => `Ordoro-Batch-${String(n).padStart(4, "0")}`;
const testing = () => process.env.NODE_ENV === "test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHIPPED = ["shipped", "closed"];

export const ISSUE_KINDS = {
  shipped_unfulfilled: { label: "Shipped in Ordoro, not in Shopify", blocking: true },
  shopify_shipped: { label: "Shipped in Shopify, not in Ordoro", blocking: false },
  other_batch: { label: "Already in another batch", blocking: false },
  waiting: { label: "Waiting in MonkeyBean", blocking: false },
  not_found: { label: "Not found in Shopify", blocking: false },
  cancelled: { label: "Cancelled", blocking: false },
  in_work: { label: "Already being worked", blocking: false },
  moved: { label: "Moved from a pre-batch", blocking: false },
};

// MonkeyBean's pre-batches (auto-batched ahead of a release): Ordoro's batch wins
const isPreBatch = (b) => Boolean(b?.source?.startsWith("auto:release:"));

// ---------------------------------------------------------------------------
// Reading Ordoro
// ---------------------------------------------------------------------------

export async function fetchActiveBatches() {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const body = await ordoroGet(`/v3/batch?active=true&limit=100&offset=${offset}&sort=created_date`);
    const list = body?.batch ?? [];
    for (const b of list) {
      if (b.archive_date) continue;
      out.push({
        ref: String(b.reference_id),
        notes: b.internal_notes ?? null,
        orderNumbers: (b.order_numbers ?? []).map(String),
        createdAt: b.created_date ?? null,
      });
    }
    if (list.length < 100 || offset + 100 >= (body?.count ?? 0)) break;
    await sleep(testing() ? 0 : 150);
  }
  return out;
}

const fetchOrdoroOrder = async (number) => {
  const o = await ordoroGet(`/v3/order/${encodeURIComponent(number)}`, { notFound: null });
  return o ? normalizeOrdoro(o) : null;
};

// ---------------------------------------------------------------------------
// Reading Shopify: each order's fulfillment orders and tracking
// ---------------------------------------------------------------------------

const SHOPIFY_ORDERS = `#graphql
  query ($q: String!) {
    orders(first: 50, query: $q) {
      nodes {
        id
        name
        cancelledAt
        displayFulfillmentStatus
        fulfillments(first: 20) { trackingInfo { number } }
        fulfillmentOrders(first: 30) { nodes { id status } }
      }
    }
  }`;

async function shopifyOrders(admin, names) {
  const out = new Map();
  for (let i = 0; i < names.length; i += 25) {
    const chunk = names.slice(i, i + 25);
    const q = chunk.map((n) => `name:${JSON.stringify(n)}`).join(" OR ");
    const data = await gql(admin, SHOPIFY_ORDERS, { q });
    for (const o of data?.orders?.nodes ?? []) {
      if (!chunk.some((n) => n.toLowerCase() === o.name.toLowerCase())) continue;
      out.set(o.name.toLowerCase(), {
        id: o.id,
        name: o.name,
        cancelled: Boolean(o.cancelledAt),
        status: o.displayFulfillmentStatus,
        tracking: [...new Set((o.fulfillments ?? []).flatMap((f) => (f.trackingInfo ?? []).map((t) => String(t.number ?? "").toUpperCase().replace(/\s+/g, ""))).filter(Boolean))],
        foStatus: new Map((o.fulfillmentOrders?.nodes ?? []).map((fo) => [fo.id, fo.status])),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// One Ordoro order: what it means for the batch
// ---------------------------------------------------------------------------

const json = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};
const skusOf = (s) => new Set(json(s.lines, []).map((l) => String(l.sku ?? "").trim().toUpperCase()).filter(Boolean));

// The MonkeyBean shipments an Ordoro order (or part of one) stands for: the
// order's parts, narrowed to the ones holding its SKUs when Ordoro split it
function matchShipments(shipments, o) {
  const live = shipments.filter((s) => s.state !== "cancelled");
  if (live.length <= 1) return live;
  const want = new Set(o.lines.map((l) => String(l.sku ?? "").trim().toUpperCase()).filter(Boolean));
  if (!want.size) return live;
  const hit = live.filter((s) => [...skusOf(s)].some((k) => want.has(k)));
  return hit.length ? hit : live;
}

// Works out (and applies) one Ordoro order's shipments for the batch.
// Returns the notes it left: [{ kind, shipmentId, detail, tracking }]
async function applyOrder(shop, admin, batch, number, o, sOrder, user, movedFrom = new Set()) {
  const notes = [];
  const note = (kind, detail, extra = {}) => notes.push({ kind, detail, shipmentId: null, tracking: null, ...extra });
  if (!o) {
    note("not_found", `Ordoro has no order ${number} any more.`);
    return { notes, orderName: null, orderId: null };
  }
  const name = `#${orderDigits(o.parent ?? o.number) ?? o.number}`;
  if (!sOrder) {
    note("not_found", `${name} isn't in Shopify, so it can't be worked here.`);
    return { notes, orderName: name, orderId: null };
  }
  if (o.cancelled || sOrder.cancelled) {
    note("cancelled", `${name} is cancelled in ${o.cancelled && sOrder.cancelled ? "both Ordoro and Shopify" : o.cancelled ? "Ordoro" : "Shopify"}; left out.`);
    return { notes, orderName: name, orderId: sOrder.id };
  }
  // Fresh from Shopify first, so the parts and their states are current
  await syncOrder(shop, admin, sOrder.id).catch((e) => console.error(`[ordoro-batches] sync ${name}:`, errorMessage(e)));
  const shipments = matchShipments(await db.shipment.findMany({ where: { shop, orderId: sOrder.id }, orderBy: { partIndex: "asc" } }), o);
  const tracking = o.tracking.join(", ") || null;
  const shopifyDone = sOrder.status === "FULFILLED";

  if (!shipments.length) {
    // Nothing for MonkeyBean to ship (fulfilled before it saw the order, or no shippable items)
    if (o.shipped && !shopifyDone) {
      note("shipped_unfulfilled", `${name} shipped in Ordoro${tracking ? ` (tracking ${tracking})` : ""}, but Shopify shows it ${String(sOrder.status).toLowerCase().replace(/_/g, " ")}.`, { tracking });
    } else if (!o.shipped && !shopifyDone) {
      note("not_found", `${name}: MonkeyBean has no open shipment for it (nothing left that needs shipping).`);
    }
    return { notes, orderName: name, orderId: sOrder.id };
  }

  for (const s of shipments) {
    const fulfilled = SHIPPED.includes(s.state) || sOrder.foStatus.get(s.fulfillmentOrderId) === "CLOSED";
    const elsewhere = s.batchId && s.batchId !== batch.id ? await db.batch.findUnique({ where: { id: s.batchId }, select: { id: true, tag: true, status: true, source: true, pickedAt: true } }) : null;
    const part = s.partCount > 1 ? ` (part ${s.partIndex} of ${s.partCount})` : "";
    // In a MonkeyBean pre-batch and not packed yet: comes here instead
    const fromPre = Boolean(elsewhere && elsewhere.status !== "cancelled" && isPreBatch(elsewhere) && s.state === "batched");
    if (fromPre) {
      const started = elsewhere.status !== "open" || elsewhere.pickedAt;
      note("moved", `${name}${part} moved here from ${elsewhere.tag} (a pre-batch)${started ? `; picking had started there, so check ${elsewhere.tag}'s tote for its items` : ""}.`, { shipmentId: s.id });
      movedFrom.add(elsewhere.id);
    }
    const otherLive = elsewhere && elsewhere.status !== "cancelled" && !fromPre;
    if (o.shipped && !fulfilled) {
      // Shipped in Ordoro but open in Shopify: the batch holds it and is locked
      note("shipped_unfulfilled", `${name}${part} shipped in Ordoro${tracking ? ` (tracking ${tracking})` : ""}, but it's not fulfilled in Shopify.`, { shipmentId: s.id, tracking });
      if (!otherLive && ["ready", "waiting", "batched"].includes(s.state)) {
        await db.shipment.update({ where: { id: s.id }, data: { batchId: batch.id, state: "batched", flag: null } });
      }
      continue;
    }
    if (fulfilled) {
      if (!otherLive) await db.shipment.update({ where: { id: s.id }, data: { batchId: batch.id } });
      if (!o.shipped) note("shopify_shipped", `${name}${part} is fulfilled in Shopify, though Ordoro doesn't show it shipped. Counted as shipped.`, { shipmentId: s.id });
      continue;
    }
    // Not shipped anywhere: it's still to do
    if (otherLive) {
      note("other_batch", `${name}${part} is already in ${elsewhere.tag}; left there.`, { shipmentId: s.id });
    } else if (["ready", "waiting"].includes(s.state) || fromPre || (s.state === "batched" && s.batchId === batch.id)) {
      // Waiting ones are pre-batched: in the batch now, picked once released
      await db.shipment.update({ where: { id: s.id }, data: { batchId: batch.id, state: "batched", flag: null } });
    } else if (s.batchId === batch.id) {
      // packed etc. in this batch already (re-import): leave as it is
    } else {
      note("in_work", `${name}${part} is ${s.state} in MonkeyBean; left as it is.`, { shipmentId: s.id });
    }
  }
  return { notes, orderName: name, orderId: sOrder.id };
}

// Saves an order's notes: replaces its open ones; anything someone reconciled
// by hand stays reconciled; problems that went away count as fixed
async function saveNotes(shop, batch, number, { notes, orderName, orderId }) {
  const existing = await db.ordoroBatchIssue.findMany({ where: { shop, batchId: batch.id, orderNumber: number } });
  const key = (n) => `${n.kind}|${n.shipmentId ?? ""}`;
  const now = new Map(notes.map((n) => [key(n), n]));
  for (const e of existing) {
    if (e.status !== "open") continue;
    if (!now.has(key(e))) {
      await db.ordoroBatchIssue.update({ where: { id: e.id }, data: { status: "fixed", resolvedAt: new Date(), resolvedBy: "Now matches" } });
    }
  }
  for (const n of notes) {
    const same = existing.find((e) => key(e) === key(n));
    if (same?.status === "reconciled") continue;
    const data = { orderName, orderId, shipmentId: n.shipmentId, kind: n.kind, blocking: ISSUE_KINDS[n.kind]?.blocking ?? false, detail: n.detail, tracking: n.tracking };
    if (same) await db.ordoroBatchIssue.update({ where: { id: same.id }, data: { ...data, status: "open", resolvedAt: null, resolvedBy: null } });
    else await db.ordoroBatchIssue.create({ data: { shop, batchId: batch.id, orderNumber: number, ...data } });
  }
}

// Pre-batches that gave orders up: logged; cancelled when nothing is left in them
async function tidyPreBatches(shop, batch, ids, user) {
  for (const id of ids) {
    const pre = await db.batch.findUnique({ where: { id } });
    if (!pre || pre.status === "cancelled") continue;
    const left = await db.shipment.count({ where: { batchId: id, state: { in: ["batched", "packed", "labeling", "shipped"] } } });
    if (left === 0) {
      await db.batch.update({ where: { id }, data: { status: "cancelled", cancelledAt: new Date() } });
      await logEvent(shop, { batchId: id, type: "batch_cancelled", detail: `${pre.tag} cancelled: all its orders moved to ${batch.tag} (Ordoro import)`, user });
    } else {
      await logEvent(shop, { batchId: id, type: "batch_removed", detail: `Orders moved from ${pre.tag} to ${batch.tag} (Ordoro import)`, user });
    }
  }
}

// ---------------------------------------------------------------------------
// Importing (a background job per shop)
// ---------------------------------------------------------------------------

const jobs = new Map(); // shop → { running, step, startedAt, startedBy, result, error }
export const importStatus = (shop) => jobs.get(shop) ?? null;

async function createBatch(shop, ob, user) {
  await getShippingSettings(shop);
  const { batchCounter } = await db.shippingSettings.update({ where: { shop }, data: { batchCounter: { increment: 1 } } });
  const last = await db.batch.findMany({ where: { shop, source: SOURCE }, select: { tag: true } });
  const seq = Math.max(0, ...last.map((b) => Number(b.tag.match(/(\d+)$/)?.[1] ?? 0))) + 1;
  return db.batch.create({
    data: {
      shop,
      number: batchCounter,
      tag: tagFor(seq),
      name: ob.notes ? String(ob.notes).slice(0, 80) : `Ordoro ${ob.ref}`,
      source: SOURCE,
      externalRef: ob.ref,
      externalInfo: JSON.stringify({ ref: ob.ref, orders: ob.orderNumbers.length, createdAt: ob.createdAt, importedAt: new Date().toISOString(), importedBy: user?.name ?? null }),
      createdBy: user?.name ?? null,
    },
  });
}

// One Ordoro batch: create it here (or refresh it), then each of its orders
export async function importBatch(shop, admin, ob, user, step = () => {}) {
  let batch = await db.batch.findFirst({ where: { shop, source: SOURCE, externalRef: ob.ref } });
  const fresh = !batch;
  if (fresh) batch = await createBatch(shop, ob, user);
  else if (batch.status === "cancelled") return { batch, skipped: true };
  const sOrders = await shopifyOrders(admin, [...new Set(ob.orderNumbers.map((n) => `#${orderDigits(n) ?? n}`))]);
  const movedFrom = new Set(); // pre-batches that gave up orders to this one
  let i = 0;
  for (const number of ob.orderNumbers) {
    i++;
    await step(`${batch.tag}: order ${i} of ${ob.orderNumbers.length}`);
    const o = await fetchOrdoroOrder(number);
    const sOrder = sOrders.get(`#${orderDigits(o?.parent ?? o?.number ?? number) ?? number}`.toLowerCase()) ?? null;
    const res = await applyOrder(shop, admin, batch, number, o, sOrder, user, movedFrom);
    await saveNotes(shop, batch, number, res);
    await sleep(testing() ? 0 : 130); // Ordoro allows 500 requests a minute
  }
  await tidyPreBatches(shop, batch, movedFrom, user);
  const info = json(batch.externalInfo, {});
  await db.batch.update({
    where: { id: batch.id },
    data: { externalInfo: JSON.stringify({ ...info, orders: ob.orderNumbers.length, refreshedAt: new Date().toISOString(), refreshedBy: user?.name ?? null }) },
  });
  await logEvent(shop, { batchId: batch.id, type: fresh ? "ordoro_batch_imported" : "ordoro_batch_refreshed", detail: `${batch.tag} ${fresh ? "imported from" : "refreshed from"} Ordoro batch ${ob.ref} (${ob.orderNumbers.length} orders)`, user });
  return { batch, fresh };
}

export function startImport(shop, user, { admin = null, refs = null } = {}) {
  if (!ordoroConfigured()) throw new OrdoroBatchError("Add ORDORO_API_KEY and ORDORO_API_SECRET in Railway first.");
  if (jobs.get(shop)?.running) throw new OrdoroBatchError("An import is already running.");
  const job = { running: true, step: "Reading Ordoro's batches", startedAt: new Date().toISOString(), startedBy: user?.name ?? null, refs, result: null, error: null };
  jobs.set(shop, job);
  const p = (async () => {
    try {
      const client = admin ?? (await unauthenticated.admin(shop)).admin;
      let list = await fetchActiveBatches();
      if (refs) list = list.filter((b) => refs.includes(b.ref));
      const result = { found: list.length, imported: 0, refreshed: 0, skipped: 0 };
      let n = 0;
      for (const ob of list) {
        n++;
        job.step = `Batch ${n} of ${list.length} (Ordoro ${ob.ref})`;
        const r = await importBatch(shop, client, ob, user, (t) => (job.step = `Batch ${n} of ${list.length}: ${t}`));
        if (r.skipped) result.skipped++;
        else if (r.fresh) result.imported++;
        else result.refreshed++;
      }
      job.result = result;
    } catch (e) {
      console.error(`[ordoro-batches] ${shop}:`, errorMessage(e));
      const msg = errorMessage(e);
      job.error =
        e instanceof OrdoroError || e instanceof OrdoroBatchError
          ? e.message
          : /\b401\b|Unauthorized/i.test(msg)
            ? "Shopify didn't accept MonkeyBean's connection. Reload the page and import again (batches already done are kept)."
            : msg;
    } finally {
      job.running = false;
      job.step = null;
      job.finishedAt = new Date().toISOString();
    }
  })();
  if (testing()) return p;
  return null;
}

// Ordoro's active batches, to choose from (no importing): newest first, with
// the MonkeyBean batch each one already became
export async function listRemoteBatches(shop) {
  if (!ordoroConfigured()) throw new OrdoroBatchError("Add ORDORO_API_KEY and ORDORO_API_SECRET in Railway first.");
  const [remote, here] = await Promise.all([
    fetchActiveBatches(),
    db.batch.findMany({ where: { shop, source: SOURCE }, select: { id: true, tag: true, externalRef: true, status: true } }),
  ]);
  const byRef = new Map(here.map((b) => [b.externalRef, b]));
  return remote
    .map((b) => ({ ref: b.ref, notes: b.notes, orders: b.orderNumbers.length, createdAt: b.createdAt, here: byRef.get(b.ref) ?? null }))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

// ---------------------------------------------------------------------------
// The lock, the list, and reconciling
// ---------------------------------------------------------------------------

// Open blocking problems per batch (only ones still about this batch: a
// shipment taken out of the batch no longer holds it)
async function blockingByBatch(shop, batchIds) {
  if (!batchIds.length) return new Map();
  const open = await db.ordoroBatchIssue.findMany({ where: { shop, batchId: { in: batchIds }, status: "open", blocking: true } });
  if (!open.length) return new Map();
  const ids = [...new Set(open.map((x) => x.shipmentId).filter(Boolean))];
  const where = new Map((await db.shipment.findMany({ where: { id: { in: ids } }, select: { id: true, batchId: true, state: true } })).map((s) => [s.id, s]));
  const out = new Map();
  for (const x of open) {
    const s = x.shipmentId ? where.get(x.shipmentId) : null;
    if (x.shipmentId && (!s || s.batchId !== x.batchId)) continue; // taken out of the batch
    if (s && SHIPPED.includes(s.state)) continue; // Shopify has caught up (next refresh marks it fixed)
    out.set(x.batchId, (out.get(x.batchId) ?? 0) + 1);
  }
  return out;
}

const lockText = (tag, n) => `${tag} is on hold: ${n} order${n === 1 ? "" : "s"} shipped in Ordoro but not in Shopify. Reconcile ${n === 1 ? "it" : "them"} on the batch first.`;

// For batchLocks / the action guard: why an Ordoro batch can't be worked, or null
export async function ordoroLocks(shop, batches) {
  const mine = batches.filter((b) => b.source === SOURCE);
  const counts = await blockingByBatch(shop, mine.map((b) => b.id));
  return new Map(mine.filter((b) => counts.get(b.id)).map((b) => [b.id, lockText(b.tag, counts.get(b.id))]));
}

export async function ordoroBlock(shop, batchId) {
  const b = await db.batch.findFirst({ where: { shop, id: Number(batchId) }, select: { id: true, tag: true, source: true } });
  if (!b || b.source !== SOURCE) return null;
  return (await ordoroLocks(shop, [b])).get(b.id) ?? null;
}

const viewIssue = (x) => ({
  id: x.id,
  orderNumber: x.orderNumber,
  orderName: x.orderName,
  orderId: x.orderId,
  shipmentId: x.shipmentId,
  kind: x.kind,
  label: ISSUE_KINDS[x.kind]?.label ?? x.kind,
  blocking: x.blocking,
  detail: x.detail,
  tracking: x.tracking,
  status: x.status,
  note: x.note,
  resolvedBy: x.resolvedBy,
  resolvedAt: x.resolvedAt?.toISOString() ?? null,
});

// Everything about one Ordoro batch for its page
export async function ordoroBatchInfo(shop, batch) {
  if (batch?.source !== SOURCE) return null;
  const [issues, counts] = await Promise.all([
    db.ordoroBatchIssue.findMany({ where: { shop, batchId: batch.id }, orderBy: [{ blocking: "desc" }, { id: "asc" }] }),
    blockingByBatch(shop, [batch.id]),
  ]);
  const info = json(batch.externalInfo, {});
  return {
    ref: batch.externalRef,
    info,
    locked: counts.get(batch.id) ? lockText(batch.tag, counts.get(batch.id)) : null,
    issues: issues.map(viewIssue),
  };
}

// The Ordoro tab: the imported batches with their counts and locks
// onlyFor: a staff member id ("Only their assigned batches"): just theirs
export async function listOrdoroBatches(shop, { onlyFor = null } = {}) {
  let batches = await db.batch.findMany({ where: { shop, source: SOURCE }, orderBy: { number: "desc" }, take: 500 });
  if (onlyFor != null) batches = batches.filter((b) => json(b.assignees, []).some((a) => a.id === Number(onlyFor)));
  const ids = batches.map((b) => b.id);
  const [byState, issues, locks] = await Promise.all([
    ids.length ? db.shipment.groupBy({ by: ["batchId", "state"], where: { batchId: { in: ids } }, _count: { _all: true } }) : [],
    ids.length ? db.ordoroBatchIssue.groupBy({ by: ["batchId", "blocking"], where: { batchId: { in: ids }, status: "open" }, _count: { _all: true } }) : [],
    blockingByBatch(shop, ids),
  ]);
  return batches.map((b) => {
    const st = byState.filter((r) => r.batchId === b.id);
    const n = (states) => st.filter((r) => states.includes(r.state)).reduce((t, r) => t + r._count._all, 0);
    const info = json(b.externalInfo, {});
    return {
      id: b.id,
      tag: b.tag,
      name: b.name,
      ref: b.externalRef,
      status: b.status,
      priority: b.priority ?? 1,
      assignees: json(b.assignees, []),
      orders: info.orders ?? null,
      importedAt: info.importedAt ?? null,
      refreshedAt: info.refreshedAt ?? null,
      shipments: st.reduce((t, r) => t + r._count._all, 0),
      shipped: n(SHIPPED),
      toDo: n(["batched", "ready", "waiting"]),
      packed: n(["packed", "labeling"]),
      blocking: locks.get(b.id) ?? 0,
      notes: issues.filter((r) => r.batchId === b.id && !r.blocking).reduce((t, r) => t + r._count._all, 0),
    };
  });
}

// Checks one problem again: Shopify and Ordoro as they are now
export async function recheckIssue(shop, admin, issueId, user) {
  const x = await db.ordoroBatchIssue.findFirst({ where: { shop, id: Number(issueId) } });
  if (!x) throw new OrdoroBatchError("That problem isn't there any more.");
  const batch = await db.batch.findUnique({ where: { id: x.batchId } });
  const o = await fetchOrdoroOrder(x.orderNumber);
  const name = `#${orderDigits(o?.parent ?? o?.number ?? x.orderNumber) ?? x.orderNumber}`;
  const sOrder = (await shopifyOrders(admin, [name])).get(name.toLowerCase()) ?? null;
  const movedFrom = new Set();
  const res = await applyOrder(shop, admin, batch, x.orderNumber, o, sOrder, user, movedFrom);
  await saveNotes(shop, batch, x.orderNumber, res);
  await tidyPreBatches(shop, batch, movedFrom, user);
  const after = await db.ordoroBatchIssue.findUnique({ where: { id: x.id } });
  return { status: after?.status ?? "fixed", detail: after?.detail ?? null };
}

// Reconciled by hand (e.g. the parcel really went, and Shopify has been
// fulfilled another way, or it never shipped): a note says what was done
export async function reconcileIssue(shop, issueId, note, user) {
  const text = String(note ?? "").trim();
  if (text.length < 5) throw new OrdoroBatchError("Say what was done to reconcile it (a few words at least).");
  const x = await db.ordoroBatchIssue.findFirst({ where: { shop, id: Number(issueId) } });
  if (!x) throw new OrdoroBatchError("That problem isn't there any more.");
  await db.ordoroBatchIssue.update({ where: { id: x.id }, data: { status: "reconciled", note: text, resolvedBy: user?.name ?? null, resolvedAt: new Date() } });
  await logEvent(shop, { batchId: x.batchId, orderName: x.orderName, type: "ordoro_reconciled", detail: `${x.orderName ?? x.orderNumber}: ${ISSUE_KINDS[x.kind]?.label ?? x.kind}, reconciled: ${text}`, user });
  return { ok: true };
}

export async function reopenIssue(shop, issueId, user) {
  const x = await db.ordoroBatchIssue.findFirst({ where: { shop, id: Number(issueId) } });
  if (!x) throw new OrdoroBatchError("That problem isn't there any more.");
  await db.ordoroBatchIssue.update({ where: { id: x.id }, data: { status: "open", resolvedAt: null, resolvedBy: null } });
  await logEvent(shop, { batchId: x.batchId, orderName: x.orderName, type: "ordoro_reopened", detail: `${x.orderName ?? x.orderNumber}: reopened`, user });
  return { ok: true };
}
