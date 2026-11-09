import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { OrderLink } from "./OrderLink";
import { ago, box, cell, fmtDate, head, pill, small, useParamSetter } from "./ui";

// ---------------------------------------------------------------------------
// The Ordoro batches tab: import, and the imported batches (kept apart from
// MonkeyBean's own). Each one opens like any batch, with what didn't line up.
// ---------------------------------------------------------------------------

export function OrdoroTab({ data, canBatches }) {
  const f = useFetcher();
  const go = useParamSetter();
  const revalidator = useRevalidator();
  const job = data.job;
  const running = Boolean(job?.running) || (f.state !== "idle" && f.formData?.get("intent") === "ordoroImport");
  // While importing: check back every few seconds for progress
  useEffect(() => {
    if (!job?.running) return;
    const t = setInterval(() => revalidator.state === "idle" && revalidator.revalidate(), 3000);
    return () => clearInterval(t);
  }, [job?.running]); // eslint-disable-line react-hooks/exhaustive-deps
  const err = (f.data?.intent === "ordoroImport" && f.data.error) || null;
  return (
    <s-section heading="Ordoro batches">
      <s-paragraph>
        Active batches from Ordoro, brought in as Ordoro-Batch-NNNN and kept apart from MonkeyBean's own. Orders shipped in Ordoro and fulfilled in
        Shopify come in as shipped; the rest come in to pick (Ordoro doesn't say what's been picked or packed). Orders still waiting here, like
        pre-orders, are pre-batched: picking waits for their release date, as with batching ahead. If Ordoro shipped something
        Shopify hasn't, that batch is put on hold until it's reconciled.
      </s-paragraph>
      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", margin: "10px 0 14px" }}>
        {canBatches && (
          <s-button
            variant="primary"
            onClick={() => f.submit({ intent: "ordoroImport" }, { method: "post" })}
            disabled={running || !data.configured || undefined}
            {...(running ? { loading: true } : {})}
          >
            {data.batches.length ? "Import and refresh from Ordoro" : "Import active batches from Ordoro"}
          </s-button>
        )}
        {!data.configured && <span style={{ ...small, color: "#b42318" }}>Ordoro isn't connected: add ORDORO_API_KEY and ORDORO_API_SECRET in Railway.</span>}
        {job?.running && (
          <span style={small}>
            {job.refs?.length ? `Importing ${job.refs.join(", ")}: ` : ""}
            {job.step ?? "Working…"}
          </span>
        )}
        {!job?.running && job?.result && (
          <span style={{ ...small, color: "#1a5e20" }}>
            Last import {job.finishedAt ? ago(job.finishedAt) : ""}: {job.result.found} active in Ordoro · {job.result.imported} new · {job.result.refreshed} refreshed
            {job.result.skipped ? ` · ${job.result.skipped} skipped (cancelled here)` : ""}
          </span>
        )}
        {!job?.running && job?.error && <span style={{ ...small, color: "#b42318" }}>Import stopped: {job.error}</span>}
        {err && <span style={{ ...small, color: "#b42318" }}>{err}</span>}
      </div>
      {canBatches && data.configured && <ChooseBatches disabled={running} />}
      {canBatches && data.batches.length > 0 && (
        <div style={{ ...small, marginBottom: "8px" }}>
          Importing again refreshes batches already here (new orders, anything shipped since) and adds new ones. Batches you've cancelled here stay cancelled.
        </div>
      )}
      {data.batches.length === 0 ? (
        <s-paragraph>No Ordoro batches imported yet.</s-paragraph>
      ) : (
        <div style={box}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Batch", "In Ordoro", "Orders", "Shipped", "To do", "Status", ""].map((h) => (
                  <th key={h} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.id} style={{ background: b.blocking ? "#fff4f4" : undefined }}>
                  <td style={cell}>
                    <button type="button" onClick={() => go({ tab: "batches", batch: b.id, view: null }, { replace: false })} style={{ all: "unset", cursor: "pointer", color: "#005bd3", fontWeight: 600 }}>
                      {b.tag}
                    </button>
                    {b.name && <div style={small}>{b.name}</div>}
                  </td>
                  <td style={cell}>
                    {b.ref}
                    <div style={small}>imported {b.importedAt ? fmtDate(b.importedAt) : "—"}{b.refreshedAt && b.refreshedAt !== b.importedAt ? ` · refreshed ${ago(b.refreshedAt)}` : ""}</div>
                  </td>
                  <td style={cell}>{b.orders ?? "—"}</td>
                  <td style={cell}>
                    {b.shipped}/{b.shipments}
                  </td>
                  <td style={cell}>
                    {b.toDo}
                    {b.packed ? <div style={small}>{b.packed} packed</div> : null}
                  </td>
                  <td style={cell}>
                    {b.blocking > 0 ? (
                      <span style={pill("#fde7e9", "#8e1f0b")}>On hold: {b.blocking} to reconcile</span>
                    ) : (
                      <span style={pill(b.status === "done" ? "#e3f1df" : b.status === "cancelled" ? "#f1f1f1" : "#eef3ff", b.status === "done" ? "#1a5e20" : b.status === "cancelled" ? "#616161" : "#1c4a9c")}>
                        {b.status === "done" ? "Done" : b.status === "cancelled" ? "Cancelled" : b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                      </span>
                    )}
                    {b.notes > 0 && <div style={small}>{b.notes} note{b.notes === 1 ? "" : "s"}</div>}
                  </td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    <s-button onClick={() => go({ tab: "batches", batch: b.id, view: null }, { replace: false })}>Open</s-button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}

// Ordoro's active batches, newest first: import just the ones needed now
function ChooseBatches({ disabled }) {
  const list = useFetcher();
  const imp = useFetcher();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rows = list.data?.intent === "ordoroRemote" ? list.data.batches ?? [] : null;
  const loading = list.state !== "idle";
  const shown = (rows ?? []).filter((b) => !q || `${b.ref} ${b.notes ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const load = () => {
    setOpen(true);
    list.submit({ intent: "ordoroRemote" }, { method: "post" });
  };
  if (!open)
    return (
      <div style={{ margin: "-4px 0 12px" }}>
        <s-button variant="secondary" onClick={load}>
          Choose a batch to import first…
        </s-button>
      </div>
    );
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", padding: "10px 12px", margin: "0 0 14px" }}>
      <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginBottom: "8px" }}>
        <strong>Ordoro's active batches</strong>
        <input
          aria-label="Find an Ordoro batch"
          placeholder="Find (e.g. Nov 10)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ padding: "6px 8px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "13px", minWidth: "220px" }}
        />
        <s-button variant="tertiary" onClick={load} {...(loading ? { loading: true } : {})}>
          Reload
        </s-button>
        <s-button variant="tertiary" onClick={() => setOpen(false)}>
          Close
        </s-button>
      </div>
      {list.data?.error && <div style={{ color: "#b42318", fontSize: "13px" }}>{list.data.error}</div>}
      {imp.data?.error && <div style={{ color: "#b42318", fontSize: "13px" }}>{imp.data.error}</div>}
      {loading && !rows && <div style={small}>Reading Ordoro…</div>}
      {rows && (
        <div style={{ maxHeight: "360px", overflow: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Ordoro batch", "Notes", "Orders", "Created", "Here", ""].map((h) => (
                  <th key={h} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.ref}>
                  <td style={{ ...cell, fontWeight: 600 }}>{b.ref}</td>
                  <td style={cell}>{b.notes ?? "—"}</td>
                  <td style={cell}>{b.orders}</td>
                  <td style={cell}>{b.createdAt ? fmtDate(b.createdAt) : "—"}</td>
                  <td style={cell}>{b.here ? `${b.here.tag}${b.here.status === "cancelled" ? " (cancelled)" : ""}` : <span style={small}>Not yet</span>}</td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    <s-button
                      variant={b.here ? "secondary" : "primary"}
                      disabled={disabled || imp.state !== "idle" || b.here?.status === "cancelled" || undefined}
                      onClick={() => imp.submit({ intent: "ordoroImport", refs: JSON.stringify([b.ref]) }, { method: "post" })}
                    >
                      {b.here ? "Refresh" : "Import"}
                    </s-button>
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td style={cell} colSpan={6}>
                    <span style={small}>{rows.length ? "No match." : "No active batches in Ordoro."}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// On an imported batch's page: the hold, and each thing that didn't line up
export function OrdoroBatchPanel({ batch, canReconcile }) {
  const o = batch.ordoro;
  const [showDone, setShowDone] = useState(false);
  if (!o) return null;
  const open = o.issues.filter((x) => x.status === "open");
  const blocking = open.filter((x) => x.blocking);
  const notes = open.filter((x) => !x.blocking);
  const done = o.issues.filter((x) => x.status !== "open");
  return (
    <div style={{ margin: "0 0 14px" }}>
      <div style={{ ...small, marginBottom: "8px" }}>
        Imported from Ordoro batch <strong>{o.ref}</strong>
        {o.info?.importedAt ? ` on ${fmtDate(o.info.importedAt)}` : ""}
        {o.info?.importedBy ? ` by ${o.info.importedBy}` : ""}
        {o.info?.refreshedAt && o.info.refreshedAt !== o.info.importedAt ? ` · refreshed ${ago(o.info.refreshedAt)}` : ""}
        {o.info?.orders != null ? ` · ${o.info.orders} orders in Ordoro` : ""}
      </div>
      {o.locked && (
        <div role="alert" style={{ padding: "12px", border: "1px solid #f3b4ab", background: "#fff4f4", borderRadius: "10px", marginBottom: "10px" }}>
          <div style={{ fontWeight: 700, color: "#8e1f0b" }}>{o.locked}</div>
          <div style={{ ...small, margin: "4px 0 8px" }}>
            Nothing can be picked, packed, labelled or completed on this batch until each one below is sorted. For each: fulfil it in Shopify with
            Ordoro's tracking if it really went, then Check again; or take it out of the batch if it didn't; or, if it's been dealt with another way,
            mark it reconciled with a note saying what was done.
          </div>
          <IssueList issues={blocking} canReconcile={canReconcile} />
        </div>
      )}
      {notes.length > 0 && (
        <div style={{ padding: "10px 12px", border: "1px solid #f1c48b", background: "#fff8ef", borderRadius: "10px", marginBottom: "10px" }}>
          <div style={{ fontWeight: 700, color: "#7a3d00", marginBottom: "6px" }}>
            {notes.length} thing{notes.length === 1 ? "" : "s"} that didn't line up (not holding the batch)
          </div>
          <IssueList issues={notes} canReconcile={canReconcile} />
        </div>
      )}
      {done.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowDone((v) => !v)} style={{ all: "unset", cursor: "pointer", color: "#005bd3", fontSize: "13px" }}>
            {showDone ? "Hide" : "Show"} {done.length} sorted
          </button>
          {showDone && (
            <div style={{ marginTop: "6px" }}>
              <IssueList issues={done} canReconcile={canReconcile} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IssueList({ issues, canReconcile }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {issues.map((x) => (
        <Issue key={x.id} x={x} canReconcile={canReconcile} />
      ))}
    </div>
  );
}

function Issue({ x, canReconcile }) {
  const f = useFetcher();
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");
  const busy = f.state !== "idle";
  const result = f.data?.issueId === x.id ? f.data : null;
  useEffect(() => {
    if (result?.ok && result.intent === "ordoroReconcile") setWriting(false);
  }, [result]);
  return (
    <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: "8px", padding: "8px 10px", fontSize: "13px" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        {x.orderName && x.orderId ? <OrderLink orderId={x.orderId} orderNumber={x.orderName.replace("#", "")} name={x.orderName} /> : <strong>{x.orderName ?? x.orderNumber}</strong>}
        {x.orderNumber !== x.orderName?.replace("#", "") && <span style={small}>Ordoro {x.orderNumber}</span>}
        <span style={pill(x.blocking ? "#fde7e9" : "#fff1d6", x.blocking ? "#8e1f0b" : "#7a3d00")}>{x.label}</span>
        {x.status === "fixed" && <span style={pill("#e3f1df", "#1a5e20")}>Now matches</span>}
        {x.status === "reconciled" && <span style={pill("#e3f1df", "#1a5e20")}>Reconciled</span>}
      </div>
      <div style={{ marginTop: "4px" }}>{x.detail}</div>
      {x.status === "reconciled" && (
        <div style={{ ...small, marginTop: "2px" }}>
          {x.resolvedBy ?? "Someone"} {x.resolvedAt ? ago(x.resolvedAt) : ""}: {x.note}
        </div>
      )}
      {canReconcile && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" }}>
          {x.status === "open" && (
            <s-button
              onClick={() => f.submit({ intent: "ordoroRecheck", issueId: String(x.id) }, { method: "post" })}
              {...(busy && f.formData?.get("intent") === "ordoroRecheck" ? { loading: true } : {})}
            >
              Check again
            </s-button>
          )}
          {x.status === "open" && !writing && (
            <s-button variant="tertiary" onClick={() => setWriting(true)}>
              Mark reconciled…
            </s-button>
          )}
          {x.status === "reconciled" && (
            <s-button variant="tertiary" onClick={() => f.submit({ intent: "ordoroReopen", issueId: String(x.id) }, { method: "post" })}>
              Reopen
            </s-button>
          )}
          {result?.intent === "ordoroRecheck" && result.ok && (
            <span style={{ ...small, color: result.status === "open" ? "#7a3d00" : "#1a5e20" }}>
              {result.status === "open" ? "Still doesn't match." : "Matches now."}
            </span>
          )}
        </div>
      )}
      {writing && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginTop: "6px" }}>
          <input
            aria-label={`What was done for ${x.orderName ?? x.orderNumber}`}
            placeholder="What was done (e.g. fulfilled in Shopify with Ordoro's tracking)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{ flex: "1 1 320px", padding: "6px 8px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "13px" }}
          />
          <s-button
            variant="primary"
            disabled={note.trim().length < 5 || undefined}
            onClick={() => f.submit({ intent: "ordoroReconcile", issueId: String(x.id), note }, { method: "post" })}
            {...(busy ? { loading: true } : {})}
          >
            Save
          </s-button>
          <s-button variant="tertiary" onClick={() => setWriting(false)}>
            Cancel
          </s-button>
        </div>
      )}
      {result?.error && <div style={{ color: "#b42318", marginTop: "4px" }}>{result.error}</div>}
    </div>
  );
}

