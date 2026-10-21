import { Fragment, useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { PERIODS, getReport, periodRange, startReport } from "../analytics.server";
import { GROUPS, RULES, SORTS, buildGroups, relevant, sortGroups, toCsv } from "../analytics-logic";

// Sell-through analytics: what sells, what makes money, and what to carry
// more or less of, by category, publisher, supplier or item.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "analytics", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const period = periodRange(new URL(request.url).searchParams.get("period") ?? "90d");
  let report = await getReport(shop, period.key);
  // First visit for this period: build it
  if (!report) {
    await startReport(shop, period.key);
    report = await getReport(shop, period.key);
  }
  const handle = shop.replace(/\.myshopify\.com$/, "");
  return {
    period,
    periods: Object.entries(PERIODS).map(([value, p]) => ({ value, label: p.label })),
    report,
    shopAdmin: `https://admin.shopify.com/store/${handle}`,
    canRefresh: can(user, "analytics", "view"),
  };
};

export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  if (!can(user, "analytics", "view")) return denied("analytics", "view");
  const form = await request.formData();
  if (form.get("intent") === "refresh") {
    try {
      const period = await startReport(session.shop, String(form.get("period") ?? "90d"));
      return { intent: "refresh", ok: true, period: period.key };
    } catch (e) {
      return { intent: "refresh", error: errorMessage(e) };
    }
  }
  return { error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "7px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top", fontSize: "13px" };
const num = { ...cell, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 1, cursor: "pointer", userSelect: "none" };
const muted = { color: "#616161", fontSize: "12px" };
const input = { padding: "5px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit", fontSize: "13px", background: "#fff" };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", textAlign: "left" };

const money = (n) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
const pctText = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const weeks = (w) => (w === null ? "—" : w === Infinity ? "∞" : w < 1 ? "<1" : Math.round(w).toLocaleString());
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
      <span style={{ width: "54px", height: "6px", background: "#ececec", borderRadius: "3px", overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", height: "100%", width: `${v * 100}%`, background: color }} />
      </span>
      <span style={{ minWidth: "38px", textAlign: "right" }}>{pctText(value)}</span>
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

export default function Analytics() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Analytics" />;
  return <Page />;
}

const COLUMNS = [
  { key: "received", label: "Received", title: "Units received from suppliers in the period" },
  { key: "sold", label: "Sold", title: "Net units sold (after returns)" },
  { key: "sellThrough", label: "Sell-through", title: "Sold ÷ received in the period" },
  { key: "netSales", label: "Net sales" },
  { key: "profit", label: "Gross profit", title: "Net sales minus cost, for items with a cost set" },
  { key: "margin", label: "Margin", title: "Gross profit ÷ net sales, for items with a cost set" },
  { key: "onHand", label: "On hand", title: "Available now, all locations" },
  { key: "weeksLeft", label: "Weeks of stock", title: "On hand ÷ weekly sales in the period" },
];

function Page() {
  const { period, periods, report, shopAdmin, canRefresh } = useLoaderData();
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const refresher = useFetcher();
  const [by, setBy] = useState(params.get("by") ?? "type");
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
    const csv = toCsv(by === "item" ? shown : shown, by);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `sell-through-${GROUPS[by].label.toLowerCase().replace(/[^a-z]+/g, "-")}-${period.from}-to-${period.to}.csv`;
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
    <s-page heading="Sell-through analytics">
      <s-section>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
          <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
            <span style={muted}>Period</span>
            <select
              value={PERIODS_KEYS(periods).includes(period.key) ? period.key : "custom"}
              onChange={(e) => e.target.value !== "custom" && goPeriod(e.target.value)}
              style={input}
            >
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
            {report?.status === "done" || report?.builtAt ? `Updated ${ago(report.builtAt)}` : ""}
            {running ? ` · ${report?.step ?? "Working"}…` : ""}
          </span>
          {canRefresh && (
            <s-button
              onClick={() => refresher.submit({ intent: "refresh", period: period.key }, { method: "post" })}
              {...(running ? { loading: true } : {})}
            >
              Refresh
            </s-button>
          )}
        </div>
        <div style={{ ...muted, marginTop: "6px" }}>
          {period.label} ({period.from} to {period.to}, {period.days} days)
        </div>
        {report?.status === "failed" && (
          <div style={{ marginTop: "8px" }}>
            <s-banner tone="critical" heading="The report couldn't be built">
              <s-paragraph>{report.error}</s-paragraph>
            </s-banner>
          </div>
        )}
        {refresher.data?.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{refresher.data.error}</div>}
      </s-section>

      {!rows.length && running && (
        <s-section>
          <s-paragraph>
            Building the report: reading your catalog and Shopify's sales report. This usually takes a minute or two (longer the first time, or if the stock history sync
            is busy). This page updates by itself.
          </s-paragraph>
        </s-section>
      )}

      {rows.length > 0 && t && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "12px" }}>
            <Tile label="Units sold" value={t.sold.toLocaleString()} sub={`${(t.sold / Math.max(1, t.days / 7)).toFixed(0)} a week`} />
            <Tile label="Units received" value={t.received.toLocaleString()} sub={t.received ? `Sell-through ${pctText(t.sold / t.received)}` : "None recorded in this period"} />
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
                      <th key={c.key} style={{ ...head, textAlign: "right" }} title={c.title} onClick={() => clickHead(c.key)} aria-sort={activeKey === c.key ? (activeDir > 0 ? "ascending" : "descending") : "none"}>
                        {c.label}
                        {activeKey === c.key ? (activeDir > 0 ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                    <th style={{ ...head, cursor: "default" }}>Suggestion</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 1000).map((g) => (
                    <Fragment key={g.key}>
                      <Row g={g} by={by} shopAdmin={shopAdmin} open={open === g.key} onToggle={() => setOpen(open === g.key ? null : g.key)} />
                      {by !== "item" && open === g.key && (
                        <tr>
                          <td colSpan={COLUMNS.length + 2} style={{ ...cell, background: "#fafafa", padding: "8px 10px 12px 28px" }}>
                            <ItemTable items={sortGroups(g.items, sort.key, sort.dir)} shopAdmin={shopAdmin} />
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
                    <strong>Sold, net sales, cost and profit</strong> come from Shopify's sales report (net of returns). Profit and margin only count sales of items with a
                    cost set in Shopify.
                  </li>
                  <li>
                    <strong>Received</strong> is stock received from suppliers in the period: Shopify purchase orders and transfers received, "Received" adjustments, and POs
                    received in this app. Moving stock between your own locations isn't counted.
                  </li>
                  <li>
                    <strong>Sell-through</strong> is sold ÷ received in the period. Suggestions use <em>sold ÷ (sold + on hand)</em> so older stock counts too.
                  </li>
                  <li>
                    <strong>Carry more</strong>: sold at least {pctText(RULES.moreSellThrough)} of its stock, with under {RULES.moreWeeksLeft} weeks left (or sold out), and
                    at least {pctText(RULES.moreMinMargin)} margin when cost is known.
                  </li>
                  <li>
                    <strong>Carry less</strong>: sold under {pctText(RULES.lessSellThrough)} of its stock with {RULES.lessMinOnHand}+ on hand, or over {RULES.lessWeeksLeft}{" "}
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
    </s-page>
  );
}

const PERIODS_KEYS = (periods) => periods.map((p) => p.value);

function Cells({ g }) {
  return (
    <>
      <td style={num}>{g.received.toLocaleString()}</td>
      <td style={num}>{g.sold.toLocaleString()}</td>
      <td style={num}>
        <Bar value={g.sellThrough} />
      </td>
      <td style={num}>{money(g.netSales)}</td>
      <td style={{ ...num, color: g.profit < 0 ? "#b42318" : undefined }}>{g.costedSales > 0 ? money(g.profit) : "—"}</td>
      <td style={num}>{pctText(g.margin)}</td>
      <td style={num}>{g.onHand === null ? "—" : g.onHand.toLocaleString()}</td>
      <td style={num}>{weeks(g.weeksLeft)}</td>
    </>
  );
}

function Row({ g, by, shopAdmin, open, onToggle }) {
  const isItem = by === "item";
  return (
    <tr style={{ background: open ? "#f4f8ff" : undefined }}>
      <td style={{ ...cell, minWidth: "220px" }}>
        {isItem ? (
          <ItemName m={g} shopAdmin={shopAdmin} />
        ) : (
          <>
            <button type="button" style={linkBtn} onClick={onToggle} aria-expanded={open}>
              {open ? "▾" : "▸"} {g.name}
            </button>
            <div style={muted}>
              {g.count.toLocaleString()} item{g.count === 1 ? "" : "s"}
            </div>
          </>
        )}
      </td>
      <Cells g={g} />
      <td style={{ ...cell, minWidth: "180px" }}>
        <RecPill rec={g.rec} />
        <div style={{ ...muted, marginTop: "2px" }}>{g.rec.reason}</div>
      </td>
    </tr>
  );
}

function ItemName({ m, shopAdmin }) {
  const id = String(m.id).split("/").pop();
  return (
    <>
      {m.status === "deleted" ? (
        <span>{m.title}</span>
      ) : (
        <a href={`${shopAdmin}/products/${id}`} target="_top" style={{ color: "#005bd3" }}>
          {m.title}
        </a>
      )}
      <div style={muted}>{[m.sku, m.vendor, m.status && m.status !== "active" ? m.status : null].filter(Boolean).join(" · ")}</div>
    </>
  );
}

function ItemTable({ items, shopAdmin }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          <th style={{ ...head, cursor: "default", position: "static" }}>Item</th>
          {COLUMNS.map((c) => (
            <th key={c.key} style={{ ...head, cursor: "default", position: "static", textAlign: "right" }}>
              {c.label}
            </th>
          ))}
          <th style={{ ...head, cursor: "default", position: "static" }}>Suggestion</th>
        </tr>
      </thead>
      <tbody>
        {items.slice(0, 500).map((m) => (
          <tr key={m.id}>
            <td style={{ ...cell, minWidth: "220px" }}>
              <ItemName m={m} shopAdmin={shopAdmin} />
            </td>
            <Cells g={m} />
            <td style={{ ...cell, minWidth: "180px" }}>
              <RecPill rec={m.rec} />
              <div style={{ ...muted, marginTop: "2px" }}>{m.rec.reason}</div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
