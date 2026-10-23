import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { Err, box, cell, fmtDate, fmtDay, head, input, money, muted, num, pill } from "./ui";

// Purchase orders → Import from Linnworks: search Linnworks' POs, pick some (or all
// that match) and bring them in. Delivered quantities come across as received; stock
// isn't changed anywhere, and nothing changes in Linnworks.

const LW_STATUS = {
  PENDING: ["Pending", "#f1f1f1", "#4a4a4a"],
  OPEN: ["Open", "#e0ecff", "#1c4a9c"],
  PARTIAL: ["Partially delivered", "#fff4d6", "#7a4f01"],
  DELIVERED: ["Delivered", "#e3f1df", "#1a5e20"],
};
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" };

export function LinnworksImport() {
  const { linnworks } = useLoaderData();
  const [, setParams] = useSearchParams();
  const search = useFetcher();
  const importer = useFetcher();
  const poll = useFetcher();
  const revalidator = useRevalidator();
  const [f, setF] = useState({ status: "", from: "", to: "", q: "" });
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState([]);
  const [confirmAll, setConfirmAll] = useState(false);
  const [job, setJob] = useState(linnworks.job);
  const res = search.data?.intent === "lwSearch" && !search.data.error ? search.data : null;

  const run = (p = 1) => {
    setPage(p);
    search.submit({ intent: "lwSearch", ...f, page: String(p) }, { method: "post" });
  };
  useEffect(() => {
    if (linnworks.configured) run(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (importer.state === "idle" && importer.data?.job) {
      setJob(importer.data.job);
      setSel([]);
      setConfirmAll(false);
    }
  }, [importer.state, importer.data]);
  const submitPoll = useRef(poll.submit);
  submitPoll.current = poll.submit;
  useEffect(() => {
    if (!job?.running) return undefined;
    const t = setInterval(() => submitPoll.current({ intent: "lwJob" }, { method: "post" }), 1500);
    return () => clearInterval(t);
  }, [job?.running]);
  useEffect(() => {
    if (poll.data?.job) setJob(poll.data.job);
  }, [poll.data]);
  // When it finishes, show which are now imported
  const lastDone = useRef(null);
  useEffect(() => {
    if (job && !job.running && job.finishedAt && lastDone.current !== job.finishedAt) {
      lastDone.current = job.finishedAt;
      if (res) run(page);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.running, job?.finishedAt]);

  if (!linnworks.configured) {
    return (
      <s-section heading="Import from Linnworks">
        <div style={{ fontSize: "13px", lineHeight: 1.6 }}>
          Not set up yet.
          {linnworks.missing?.length > 0 && linnworks.missing.length < 3 && (
            <div style={{ margin: "4px 0", color: "#b42318" }}>
              Railway is missing: {linnworks.missing.map((k, i) => (
                <span key={k}>
                  {i ? ", " : ""}
                  <code>{k}</code>
                </span>
              ))}
              . Check the spelling, and that it's on this service.
            </div>
          )}
          {linnworks.missing?.length === 3 && <div style={{ margin: "4px 0", color: "#b42318" }}>None of the three Linnworks variables reach the app yet.</div>}
          To connect:
          <ol style={{ margin: "4px 0 0", paddingLeft: "20px" }}>
            <li>In Linnworks, create a developer app (Linnworks developer portal → My Apps) with access to Purchase orders and Inventory, and install it on your account.</li>
            <li>
              In Railway, add <code>LINNWORKS_APP_ID</code>, <code>LINNWORKS_APP_SECRET</code> and <code>LINNWORKS_TOKEN</code> (the installation token shown when the app is installed).
            </li>
            <li>Reload this page.</li>
          </ol>
        </div>
      </s-section>
    );
  }

  const running = Boolean(job?.running) || importer.state !== "idle";
  const choosable = (res?.rows ?? []).filter((r) => !r.imported);
  const allOnPage = choosable.length > 0 && choosable.every((r) => sel.includes(r.id));
  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const filterText = [f.status && LW_STATUS[f.status]?.[0], f.from && `from ${f.from}`, f.to && `to ${f.to}`, f.q && `“${f.q}”`].filter(Boolean).join(", ") || "every purchase order";

  return (
    <>
      <s-section heading="Import from Linnworks">
        <div style={{ ...muted, marginBottom: "10px" }}>
          Brings Linnworks purchase orders in with their lines, supplier (added here if new), expected date and status. What Linnworks already delivered shows as received.
          Nothing changes in Linnworks, and stock isn't changed anywhere. POs already imported are skipped.
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSel([]);
            run(1);
          }}
          style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}
        >
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={input} aria-label="Status">
            <option value="">Any status</option>
            {Object.entries(LW_STATUS).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <label style={{ display: "inline-flex", gap: "4px", alignItems: "center", fontSize: "13px" }}>
            Purchased from
            <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={input} aria-label="From" />
          </label>
          <label style={{ display: "inline-flex", gap: "4px", alignItems: "center", fontSize: "13px" }}>
            to
            <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={input} aria-label="To" />
          </label>
          <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Reference, SKU or supplier code" aria-label="Search" style={{ ...input, width: "220px" }} />
          <s-button onClick={() => (setSel([]), run(1))} {...(search.state !== "idle" ? { loading: true } : {})}>
            Search
          </s-button>
        </form>
        {search.data?.error && <Err data={search.data} />}
      </s-section>

      {job && (
        <s-section heading={job.running ? "Importing…" : "Last import"}>
          <div style={{ fontSize: "13px" }}>
            {job.running ? (
              <span>
                {job.step}
                {job.total != null ? `: ${job.done} of ${job.total}` : "…"}
              </span>
            ) : (
              <span>
                {job.imported} imported{job.skipped ? `, ${job.skipped} already here` : ""}
                {job.failed.length ? `, ${job.failed.length} failed` : ""}
                {job.by ? ` · by ${job.by}` : ""}
                {job.finishedAt ? ` · ${fmtDate(job.finishedAt, true)}` : ""}
              </span>
            )}
            {job.total ? (
              <div style={{ height: "6px", background: "#eef1f5", borderRadius: "3px", marginTop: "6px", overflow: "hidden" }}>
                <div style={{ width: `${(job.done / job.total) * 100}%`, height: "100%", background: "#29845a", transition: "width .3s" }} />
              </div>
            ) : null}
            {job.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{job.error}</div>}
            {job.failed.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: "18px", color: "#b42318" }}>
                {job.failed.slice(0, 20).map((x) => (
                  <li key={x.id}>{x.error}</li>
                ))}
              </ul>
            )}
            {!job.running && job.made.length > 0 && (
              <div style={{ marginTop: "6px" }}>
                {job.made.slice(0, 12).map((m, i) => (
                  <span key={m.id}>
                    {i ? ", " : "Open: "}
                    <button type="button" style={linkBtn} onClick={() => setParams({ po: String(m.id) })}>
                      {m.poNumber}
                    </button>
                  </span>
                ))}
                {job.made.length > 12 ? ` and ${job.made.length - 12} more on the Purchase orders tab` : ""}
              </div>
            )}
          </div>
        </s-section>
      )}

      {res && (
        <s-section heading={`In Linnworks: ${res.total.toLocaleString()} purchase order${res.total === 1 ? "" : "s"}`}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" }}>
            <s-button variant="primary" onClick={() => importer.submit({ intent: "lwImport", ids: JSON.stringify(sel) }, { method: "post" })} {...(!sel.length || running ? { disabled: true } : {})}>
              Import {sel.length || ""} selected
            </s-button>
            {confirmAll ? (
              <>
                <span style={{ fontSize: "13px", fontWeight: 600 }}>Import all {res.total.toLocaleString()} matching ({filterText})? Ones already here are skipped.</span>
                <s-button variant="primary" onClick={() => importer.submit({ intent: "lwImport", all: JSON.stringify(f) }, { method: "post" })}>
                  Yes, import all
                </s-button>
                <s-button variant="tertiary" onClick={() => setConfirmAll(false)}>
                  Cancel
                </s-button>
              </>
            ) : (
              <s-button onClick={() => setConfirmAll(true)} {...(running || !res.total ? { disabled: true } : {})}>
                Import all {res.total.toLocaleString()} matching
              </s-button>
            )}
            {importer.data?.error && <Err data={importer.data} />}
          </div>
          {res.rows.length === 0 ? (
            <span style={muted}>Nothing in Linnworks matches.</span>
          ) : (
            <div style={box}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
                <thead>
                  <tr>
                    <th style={{ ...head, width: "28px" }}>
                      <input
                        type="checkbox"
                        checked={allOnPage}
                        disabled={!choosable.length}
                        onChange={(e) => setSel(e.target.checked ? [...new Set([...sel, ...choosable.map((r) => r.id)])] : sel.filter((id) => !choosable.some((r) => r.id === id)))}
                        aria-label="Choose all on this page"
                      />
                    </th>
                    <th style={head}>Reference</th>
                    <th style={head}>Supplier</th>
                    <th style={head}>Purchased</th>
                    <th style={head}>Expected</th>
                    <th style={head}>Status</th>
                    <th style={{ ...head, textAlign: "right" }}>Lines</th>
                    <th style={{ ...head, textAlign: "right" }}>Total</th>
                    <th style={head}>Here</th>
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r) => {
                    const [label, bg, fg] = LW_STATUS[r.status] ?? [r.status || "—", "#f1f1f1", "#4a4a4a"];
                    return (
                      <tr key={r.id} style={{ opacity: r.imported ? 0.6 : 1, background: sel.includes(r.id) ? "#f4f8ff" : undefined }}>
                        <td style={cell}>
                          <input type="checkbox" checked={sel.includes(r.id)} disabled={Boolean(r.imported)} onChange={() => toggle(r.id)} aria-label={`Choose ${r.reference ?? r.id}`} />
                        </td>
                        <td style={cell}>
                          <strong>{r.reference ?? "—"}</strong>
                          {r.supplierRef && <div style={muted}>Supplier ref {r.supplierRef}</div>}
                        </td>
                        <td style={cell}>{r.supplier ?? <span style={muted}>—</span>}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDate(r.purchasedAt)}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(r.expectedAt)}</td>
                        <td style={cell}>
                          <span style={pill(bg, fg)}>{label}</span>
                        </td>
                        <td style={num}>
                          {r.lines ?? "—"}
                          {r.deliveredLines ? <div style={muted}>{r.deliveredLines} delivered</div> : null}
                        </td>
                        <td style={num}>{r.total != null ? money(r.total, r.currency) : "—"}</td>
                        <td style={cell}>
                          {r.imported ? (
                            <button type="button" style={linkBtn} onClick={() => setParams({ po: String(r.imported.id) })}>
                              ✓ {r.imported.poNumber}
                            </button>
                          ) : (
                            <span style={muted}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {res.pages > 1 && (
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "8px" }}>
              <s-button variant="tertiary" onClick={() => run(page - 1)} {...(page <= 1 ? { disabled: true } : {})}>
                ← Newer
              </s-button>
              <span style={muted}>
                Page {res.page} of {res.pages}
                {sel.length ? ` · ${sel.length} chosen (kept across pages)` : ""}
              </span>
              <s-button variant="tertiary" onClick={() => run(page + 1)} {...(page >= res.pages ? { disabled: true } : {})}>
                Older →
              </s-button>
            </div>
          )}
        </s-section>
      )}
    </>
  );
}
