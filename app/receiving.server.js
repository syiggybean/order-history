import db from "./db.server";
import { PoError, STATUS_LABELS, getPo, viewPo } from "./po.server";

// ---------------------------------------------------------------------------
// Receiving: staff check in what arrived against a purchase order.
//
// For now this only records counts: it never changes stock in Shopify, and it doesn't
// change the PO's own "received" numbers or status (those still come from the PO's
// Receive step). How check-ins should affect inventory is still to be decided.
// ---------------------------------------------------------------------------

const MAX_UNITS = 100000;
const json = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

// How far along a PO's check-in is
export function checkStatus(lines) {
  const ordered = lines.reduce((t, l) => t + l.quantity, 0);
  const checked = lines.reduce((t, l) => t + (l.checkedIn ?? 0), 0);
  const over = lines.some((l) => (l.checkedIn ?? 0) > l.quantity);
  const short = lines.some((l) => (l.checkedIn ?? 0) < l.quantity);
  const key = !checked ? "none" : over && !short ? "over" : !short ? "complete" : over ? "mixed" : "partial";
  return { key, ordered, checked };
}
export const CHECK_LABELS = {
  none: "Not checked in",
  partial: "Partly checked in",
  complete: "All checked in",
  over: "More than ordered",
  mixed: "Some short, some over",
};

const OPEN = ["pending", "open", "partial", "received"];

// The POs to check in. show: todo (not fully checked in) | done | all
export async function receivingList(shop, { show = "todo", q = "" } = {}) {
  const text = String(q ?? "").trim();
  const pos = await db.purchaseOrder.findMany({
    where: {
      shop,
      ...(show === "all" ? {} : { status: { in: OPEN } }),
      ...(text ? { OR: [{ poNumber: { contains: text, mode: "insensitive" } }, { supplierName: { contains: text, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ expectedAt: { sort: "asc", nulls: "last" } }, { number: "desc" }],
    take: 300,
  });
  const ids = pos.map((p) => p.id);
  const lines = ids.length ? await db.purchaseOrderLine.findMany({ where: { poId: { in: ids } }, select: { poId: true, quantity: true, checkedIn: true } }) : [];
  const last = ids.length
    ? await db.poCheckIn.groupBy({ by: ["poId"], where: { shop, poId: { in: ids }, undoneAt: null }, _max: { createdAt: true }, _count: { _all: true } })
    : [];
  const lastBy = new Map(last.map((l) => [l.poId, l]));
  const rows = pos.map((p) => {
    const ls = lines.filter((l) => l.poId === p.id);
    const st = checkStatus(ls);
    return {
      ...viewPo(p),
      statusLabel: STATUS_LABELS[p.status],
      lineCount: ls.length,
      check: { ...st, label: CHECK_LABELS[st.key] },
      checkIns: lastBy.get(p.id)?._count._all ?? 0,
      lastCheckIn: lastBy.get(p.id)?._max.createdAt?.toISOString() ?? null,
    };
  });
  const isDone = (r) => r.check.key === "complete" || r.check.key === "over";
  return { rows: show === "todo" ? rows.filter((r) => !isDone(r)) : show === "done" ? rows.filter(isDone) : rows, show, q: text };
}

const checkInView = (c, titles) => ({
  id: c.id,
  by: c.by,
  at: c.createdAt.toISOString(),
  units: c.units,
  note: c.note,
  lines: json(c.lines, []).map((l) => ({ ...l, title: titles.get(l.lineId) ?? "Removed line" })),
  unknown: json(c.unknown, []),
  undone: c.undoneAt ? { at: c.undoneAt.toISOString(), by: c.undoneBy } : null,
});

export async function receivingDetail(shop, poId) {
  const po = await getPo(shop, poId);
  const [lines, checkIns] = await Promise.all([
    db.purchaseOrderLine.findMany({ where: { poId: po.id }, orderBy: { position: "asc" } }),
    db.poCheckIn.findMany({ where: { shop, poId: po.id }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const titles = new Map(lines.map((l) => [l.id, l.title]));
  const view = viewPo(po, lines);
  const st = checkStatus(lines);
  return {
    po: { ...view, statusLabel: STATUS_LABELS[po.status], lines: view.lines.map((l, i) => ({ ...l, checkedIn: lines[i].checkedIn })) },
    check: { ...st, label: CHECK_LABELS[st.key] },
    checkIns: checkIns.map((c) => checkInView(c, titles)),
  };
}

// counts: { [lineId]: units counted now }; unknown: [{ code, count }] scanned but not on the PO
export async function saveCheckIn(shop, poId, { counts = {}, unknown = [], note = "" }, user) {
  const po = await getPo(shop, poId);
  if (po.status === "closed") throw new PoError("This PO is closed. Reopen it on the Purchase orders page to check items in.");
  const lines = await db.purchaseOrderLine.findMany({ where: { poId: po.id } });
  const byId = new Map(lines.map((l) => [l.id, l]));
  const todo = [];
  for (const [lineId, raw] of Object.entries(counts ?? {})) {
    if (raw === "" || raw === null || raw === undefined) continue;
    const n = Number(raw);
    const l = byId.get(Number(lineId));
    if (!l) throw new PoError("A line on this PO couldn't be found. Reload and try again.");
    if (!Number.isInteger(n) || n < 0 || n > MAX_UNITS) throw new PoError(`${l.title}: enter a whole number of units.`);
    if (n > 0) todo.push({ lineId: l.id, qty: n });
  }
  const extra = (Array.isArray(unknown) ? unknown : [])
    .map((u) => ({ code: String(u?.code ?? "").trim().slice(0, 80), count: Math.max(1, Math.min(MAX_UNITS, Math.round(Number(u?.count) || 1))) }))
    .filter((u) => u.code)
    .slice(0, 100);
  const text = String(note ?? "").trim().slice(0, 2000) || null;
  if (!todo.length && !extra.length) throw new PoError("Count at least one item first.");
  const units = todo.reduce((t, x) => t + x.qty, 0);
  const checkIn = await db.$transaction(async (tx) => {
    for (const x of todo) await tx.purchaseOrderLine.update({ where: { id: x.lineId }, data: { checkedIn: { increment: x.qty } } });
    const c = await tx.poCheckIn.create({
      data: { shop, poId: po.id, lines: JSON.stringify(todo), units, unknown: extra.length ? JSON.stringify(extra) : null, note: text, by: user?.name ?? null },
    });
    await tx.purchaseOrderEvent.create({
      data: {
        shop,
        poId: po.id,
        type: "checkedIn",
        detail: `${units} unit${units === 1 ? "" : "s"}${extra.length ? `, plus ${extra.reduce((t, u) => t + u.count, 0)} scanned that aren't on the PO` : ""}`,
        by: user?.name ?? null,
      },
    });
    return c;
  });
  // Over what was ordered: worth saying straight away
  const after = await db.purchaseOrderLine.findMany({ where: { poId: po.id } });
  const over = after.filter((l) => todo.some((x) => x.lineId === l.id) && l.checkedIn > l.quantity).map((l) => ({ title: l.title, extra: l.checkedIn - l.quantity }));
  const st = checkStatus(after);
  return { checkInId: checkIn.id, units, unknown: extra.length, over, check: { ...st, label: CHECK_LABELS[st.key] } };
}

// Takes a check-in back (a miscount): only the person who made it, or an admin
export async function undoCheckIn(shop, checkInId, user) {
  const c = await db.poCheckIn.findFirst({ where: { shop, id: Number(checkInId) } });
  if (!c) throw new PoError("That check-in couldn't be found.");
  if (c.undoneAt) throw new PoError("That check-in was already undone.");
  if (c.by && user?.name && c.by !== user.name && !user.isAdmin && !user.isOwner) throw new PoError("Only the person who checked these in (or an admin) can undo it.");
  const lines = json(c.lines, []);
  await db.$transaction(async (tx) => {
    for (const x of lines) {
      const l = await tx.purchaseOrderLine.findUnique({ where: { id: x.lineId } });
      if (l) await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { checkedIn: Math.max(0, l.checkedIn - x.qty) } });
    }
    await tx.poCheckIn.update({ where: { id: c.id }, data: { undoneAt: new Date(), undoneBy: user?.name ?? null } });
    await tx.purchaseOrderEvent.create({ data: { shop, poId: c.poId, type: "checkInUndone", detail: `${c.units} unit${c.units === 1 ? "" : "s"} taken back off`, by: user?.name ?? null } });
  });
  return { undone: c.id };
}
