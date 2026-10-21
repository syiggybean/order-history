import { Fragment, useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage, todayInStore } from "../preorders.server";
import {
  ISSUE_TYPES,
  OrdoroError,
  STATUSES,
  addIssueNote,
  deleteIssueNote,
  exportIssues,
  isRunning,
  issueDetail,
  latestRun,
  listIssues,
  ordoroConfigured,
  setIssueStatus,
  startRun,
} from "../ordoro.server";

// Orders that differ between Shopify and Ordoro, for cleaning up before
// offboarding Ordoro. View: see everything. Manage: run comparisons, set
// statuses, write notes.

const PAGE_SIZE = 50;

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "reconciliation", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const p = new URL(request.url).searchParams;
  const filter = { status: p.get("status") ?? "open", type: p.get("type") ?? "", q: p.get("q") ?? "", page: Math.max(1, Number(p.get("page") ?? 1)) };
  const handle = shop.replace(/\.myshopify\.com$/, "");
  const today = todayInStore();
  return {
    configured: ordoroConfigured(),
    run: await latestRun(shop),
    running: isRunning(shop),
    filter,
    today,
    ...(await listIssues(shop, { ...filter, pageSize: PAGE_SIZE })),
    issueTypes: ISSUE_TYPES,
    statuses: STATUSES,
    shopAdmin: `https://admin.shopify.com/store/${handle}`,
    canManage: can(user, "reconciliation", "manage"),
  };
};

const NEEDS = { detail: "view", export: "view", run: "manage", status: "manage", addNote: "manage", deleteNote: "manage" };

export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const need = NEEDS[intent];
  if (!need) return { intent, error: "Unknown action" };
  if (!can(user, "reconciliation", need)) return { intent, ...denied("reconciliation", need) };
  const shop = session.shop;
  try {
    switch (intent) {
      case "detail":
        return { intent, detail: await issueDetail(shop, form.get("id")) };
      case "export":
        return { intent, csv: await exportIssues(shop, { status: String(form.get("status") ?? "open"), type: String(form.get("type") ?? ""), q: String(form.get("q") ?? "") }) };
      case "run":
        await startRun(shop, { fromDay: String(form.get("from")), toDay: String(form.get("to")) }, user);
        return { intent, ok: true };
      case "status":
        await setIssueStatus(shop, form.get("id"), String(form.get("status")), user);
        return { intent, ok: true, detail: await issueDetail(shop, form.get("id")) };
      case "addNote":
        await addIssueNote(shop, form.get("id"), form.get("body"), user);
        return { intent, ok: true, detail: await issueDetail(shop, form.get("id")) };
      case "deleteNote":
        await deleteIssueNote(shop, form.get("noteId"), user);
        return { intent, ok: true, detail: await issueDetail(shop, form.get("id")) };
    }
  } catch (e) {
    return { intent, error: e instanceof OrdoroError ? e.message : errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

// Reading a row's details doesn't need the whole list reloaded
export const shouldRevalidate = ({ formData, defaultShouldRevalidate }) => {
  if (formData && ["detail", "export"].includes(String(formData.get("intent")))) return false;
  return defaultShouldRevalidate;
};

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top", fontSize: "13px" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap" };
const muted = { color: "#616161", fontSize: "12px" };
const input = { padding: "5px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit", fontSize: "13px", background: "#fff" };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", textAlign: "left" };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap", marginRight: "4px", marginBottom: "2px" });
const STATUS_COLORS = { open: ["#fff1d6", "#7a4f01"], resolved: ["#e3f1df", "#1a5e20"], ignored: ["#ececec", "#4a4a4a"], fixed: ["#e0ecff", "#1c4a9c"] };
const TYPE_COLORS = { missing_ordoro: ["#fde7e9", "#8e1f0b"], missing_shopify: ["#fde7e9", "#8e1f0b"] };
const fmtDay = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }) : "—");
const fmtTime = (s) => (s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "—");
const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function OrdoroReconciliation() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Ordoro reconciliation" />;
  return <Page />;
}

function Page() {
  const d = useLoaderData();
  const { run, filter, canManage, issueTypes, statuses } = d;
  const [, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const runner = useFetcher();
  const exporter = useFetcher();
  const [range, setRange] = useState({ from: run?.fromDay ?? addDays(d.today, -89), to: run?.toDay ?? d.today });
  const [q, setQ] = useState(filter.q);
  const [open, setOpen] = useState(null);
  const working = d.running || run?.status === "running" || runner.state !== "idle";

  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working]);
  useEffect(() => {
    if (exporter.state === "idle" && exporter.data?.csv) {
      const url = URL.createObjectURL(new Blob([exporter.data.csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `shopify-ordoro-mismatches-${filter.status}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, [exporter.state, exporter.data, filter.status]);

  const go = (patch) => {
    const next = { status: filter.status, type: filter.type, q: filter.q, page: "1", ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([, v]) => v !== "" && v !== null && v !== undefined)));
    setOpen(null);
  };
  const c = run?.counts;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));

  return (
    <s-page heading="Shopify ↔ Ordoro reconciliation">
      {!d.configured && (
        <s-banner tone="warning" heading="Connect Ordoro first">
          <s-paragraph>
            In Ordoro, go to Settings → Account Settings → API Keys and create a key (API access needs Ordoro's Premium plan or above). Then add ORDORO_API_KEY and
            ORDORO_API_SECRET in Railway's Variables.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Compare orders">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
          <span style={muted}>Orders placed from</span>
          <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={input} aria-label="From" />
          <span style={muted}>to</span>
          <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={input} aria-label="To" />
          {canManage && (
            <s-button
              variant="primary"
              onClick={() => runner.submit({ intent: "run", from: range.from, to: range.to }, { method: "post" })}
              {...(working ? { loading: true } : {})}
              {...(!d.configured ? { disabled: true } : {})}
            >
              {run ? "Compare again" : "Compare"}
            </s-button>
          )}
        </div>
        {runner.data?.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{runner.data.error}</div>}
        {run && (
          <div style={{ marginTop: "10px", fontSize: "13px" }}>
            {run.status === "running" && (
              <span>
                ⏳ {run.step}… <span style={muted}>(this page updates by itself)</span>
              </span>
            )}
            {run.status === "failed" && (
              <s-banner tone="critical" heading="The comparison stopped">
                <s-paragraph>{run.error}</s-paragraph>
              </s-banner>
            )}
            {run.status === "done" && c && (
              <span>
                Last compared {fmtTime(run.finishedAt)}
                {run.startedBy ? ` by ${run.startedBy}` : ""} for orders placed {fmtDay(`${run.fromDay}T12:00:00Z`)} – {fmtDay(`${run.toDay}T12:00:00Z`)}:{" "}
                <strong>{c.shopify.toLocaleString()}</strong> Shopify orders, <strong>{c.ordoro.toLocaleString()}</strong> Ordoro orders,{" "}
                <strong>{c.matched.toLocaleString()}</strong> paired, <strong>{c.found.toLocaleString()}</strong> with differences
                {c.fixed ? ` (${c.fixed} fixed since last time)` : ""}.
                <div style={muted}>
                  Not compared: {c.excluded.toLocaleString()} Shopify test or nothing-to-ship orders
                  {c.otherChannels ? `, ${c.otherChannels.toLocaleString()} Ordoro orders from other sales channels` : ""}.
                </div>
                {c.noMatchesAtAll && (
                  <div style={{ marginTop: "6px" }}>
                    <s-banner tone="warning" heading="No orders could be paired">
                      <s-paragraph>
                        Every order shows as missing on one side, so the order numbers probably don't line up as expected. Send a Shopify order name and its Ordoro order
                        number to get the matching adjusted.
                      </s-paragraph>
                    </s-banner>
                  </div>
                )}
              </span>
            )}
          </div>
        )}
      </s-section>

      <s-section>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
          {[["open", "Open"], ["resolved", "Resolved"], ["ignored", "Ignored"], ["fixed", "Now matches"], ["all", "All"]].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => go({ status: k })}
              style={{ ...input, cursor: "pointer", background: filter.status === k ? "#303030" : "#fff", color: filter.status === k ? "#fff" : "#303030" }}
            >
              {label}
              {k !== "all" ? ` (${(d.counts.byStatus[k] ?? 0).toLocaleString()})` : ""}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "10px" }}>
          <select value={filter.type} onChange={(e) => go({ type: e.target.value })} style={input} aria-label="Problem">
            <option value="">Every problem</option>
            {Object.entries(issueTypes).map(([k, label]) => (
              <option key={k} value={k}>
                {label} ({(d.counts.byType[k] ?? 0).toLocaleString()})
              </option>
            ))}
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go({ q });
            }}
            style={{ display: "inline-flex", gap: "6px" }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order number or note text" style={{ ...input, minWidth: "220px" }} aria-label="Search" />
            <s-button variant="tertiary" type="submit">
              Search
            </s-button>
          </form>
          <span style={{ flex: 1 }} />
          <span style={muted}>{d.total.toLocaleString()} orders</span>
          <s-button
            variant="tertiary"
            onClick={() => exporter.submit({ intent: "export", status: filter.status, type: filter.type, q: filter.q }, { method: "post" })}
            {...(exporter.state !== "idle" ? { loading: true } : {})}
          >
            Export CSV
          </s-button>
        </div>

        {d.rows.length === 0 ? (
          <s-paragraph>{run ? "Nothing here." : "Run a comparison to find orders that don't match."}</s-paragraph>
        ) : (
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={head}>Order</th>
                  <th style={head}>Placed</th>
                  <th style={head}>Problems</th>
                  <th style={head}>Status</th>
                  <th style={head}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr style={{ background: open === r.id ? "#f4f8ff" : undefined }}>
                      <td style={cell}>
                        <button type="button" style={linkBtn} onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                          {open === r.id ? "▾" : "▸"} {r.orderName}
                        </button>
                        {r.ordoroNumber && <div style={muted}>Ordoro {r.ordoroNumber}</div>}
                      </td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(r.placedAt)}</td>
                      <td style={cell}>
                        {r.issues.map((i) => {
                          const [bg, fg] = TYPE_COLORS[i.type] ?? ["#f1f1f1", "#303030"];
                          return (
                            <span key={i.type} style={pill(bg, fg)}>
                              {i.label}
                            </span>
                          );
                        })}
                      </td>
                      <td style={cell}>
                        <span style={pill(...(STATUS_COLORS[r.status] ?? STATUS_COLORS.open))}>{statuses[r.status]}</span>
                        {r.statusBy && r.status !== "open" && <div style={muted}>{r.statusBy}</div>}
                      </td>
                      <td style={cell}>{r.notes ? `${r.notes} note${r.notes === 1 ? "" : "s"}` : <span style={muted}>—</span>}</td>
                    </tr>
                    {open === r.id && (
                      <tr>
                        <td colSpan={5} style={{ ...cell, background: "#fafafa", padding: "10px 14px 14px" }}>
                          <Detail id={r.id} canManage={canManage} shopAdmin={d.shopAdmin} statuses={statuses} onChanged={() => revalidator.revalidate()} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "10px" }}>
            <s-button variant="tertiary" onClick={() => go({ page: String(d.page - 1) })} {...(d.page <= 1 ? { disabled: true } : {})}>
              ← Newer
            </s-button>
            <span style={muted}>
              Page {d.page} of {pages}
            </span>
            <s-button variant="tertiary" onClick={() => go({ page: String(d.page + 1) })} {...(d.page >= pages ? { disabled: true } : {})}>
              Older →
            </s-button>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

function Detail({ id, canManage, shopAdmin, statuses, onChanged }) {
  const loader = useFetcher();
  const act = useFetcher();
  const [note, setNote] = useState("");
  useEffect(() => {
    loader.submit({ intent: "detail", id: String(id) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (act.state === "idle" && act.data?.ok) {
      if (act.data.intent === "addNote") setNote("");
      onChanged?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.state, act.data]);
  const d = act.data?.detail ?? loader.data?.detail;
  if (loader.data?.error) return <div style={{ color: "#b42318" }}>{loader.data.error}</div>;
  if (!d) return <span style={muted}>Loading…</span>;
  const s = d.detail?.shopify;
  const o = d.detail?.ordoro;
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", background: "#fff", border: "1px solid #e3e3e3", borderRadius: "8px" }}>
        <thead>
          <tr>
            <th style={head}>Problem</th>
            <th style={head}>
              Shopify{" "}
              {d.shopifyOrderId && (
                <a href={`${shopAdmin}/orders/${d.shopifyOrderId}`} target="_top" style={{ color: "#005bd3", fontWeight: 400 }}>
                  Open {s?.name ?? "order"}
                </a>
              )}
            </th>
            <th style={head}>
              Ordoro{" "}
              {d.ordoroNumber && (
                <a href={`https://app.ordoro.com/order/${encodeURIComponent(d.ordoroNumber)}`} target="_blank" rel="noreferrer" style={{ color: "#005bd3", fontWeight: 400 }}>
                  Open {d.ordoroNumber}
                </a>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {d.issues.map((i) => (
            <tr key={i.type}>
              <td style={{ ...cell, fontWeight: 600, whiteSpace: "nowrap" }}>{i.label}</td>
              <td style={cell}>{i.shopify}</td>
              <td style={cell}>{i.ordoro}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {(s || o) && (
        <div style={{ ...muted, fontSize: "12px" }}>
          {s && `Shopify: ${s.cancelled ? "cancelled, " : ""}${String(s.fulfillment ?? "").toLowerCase().replace(/_/g, " ")}, $${Number(s.total).toFixed(2)}. `}
          {o && `Ordoro: ${o.status || "no status"}${o.parts?.length > 1 ? ` (split into ${o.parts.join(", ")})` : ""}${o.total !== null ? `, $${Number(o.total).toFixed(2)}` : ""}.`}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <span style={muted}>
          Status: <strong>{statuses[d.status]}</strong>
          {d.statusBy && d.status !== "open" ? ` (${d.statusBy}, ${fmtTime(d.statusAt)})` : ""}
        </span>
        {canManage &&
          [["resolved", "Mark resolved"], ["ignored", "Ignore"], ["open", "Reopen"]]
            .filter(([k]) => k !== d.status && !(k === "open" && d.status === "open"))
            .map(([k, label]) => (
              <s-button key={k} variant={k === "resolved" ? "primary" : "tertiary"} onClick={() => act.submit({ intent: "status", id: String(d.id), status: k }, { method: "post" })}>
                {label}
              </s-button>
            ))}
      </div>
      {d.status === "fixed" && <div style={muted}>The last comparison found Shopify and Ordoro now agree on this order.</div>}

      <div>
        <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "6px" }}>Research notes</div>
        {d.notes.length === 0 && <div style={muted}>No notes yet.</div>}
        {d.notes.map((n) => (
          <div key={n.id} style={{ padding: "8px 10px", background: "#fffbea", border: "1px solid #f3e3a1", borderRadius: "8px", marginBottom: "6px" }}>
            <div style={{ whiteSpace: "pre-wrap", fontSize: "13px" }}>{n.body}</div>
            <div style={{ ...muted, display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
              {n.by ?? "Staff"} · {fmtTime(n.at)}
              {canManage && (
                <button type="button" style={{ ...linkBtn, color: "#b42318", fontSize: "12px" }} onClick={() => act.submit({ intent: "deleteNote", id: String(d.id), noteId: String(n.id) }, { method: "post" })}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
        {canManage && (
          <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginTop: "6px" }}>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What did you find? What needs doing?" style={{ ...input, flex: 1 }} aria-label="New note" />
            <s-button onClick={() => act.submit({ intent: "addNote", id: String(d.id), body: note }, { method: "post" })} {...(!note.trim() ? { disabled: true } : {})} {...(act.state !== "idle" ? { loading: true } : {})}>
              Add note
            </s-button>
          </div>
        )}
        {act.data?.error && <div style={{ color: "#b42318", fontSize: "13px", marginTop: "4px" }}>{act.data.error}</div>}
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
