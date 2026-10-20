import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import { getSyncStatus } from "../inventory-sync.server";
import { itemName } from "../inventory-history.server";

// Raw records from the app's database, for checking what has been loaded.
// Needs the "Debug" permission.

const STORE_TZ = "America/Los_Angeles";

// Dates become ISO strings so they survive the trip to the browser
const plain = (row) =>
  row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])) : null;

async function withName(shop, row) {
  if (!row) return null;
  const n = row.inventoryItemId ? await itemName(shop, row.inventoryItemId) : null;
  return { name: n?.name ?? null, row: plain(row) };
}

export const loader = async ({ request }) => {
  const { session, noAccess } = await loadWithAccess(request, "debug", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const where = { shop };

  const [oldest, newest, lastSaved, oldestEvent, newestEvent, events, undos, sync, status] = await Promise.all([
    db.inventoryAdjustment.findFirst({ where, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] }),
    db.inventoryAdjustment.findFirst({ where, orderBy: [{ occurredAt: "desc" }, { id: "desc" }] }),
    db.inventoryAdjustment.findFirst({ where, orderBy: { id: "desc" } }),
    db.inventoryEvent.findFirst({ where, orderBy: { occurredAt: "asc" } }),
    db.inventoryEvent.findFirst({ where, orderBy: { occurredAt: "desc" } }),
    db.inventoryEvent.groupBy({ by: ["detailsStatus"], where, _count: { _all: true } }),
    db.inventoryUndo.groupBy({ by: ["status"], where, _count: { _all: true } }),
    db.inventorySync.findUnique({ where: { shop } }),
    getSyncStatus(shop),
  ]);

  const syncRow = plain(sync);
  if (syncRow?.backfillPlan) syncRow.backfillPlan = `${JSON.parse(syncRow.backfillPlan).length} months planned`;

  return {
    records: [
      { title: "Oldest change", note: "Earliest time of change stored", ...(await withName(shop, oldest)) },
      { title: "Newest change", note: "Latest time of change stored", ...(await withName(shop, newest)) },
      { title: "Last saved", note: "Most recently written to the database", ...(await withName(shop, lastSaved)) },
    ],
    events: [
      { title: "Oldest notification", note: "Earliest live notification from Shopify", ...(await withName(shop, oldestEvent)) },
      { title: "Newest notification", note: "Latest live notification from Shopify", ...(await withName(shop, newestEvent)) },
    ],
    counts: {
      changes: status.stored,
      notifications: Object.fromEntries(events.map((e) => [e.detailsStatus, e._count._all])),
      undos: Object.fromEntries(undos.map((u) => [u.status, u._count._all])),
      dbSizeMb: status.dbSizeMb,
    },
    sync: syncRow,
  };
};

// ---------------------------------------------------------------------------

const cell = { padding: "6px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top" };
const muted = { color: "#616161" };
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px", wordBreak: "break-all" };
const box = { border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "hidden" };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "14px" };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const storeTime = (iso) =>
  new Date(iso).toLocaleString("en-US", { timeZone: STORE_TZ, dateStyle: "medium", timeStyle: "medium" });

function Value({ v }) {
  if (v === null || v === undefined) return <span style={muted}>null</span>;
  if (typeof v === "string" && ISO.test(v)) {
    return (
      <>
        <div>{storeTime(v)} (Pacific)</div>
        <div style={{ ...mono, ...muted }}>{v}</div>
      </>
    );
  }
  return <span style={mono}>{String(v)}</span>;
}

function RecordTable({ row }) {
  return (
    <div style={box}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
        <tbody>
          {Object.entries(row).map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...cell, ...muted, whiteSpace: "nowrap", width: "1%" }}>{k}</td>
              <td style={cell}>
                <Value v={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordCard({ title, note, name, row }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ ...muted, fontSize: "12px", marginBottom: "6px" }}>
        {note}
        {name ? ` · ${name}` : ""}
      </div>
      {row ? <RecordTable row={row} /> : <s-paragraph>No records yet.</s-paragraph>}
    </div>
  );
}

const countText = (obj) =>
  Object.keys(obj).length ? Object.entries(obj).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(", ") : "none";

export default function Debug() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Debug" />;
  const { records, events, counts, sync } = data;

  return (
    <s-page heading="Debug">
      <s-section heading="Totals">
        <s-paragraph>
          {counts.changes.toLocaleString()} stock change rows · Notifications: {countText(counts.notifications)} · Undos:{" "}
          {countText(counts.undos)}
          {counts.dbSizeMb != null && ` · Database ${counts.dbSizeMb.toLocaleString()} MB`}
        </s-paragraph>
      </s-section>

      <s-section heading="Stock change records">
        <div style={grid}>
          {records.map((r) => (
            <RecordCard key={r.title} {...r} />
          ))}
        </div>
      </s-section>

      <s-section heading="Live notifications">
        <div style={grid}>
          {events.map((r) => (
            <RecordCard key={r.title} {...r} />
          ))}
        </div>
      </s-section>

      <s-section heading="History sync state">
        {sync ? <RecordTable row={sync} /> : <s-paragraph>The sync hasn't started yet.</s-paragraph>}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
