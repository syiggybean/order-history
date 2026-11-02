import { Fragment, useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { ProductLink, QuickView } from "../components/QuickView";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { PERIODS, getReport, periodRange, startReport } from "../analytics.server";
import { REPORTS, getSavedReport, startSavedReport } from "../reports.server";
import { GROUPS, ROWS_VERSION, RULES, SORTS, buildGroups, relevant, sortGroups, toCsv } from "../analytics-logic";

// Reporting
//   Dashboard: sales, profit and stock (starting count, sold, ending count) by
//              category, publisher, supplier or item, with carry more / less suggestions
//   Reports:   lists for the team to work through (archived products with a future
//              release date, for now)
// Permission: "Reporting" (stored as "analytics").

const TABS = { dashboard: "Dashboard", reports: "Reports" };

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "analytics", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const params = new URL(request.url).searchParams;
  const tab = TABS[params.get("tab")] ? params.get("tab") : "dashboard";
  const handle = shop.replace(/\.myshopify\.com$/, "");
  const base = {
    tab,
    shopAdmin: `https://admin.shopify.com/store/${handle}`,
    canRefresh: can(user, "analytics", "view"),
    canEditDates: can(user, "preorders", "manage") || can(user, "releaseReview", "manage"),
  };

  if (tab === "reports") {
    const id = REPORTS[params.get("report")] ? params.get("report") : Object.keys(REPORTS)[0];
    let saved = await getSavedReport(shop, id);
    if (!saved) {
      await startSavedReport(shop, id);
      saved = await getSavedReport(shop, id);
    }
    return { ...base, reports: Object.entries(REPORTS).map(([key, r]) => ({ id: key, ...r })), reportId: id, saved };
  }

  const period = periodRange(params.get("period") ?? "90d");
  let report = await getReport(shop, period.key);
  // First visit for this period, or a snapshot from before the dashboard changed: build it
  if (!report || (report.status !== "running" && report.totals?.version !== ROWS_VERSION)) {
    await startReport(shop, period.key);
    report = await getReport(shop, period.key);
  }
  return {
    ...base,
    period,
    periods: Object.entries(PERIODS).map(([value, p]) => ({ value, label: p.label })),
    report,
  };
};

export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  if (!can(user, "analytics", "view")) return denied("analytics", "view");
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "refresh") {
      const period = await startReport(session.shop, String(form.get("period") ?? "90d"));
      return { intent, ok: true, period: period.key };
    }
    if (intent === "runReport") {
      await startSavedReport(session.shop, String(form.get("report") ?? ""));
      return { intent, ok: true };
    }
  } catch (e) {
    return { intent, error: errorMessage(e) };
  }
  return { error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "7px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top", fontSize: "13px" };
const num = { ...cell, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
// Headings may wrap onto two lines so the table fits without scrolling sideways
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", verticalAlign: "bottom", lineHeight: 1.25, position: "sticky", top: 0, zIndex: 1, cursor: "pointer", userSelect: "none" };
const muted = { color: "#616161", fontSize: "12px" };
const input = { padding: "5px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit", fontSize: "13px", background: "#fff" };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", textAlign: "left" };

const money = (n) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const pctText = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const count = (n) => (n === null || n === undefined ? "—" : n.toLocaleString());
const signed = (n) => (n === null || n === undefined ? "—" : n > 0 ? `+${n.toLocaleString()}` : n < 0 ? `−${Math.abs(n).toLocaleString()}` : "0");
const weeks = (w) => (w === null ? "—" : w === Infinity ? "∞" : w < 1 ? "<1" : Math.round(w).toLocaleString());
const fmtDay = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
const ago = (iso) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"} ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const REC = {
  more: ["Carry more", "#e3f1df", "#1a5e20"],
  less: ["Carry less", "#fde7e9", "#8e1f0b"],
  keep: ["Keep", "#f1f1f1", "#4a4a4a"],
  new: ["Too new", "#eaf4ff", "#1c4a9c"],
  none: ["—", "transparent", "#616161"],
};
function RecPill({ rec }) {
  const [label, bg, fg] = REC[rec.action] ?? REC.none;
  return (
    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function Bar({ value }) {
  if (value === null || value === undefined) return <span style={muted}>—</span>;
  const v = Math.max(0, Math.min(1, value));
  const color = value >= 0.7 ? "#29845a" : value >= 0.4 ? "#c48a00" : "#c43c3c";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", justifyContent: "flex-end" }}>
      <span style={{ width: "40px", height: "6px", background: "#ececec", borderRadius: "3px", overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", height: "100%", width: `${v * 100}%`, background: color }} />
      </span>
      <span style={{ minWidth: "34px", textAlign: "right" }}>{pctText(value)}</span>
    </span>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div style={{ flex: "1 1 150px", padding: "10px 12px", border: "1px solid #e3e3e3", borderRadius: "10px", background: "#fff" }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 650, marginTop: "2px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ ...muted, marginTop: "2px" }}>{sub}</div>}
    </div>
  );
}

export default function Reporting() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Reporting" />;
  return <Page />;
}

function Page() {
  const data = useLoaderData();
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const [quickView, setQuickView] = useState(null);
  const goTab = (tab) => {
    const next = new URLSearchParams(params);
    next.set("tab", tab);
    if (tab === "dashboard") next.delete("report");
    setParams(next);
  };
  return (
    <s-page heading="Reporting" inlineSize="large">
      <div role="tablist" aria-label="Reporting" style={{ display: "flex", gap: "4px", borderBottom: "1px solid #e3e3e3", marginBottom: "14px" }}>
        {Object.entries(TABS).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={data.tab === id}
            onClick={() => goTab(id)}
            style={{
              appearance: "none",
              border: 0,
              borderBottom: `3px solid ${data.tab === id ? "#303030" : "transparent"}`,
              background: "none",
              padding: "10px 14px",
              font: "inherit",
              fontWeight: data.tab === id ? 700 : 500,
              color: data.tab === id ? "#1a1a1a" : "#616161",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {data.tab === "reports" ? <Reports onOpen={setQuickView} /> : <Dashboard onOpen={setQuickView} />}
      {quickView && <QuickView productId={quickView} canEdit={data.canEditDates} onClose={() => setQuickView(null)} onSaved={() => revalidator.revalidate()} />}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

// The stock columns read as a sum: starting + added − sold = ending
const COLUMNS = [
  { key: "starting", label: "Starting", op: null, title: "On hand (all locations) when the period started" },
  { key: "added", label: "Added", op: "+", title: "Came in during the period: received, returned or adjusted (ending − starting + sold). Negative means stock was taken out." },
  { key: "sold", label: "Sold", op: "−", title: "Net units sold in the period (after returns)" },
  { key: "ending", label: "Ending", op: "=", title: "On hand (all locations) when the period ended" },
  { key: "sellThrough", label: "Sell-through", title: "Sold ÷ (sold + ending count)" },
  { key: "netSales", label: "Net sales" },
  { key: "profit", label: "Gross profit", title: "Net sales minus cost, for items with a cost set" },
  { key: "margin", label: "Margin", title: "Gross profit ÷ net sales, for items with a cost set" },
  { key: "weeksLeft", label: "Weeks of stock", title: "Ending count ÷ weekly sales in the period" },
];

function Dashboard({ onOpen }) {
  const { period, periods, report, shopAdmin, canRefresh } = useLoaderData();
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const refresher = useFetcher();
  const [by, setBy] = useState(GROUPS[params.get("by")] ? params.get("by") : "category");
  const [sort, setSort] = useState({ key: "best", dir: null });
  const [search, setSearch] = useState("");
  const [show, setShow] = useState("all");
  const [open, setOpen] = useState(null);
  const [custom, setCustom] = useState({ from: period.from, to: period.to });
  const [rulesOpen, setRulesOpen] = useState(false);

  const running = report?.status === "running" || refresher.state !== "idle";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  useEffect(() => setOpen(null), [by, period.key]);

  const rows = report?.rows ?? [];
  const groups = useMemo(() => buildGroups(rows, { by, days: period.days, endDay: period.to }), [rows, by, period.days, period.to]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = groups;
    if (q) list = list.filter((g) => String(g.name).toLowerCase().includes(q) || g.items.some((i) => String(i.title).toLowerCase().includes(q) || String(i.sku ?? "").toLowerCase().includes(q)));
    if (show === "more") list = list.filter((g) => g.rec.action === "more" || (by !== "item" && g.more > 0));
    if (show === "less") list = list.filter((g) => g.rec.action === "less" || (by !== "item" && g.less > 0));
    list = relevant(list, sort.key);
    return sortGroups(list, sort.key, sort.dir);
  }, [groups, search, show, sort, by]);

  const t = report?.totals;
  const costCoverage = t && t.netSales > 0 ? t.costedSales / t.netSales : null;

  const clickHead = (key) =>
    setSort((s) => {
      const current = SORTS[s.key]?.key ?? s.key;
      const currentDir = s.dir ?? SORTS[s.key]?.dir ?? -1;
      return { key, dir: current === key ? -currentDir : -1 };
    });
  const activeKey = SORTS[sort.key]?.key ?? sort.key;
  const activeDir = sort.dir ?? SORTS[sort.key]?.dir ?? -1;

  const download = () => {
    const csv = toCsv(shown, by);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `dashboard-${GROUPS[by].label.toLowerCase().replace(/[^a-z]+/g, "-")}-${period.from}-to-${period.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const goPeriod = (key) => {
    const next = new URLSearchParams(params);
    next.set("period", key);
    setParams(next);
  };

  return (
    <>
      <s-section>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
          <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
            <span style={muted}>Period</span>
            <select value={periods.some((p) => p.value === period.key) ? period.key : "custom"} onChange={(e) => e.target.value !== "custom" && goPeriod(e.target.value)} style={input}>
              {periods.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom dates…</option>
            </select>
          </label>
          <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
            <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={input} aria-label="From" />
            <span style={muted}>to</span>
            <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} style={input} aria-label="To" />
            <s-button variant="tertiary" onClick={() => custom.from && custom.to && custom.from <= custom.to && goPeriod(`${custom.from}..${custom.to}`)}>
              Apply
            </s-button>
          </span>
          <span style={{ flex: 1 }} />
          <span style={muted}>
            {report?.builtAt ? `Updated ${ago(report.builtAt)}` : ""}
            {running ? ` · ${report?.step ?? "Working"}…` : ""}
          </span>
          {canRefresh && (
            <s-button onClick={() => refresher.submit({ intent: "refresh", period: period.key }, { method: "post" })} {...(running ? { loading: true } : {})}>
              Refresh
            </s-button>
          )}
        </div>
        <div style={{ ...muted, marginTop: "6px" }}>
          {period.label} ({period.from} to {period.to}, {period.days} days)
        </div>
        {report?.status === "failed" && (
          <div style={{ marginTop: "8px" }}>
            <s-banner tone="critical" heading="The dashboard couldn't be built">
              <s-paragraph>{report.error}</s-paragraph>
            </s-banner>
          </div>
        )}
        {t && t.version === ROWS_VERSION && !t.historyComplete && (
          <div style={{ marginTop: "8px" }}>
            <s-banner tone="warning" heading="Starting counts may be off">
              <s-paragraph>
                The app is still loading Shopify's stock history
                {t.historyFrom ? ` (complete back to ${fmtDay(t.historyFrom)})` : ""}, and this period starts before that. Ending counts are right; starting counts will be
                once the history has loaded (see Inventory history). Refresh then.
              </s-paragraph>
            </s-banner>
          </div>
        )}
        {refresher.data?.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{refresher.data.error}</div>}
      </s-section>

      {!rows.length && running && (
        <s-section>
          <s-paragraph>
            Building the dashboard: reading your catalog, stock history and Shopify's sales report. This usually takes a minute or two. This page updates by itself.
          </s-paragraph>
        </s-section>
      )}

      {rows.length > 0 && t && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "12px" }}>
            <StockFlow rows={rows} period={period} />
            <Tile label="Net sales" value={money(t.netSales)} />
            <Tile label="Gross profit" value={money(t.profit)} sub={t.costedSales > 0 ? `${pctText(t.profit / t.costedSales)} margin` : "No costs set"} />
            <Tile
              label="Sales with a cost set"
              value={pctText(costCoverage)}
              sub={costCoverage !== null && costCoverage < 0.9 ? "Profit only covers these; set costs in Shopify for the rest" : "Profit covers these"}
            />
          </div>

          <s-section>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "10px" }}>
              <span style={{ display: "inline-flex", border: "1px solid #c9c9c9", borderRadius: "8px", overflow: "hidden" }} role="tablist" aria-label="Group by">
                {Object.entries(GROUPS).map(([k, g]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={by === k}
                    onClick={() => setBy(k)}
                    style={{ appearance: "none", border: 0, borderRight: "1px solid #e3e3e3", padding: "6px 12px", font: "inherit", fontSize: "13px", cursor: "pointer", background: by === k ? "#303030" : "#fff", color: by === k ? "#fff" : "#303030" }}
                  >
                    {g.label}
                  </button>
                ))}
              </span>
              <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                <span style={muted}>Sort</span>
                <select value={SORTS[sort.key] && sort.dir === null ? sort.key : ""} onChange={(e) => e.target.value && setSort({ key: e.target.value, dir: null })} style={input}>
                  {!(SORTS[sort.key] && sort.dir === null) && <option value="">By column</option>}
                  {Object.entries(SORTS).map(([k, s]) => (
                    <option key={k} value={k}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                <span style={muted}>Show</span>
                <select value={show} onChange={(e) => setShow(e.target.value)} style={input}>
                  <option value="all">Everything</option>
                  <option value="more">Carry more</option>
                  <option value="less">Carry less</option>
                </select>
              </label>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names, titles or SKUs" style={{ ...input, minWidth: "220px" }} aria-label="Search" />
              <span style={{ flex: 1 }} />
              <span style={muted}>
                {shown.length.toLocaleString()} {by === "item" ? "items" : "groups"}
              </span>
              <s-button variant="tertiary" onClick={download}>
                Export CSV
              </s-button>
            </div>

            <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto", maxHeight: "70vh" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={head} onClick={() => clickHead("name")}>
                      {GROUPS[by].label}
                      {activeKey === "name" ? (activeDir > 0 ? " ▲" : " ▼") : ""}
                    </th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} style={{ ...head, textAlign: "right", ...(c.op ? { paddingLeft: "4px" } : {}) }} title={c.title} onClick={() => clickHead(c.key)} aria-sort={activeKey === c.key ? (activeDir > 0 ? "ascending" : "descending") : "none"}>
                        <ColLabel c={c} />
                        {activeKey === c.key ? (activeDir > 0 ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                    <th style={{ ...head, cursor: "default" }}>Suggestion</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 1000).map((g) => (
                    <Fragment key={g.key}>
                      <Row g={g} by={by} shopAdmin={shopAdmin} onOpen={onOpen} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />
                      {by !== "item" && open === g.key && (
                        <tr>
                          <td colSpan={COLUMNS.length + 2} style={{ ...cell, background: "#fafafa", padding: "8px 10px 12px 28px" }}>
                            <ItemTable items={sortGroups(g.items, sort.key, sort.dir)} shopAdmin={shopAdmin} onOpen={onOpen} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {shown.length > 1000 && <div style={{ ...muted, padding: "8px 10px" }}>Showing the first 1,000. Search or export CSV to see the rest.</div>}
              {!shown.length && <div style={{ ...muted, padding: "12px" }}>Nothing matches.</div>}
            </div>

            <div style={{ marginTop: "10px" }}>
              <button type="button" style={linkBtn} onClick={() => setRulesOpen(!rulesOpen)} aria-expanded={rulesOpen}>
                {rulesOpen ? "Hide" : "How"} the numbers and suggestions work
              </button>
              {rulesOpen && (
                <ul style={{ ...muted, fontSize: "13px", lineHeight: 1.6, marginTop: "6px", paddingLeft: "18px" }}>
                  <li>
                    <strong>Category</strong> is the product's category in Shopify (the Category field on the product page).
                  </li>
                  <li>
                    <strong>Stock reads as a sum: starting + added − sold = ending.</strong> Starting and ending are stock on hand across all locations at the start and
                    end of the period, worked back from today's count through Shopify's stock history. Added is whatever else changed it: stock received, returns and
                    adjustments (a negative number means stock was taken out).
                  </li>
                  <li>
                    <strong>Sold, net sales, cost and profit</strong> come from Shopify's sales report (net of returns). Profit and margin only count sales of items with a
                    cost set in Shopify.
                  </li>
                  <li>
                    <strong>Sell-through</strong> is sold ÷ (sold + ending count): of the stock it had, how much sold.
                  </li>
                  <li>
                    <strong>Carry more</strong>: sold at least {pctText(RULES.moreSellThrough)} of its stock, with under {RULES.moreWeeksLeft} weeks left (or sold out), and
                    at least {pctText(RULES.moreMinMargin)} margin when cost is known.
                  </li>
                  <li>
                    <strong>Carry less</strong>: sold under {pctText(RULES.lessSellThrough)} of its stock with {RULES.lessMinOnHand}+ left, or over {RULES.lessWeeksLeft}{" "}
                    weeks of stock at the current pace, or under {pctText(RULES.lessMaxMargin)} margin.
                  </li>
                  <li>
                    <strong>Too new</strong>: added in the last {RULES.newDays} days, or fewer than {RULES.minUnits} units to go on.
                  </li>
                </ul>
              )}
            </div>
          </s-section>
        </>
      )}
    </>
  );
}

// Column heading, with the sum's operator in front of stock columns
function ColLabel({ c }) {
  return (
    <>
      {c.op && (
        <span aria-hidden="true" style={{ color: "#8a8a8a", fontWeight: 500, marginRight: "3px" }}>
          {c.op}
        </span>
      )}
      {c.label}
    </>
  );
}

// Stock for the whole period as a sum: starting + added − sold = ending
function StockFlow({ rows, period }) {
  const tracked = rows.filter((r) => r.starting !== null && r.starting !== undefined && r.ending !== null && r.ending !== undefined);
  const start = tracked.reduce((n, r) => n + r.starting, 0);
  const end = tracked.reduce((n, r) => n + r.ending, 0);
  const sold = tracked.reduce((n, r) => n + r.sold, 0);
  const added = end - start + sold;
  const otherSold = rows.reduce((n, r) => n + r.sold, 0) - sold;
  const part = (label, value, sub, op) => (
    <>
      {op && (
        <span aria-hidden="true" style={{ fontSize: "22px", color: "#8a8a8a", alignSelf: "center", padding: "0 2px" }}>
          {op}
        </span>
      )}
      <div style={{ flex: "1 1 120px", minWidth: "110px" }}>
        <div style={muted}>{label}</div>
        <div style={{ fontSize: "20px", fontWeight: 650, marginTop: "2px", fontVariantNumeric: "tabular-nums" }}>{value}</div>
        <div style={{ ...muted, marginTop: "2px" }}>{sub}</div>
      </div>
    </>
  );
  return (
    <div
      role="group"
      aria-label={`Stock: started with ${start.toLocaleString()}, ${added >= 0 ? `${added.toLocaleString()} added` : `${Math.abs(added).toLocaleString()} taken out`}, ${sold.toLocaleString()} sold, ended with ${end.toLocaleString()}`}
      style={{ flex: "3 1 520px", padding: "10px 12px", border: "1px solid #e3e3e3", borderRadius: "10px", background: "#fff" }}
    >
      <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", flexWrap: "wrap" }}>
        {part("Starting count", count(start), `On hand ${fmtDay(period.from)}`)}
        {part("Added", signed(added), "Received, returned, adjusted", "+")}
        {part("Sold", count(sold), `${Math.round(sold / Math.max(1, period.days / 7)).toLocaleString()} a week`, "−")}
        {part("Ending count", count(end), `On hand ${fmtDay(period.to)}`, "=")}
      </div>
      {otherSold > 0 && (
        <div style={{ ...muted, marginTop: "6px" }}>
          Plus {otherSold.toLocaleString()} sold of products that don't track stock or were deleted ({(sold + otherSold).toLocaleString()} sold in all).
        </div>
      )}
    </div>
  );
}

function Cells({ g }) {
  return (
    <>
      <td style={num}>{count(g.starting)}</td>
      <td style={{ ...num, color: g.added < 0 ? "#8a6116" : undefined }} title={g.added < 0 ? "Stock was taken out: written off, corrected down, or similar" : undefined}>
        {g.added > 0 ? count(g.added) : signed(g.added)}
      </td>
      <td style={num}>{count(g.sold)}</td>
      <td style={{ ...num, fontWeight: 600 }}>{count(g.ending)}</td>
      <td style={num}>
        <Bar value={g.sellThrough} />
      </td>
      <td style={num}>{money(g.netSales)}</td>
      <td style={{ ...num, color: g.profit < 0 ? "#b42318" : undefined }}>{g.costedSales > 0 ? money(g.profit) : "—"}</td>
      <td style={num}>{pctText(g.margin)}</td>
      <td style={num}>{weeks(g.weeksLeft)}</td>
    </>
  );
}

function Row({ g, by, shopAdmin, onOpen, open, onToggle }) {
  const isItem = by === "item";
  return (
    <tr style={{ background: open ? "#f4f8ff" : undefined }}>
      <td style={{ ...cell, minWidth: "180px" }}>
        {isItem ? (
          <ItemName m={g} shopAdmin={shopAdmin} onOpen={onOpen} />
        ) : (
          <>
            <button type="button" style={linkBtn} onClick={onToggle} aria-expanded={open}>
              {open ? "▾" : "▸"} {g.name}
            </button>
            <div style={muted}>
              {g.count.toLocaleString()} item{g.count === 1 ? "" : "s"}
              {g.path && g.path !== g.name ? ` · ${g.path}` : ""}
            </div>
          </>
        )}
      </td>
      <Cells g={g} />
      <td style={{ ...cell, minWidth: "150px" }}>
        <RecPill rec={g.rec} />
        <div style={{ ...muted, marginTop: "2px" }}>{g.rec.reason}</div>
      </td>
    </tr>
  );
}

// Product name opens the quick view; ↗ opens it in Shopify
function ItemName({ m, shopAdmin, onOpen }) {
  const id = String(m.id).split("/").pop();
  return (
    <>
      {m.status === "deleted" ? (
        <span>{m.title}</span>
      ) : (
        <span style={{ display: "inline-flex", gap: "6px", alignItems: "baseline" }}>
          <ProductLink id={m.id} title={m.title} onOpen={onOpen} />
          <a href={`${shopAdmin}/products/${id}`} target="_blank" rel="noreferrer" title="Open in Shopify" aria-label={`Open ${m.title} in Shopify (new tab)`} style={{ color: "#8a8a8a", textDecoration: "none", fontSize: "12px" }}>
            ↗
          </a>
        </span>
      )}
      <div style={muted}>{[m.sku, m.vendor, m.status && m.status !== "active" ? m.status : null].filter(Boolean).join(" · ")}</div>
    </>
  );
}

function ItemTable({ items, shopAdmin, onOpen }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ ...head, cursor: "default", position: "static" }}>Item</th>
          {COLUMNS.map((c) => (
            <th key={c.key} style={{ ...head, cursor: "default", position: "static", textAlign: "right" }} title={c.title}>
              <ColLabel c={c} />
            </th>
          ))}
          <th style={{ ...head, cursor: "default", position: "static" }}>Suggestion</th>
        </tr>
      </thead>
      <tbody>
        {items.slice(0, 500).map((m) => (
          <tr key={m.id}>
            <td style={{ ...cell, minWidth: "180px" }}>
              <ItemName m={m} shopAdmin={shopAdmin} onOpen={onOpen} />
            </td>
            <Cells g={m} />
            <td style={{ ...cell, minWidth: "150px" }}>
              <RecPill rec={m.rec} />
              <div style={{ ...muted, marginTop: "2px" }}>{m.rec.reason}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function Reports({ onOpen }) {
  const { reports, reportId, saved, shopAdmin, canRefresh } = useLoaderData();
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const runner = useFetcher();
  const [search, setSearch] = useState("");
  const running = saved?.status === "running" || runner.state !== "idle";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => revalidator.revalidate(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const report = reports.find((r) => r.id === reportId);
  const rows = saved?.rows ?? [];
  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => [r.title, r.vendor, r.category, ...(r.skus ?? [])].some((v) => String(v ?? "").toLowerCase().includes(q))) : rows;
  const pick = (id) => {
    const next = new URLSearchParams(params);
    next.set("report", id);
    setParams(next);
  };

  return (
    <>
      {reports.length > 1 && (
        <s-section>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {reports.map((r) => (
              <s-button key={r.id} variant={r.id === reportId ? "primary" : "secondary"} onClick={() => pick(r.id)}>
                {r.title}
              </s-button>
            ))}
          </div>
        </s-section>
      )}

      <s-section heading={report.title}>
        <s-paragraph>{report.description}</s-paragraph>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", margin: "8px 0 10px" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles, SKUs, vendors" style={{ ...input, minWidth: "240px" }} aria-label="Search the report" />
          <span style={{ flex: 1 }} />
          <span style={muted}>
            {saved?.builtAt ? `Run ${ago(saved.builtAt)}` : ""}
            {running ? ` · ${saved?.step ?? "Working"}…` : ""}
          </span>
          {canRefresh && (
            <s-button onClick={() => runner.submit({ intent: "runReport", report: reportId }, { method: "post" })} {...(running ? { loading: true } : {})}>
              Run again
            </s-button>
          )}
        </div>

        {saved?.status === "failed" && (
          <s-banner tone="critical" heading="The report couldn't be run">
            <s-paragraph>{saved.error}</s-paragraph>
          </s-banner>
        )}
        {runner.data?.error && <div style={{ color: "#b42318", marginBottom: "6px" }}>{runner.data.error}</div>}

        {!rows.length && running && <s-paragraph>Reading archived products from Shopify. This page updates by itself.</s-paragraph>}
        {!rows.length && !running && saved?.status === "done" && (
          <s-banner tone="success" heading="Nothing to fix">
            <s-paragraph>No archived products have a release date after today.</s-paragraph>
          </s-banner>
        )}

        {rows.length > 0 && (
          <>
            <div style={{ ...muted, marginBottom: "6px" }}>
              {rows.length.toLocaleString()} product{rows.length === 1 ? "" : "s"}
              {q ? ` · ${shown.length.toLocaleString()} match` : ""}. Click a title to check or change its release date; fixes show here after Run again.
            </div>
            <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto", maxHeight: "70vh" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ ...head, cursor: "default" }}>Product</th>
                    <th style={{ ...head, cursor: "default" }}>Release date</th>
                    <th style={{ ...head, cursor: "default", textAlign: "right" }}>Days away</th>
                    <th style={{ ...head, cursor: "default" }}>SKU</th>
                    <th style={{ ...head, cursor: "default" }}>Vendor</th>
                    <th style={{ ...head, cursor: "default" }}>Category</th>
                    <th style={{ ...head, cursor: "default" }}>Last updated</th>
                    <th style={{ ...head, cursor: "default" }}>
                      <span style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}>Open in Shopify</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 1000).map((r) => (
                    <tr key={r.id}>
                      <td style={{ ...cell, minWidth: "180px" }}>
                        <ProductLink id={r.id} title={r.title} onOpen={onOpen} />
                      </td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(r.release)}</td>
                      <td style={num}>{r.days.toLocaleString()}</td>
                      <td style={cell}>{(r.skus ?? []).join(", ") || "—"}</td>
                      <td style={cell}>{r.vendor ?? "—"}</td>
                      <td style={cell}>{r.category ?? "—"}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        <a href={`${shopAdmin}/products/${r.legacyId}`} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }} aria-label={`Open ${r.title} in Shopify (new tab)`}>
                          Open in Shopify ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > 1000 && <div style={{ ...muted, padding: "8px 10px" }}>Showing the first 1,000. Search to narrow it down.</div>}
              {!shown.length && <div style={{ ...muted, padding: "12px" }}>Nothing matches.</div>}
            </div>
          </>
        )}
      </s-section>
    </>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
