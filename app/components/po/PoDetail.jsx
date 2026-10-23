import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { Err, StatusPill, box, cell, dayValue, fmtDate, head, input, money, muted, num, pill } from "./ui";
import { RECEIVE_ADDS_STOCK } from "../../po-template";

const EVENT_TEXT = { created: "Created", edited: "Edited", matched: "Matched to Shopify", status: "Status", emailed: "Emailed", exported: "Exported", received: "Received", checkedIn: "Checked in (Receiving)", checkInUndone: "Check-in undone" };

// Saves a base64 PDF from the server
function downloadPdf(filename, b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return url;
}

function useDone(fetcher, fn) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      fn?.(fetcher.data);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
}

export function PoDetail() {
  const { po, notes, events, caps, suppliers, locations, bcc } = useLoaderData();
  const [, setParams] = useSearchParams();
  const action = useFetcher();
  const pdf = useFetcher();
  const preview = useFetcher();
  const [confirm, setConfirm] = useState(null); // "close" | "delete"
  const [emailOpen, setEmailOpen] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  useDone(action, (d) => {
    setConfirm(null);
    if (d.deleted) setParams({});
  });
  useEffect(() => {
    if (pdf.state === "idle" && pdf.data?.ok && pdf.data.data) setPdfUrl(downloadPdf(pdf.data.filename, pdf.data.data));
  }, [pdf.state, pdf.data]);
  const revalidator = useRevalidator();
  useEffect(() => {
    if (pdf.state === "idle" && pdf.data?.ok) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf.state, pdf.data]);

  const editable = caps.generate && po.status !== "closed";
  const setStatus = (to) => action.submit({ intent: "status", id: String(po.id), to }, { method: "post" });

  return (
    <>
      <s-section>
        <button type="button" onClick={() => setParams({})} style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", marginBottom: "8px" }}>
          ← All purchase orders
        </button>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
          <h2 style={{ margin: 0, fontSize: "22px" }}>{po.poNumber}</h2>
          <StatusPill status={po.status} />
          <span style={muted}>
            {po.supplierName ?? "No supplier"} · {money(po.total, po.currency)} · created {fmtDate(po.createdAt)}
            {po.createdBy ? ` by ${po.createdBy}` : ""}
            {po.externalRef ? ` · ${po.externalRef}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <s-button
            variant="tertiary"
            onClick={() => {
              setShowPreview(true);
              preview.submit({ intent: "preview", id: String(po.id) }, { method: "post" });
            }}
          >
            Preview
          </s-button>
          {caps.export && (
            <s-button onClick={() => pdf.submit({ intent: "pdf", id: String(po.id) }, { method: "post" })} {...(pdf.state !== "idle" ? { loading: true } : {})}>
              Export PDF
            </s-button>
          )}
          {caps.email && (
            <s-button variant="primary" onClick={() => setEmailOpen((o) => !o)}>
              {po.sentAt ? "Email again" : "Email to supplier"}
            </s-button>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "10px" }}>
          {caps.generate && po.status === "pending" && (
            <s-button variant="tertiary" onClick={() => setStatus("open")}>
              Mark as open (sent another way)
            </s-button>
          )}
          {caps.generate && po.status === "open" && !po.sentAt && !po.exportedAt && (
            <s-button variant="tertiary" onClick={() => setStatus("pending")}>
              Back to pending
            </s-button>
          )}
          {caps.generate && ["open", "partial", "received"].includes(po.status) &&
            (confirm === "close" ? (
              <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", padding: "4px 10px", borderRadius: "8px", background: "#f3f3f3" }}>
                {po.status === "received" ? "Close this PO?" : "Close it without receiving the rest?"}
                <s-button onClick={() => setStatus("closed")}>Close PO</s-button>
                <s-button variant="tertiary" onClick={() => setConfirm(null)}>
                  Cancel
                </s-button>
              </span>
            ) : (
              <s-button variant={po.status === "received" ? "primary" : "tertiary"} onClick={() => setConfirm("close")}>
                Close PO
              </s-button>
            ))}
          {caps.generate && po.status === "closed" && (
            <s-button variant="tertiary" onClick={() => setStatus("reopen")}>
              Reopen
            </s-button>
          )}
          {caps.generate && po.status === "pending" &&
            (confirm === "delete" ? (
              <span style={{ display: "inline-flex", gap: "8px", alignItems: "center", padding: "4px 10px", borderRadius: "8px", background: "#fde7e9" }}>
                Delete {po.poNumber}?
                <s-button tone="critical" onClick={() => action.submit({ intent: "delete", id: String(po.id) }, { method: "post" })}>
                  Delete
                </s-button>
                <s-button variant="tertiary" onClick={() => setConfirm(null)}>
                  Keep
                </s-button>
              </span>
            ) : (
              <s-button variant="tertiary" tone="critical" onClick={() => setConfirm("delete")}>
                Delete
              </s-button>
            ))}
          <span style={muted}>
            {po.sentAt && `Emailed ${fmtDate(po.sentAt, true)} to ${po.sentTo}. `}
            {po.exportedAt && `Exported ${fmtDate(po.exportedAt, true)}.`}
          </span>
        </div>
        <Err data={action.data} />
        <Err data={pdf.data} />
        {pdfUrl && pdf.state === "idle" && (
          <div style={{ ...muted, marginTop: "6px" }}>
            PDF downloaded.{" "}
            <a href={pdfUrl} target="_blank" rel="noreferrer">
              Open it
            </a>{" "}
            if it didn't save.
          </div>
        )}
      </s-section>

      {emailOpen && caps.email && <EmailPanel po={po} bcc={bcc} onClose={() => setEmailOpen(false)} />}

      {showPreview && (
        <s-section heading="Preview">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "6px" }}>
            <s-button variant="tertiary" onClick={() => setShowPreview(false)}>
              Hide preview
            </s-button>
          </div>
          {preview.data?.html ? (
            <iframe title="PO preview" srcDoc={preview.data.html} sandbox="" style={{ width: "100%", height: "720px", border: "1px solid #e3e3e3", borderRadius: "8px", background: "#fff" }} />
          ) : (
            <span style={muted}>{preview.data?.error ?? "Loading…"}</span>
          )}
        </s-section>
      )}

      <Details po={po} suppliers={suppliers} locations={locations} editable={editable} />
      {caps.generate && ["pending", "open", "partial"].includes(po.status) && po.lines.some((l) => l.received < l.quantity) && <Receive po={po} />}
      <Lines po={po} editable={caps.generate && po.status === "pending"} canMatch={caps.generate && po.status !== "closed"} />
      <Notes poId={po.id} notes={notes} canWrite={caps.generate} />

      <s-section heading="Activity">
        {events.map((e) => (
          <div key={e.id} style={{ display: "flex", gap: "10px", padding: "4px 0", borderBottom: "1px solid #f0f0f0", fontSize: "13px" }}>
            <span style={{ ...muted, width: "150px", flexShrink: 0 }}>{fmtDate(e.at, true)}</span>
            <span style={{ flex: 1 }}>
              <strong>{EVENT_TEXT[e.type] ?? e.type}</strong>
              {e.detail ? ` · ${e.detail}` : ""}
              {e.by && <span style={muted}> · {e.by}</span>}
            </span>
          </div>
        ))}
      </s-section>
    </>
  );
}

function EmailPanel({ po, bcc, onClose }) {
  const defaults = useFetcher();
  const sender = useFetcher();
  const [f, setF] = useState(null);
  const [picked, setPicked] = useState([]);
  const contacts = defaults.data?.contacts ?? [];
  const names = (emails) =>
    contacts
      .filter((c) => emails.includes(c.email) && c.name)
      .map((c) => c.name)
      .join(" and ");
  // Choosing who gets it: rebuilds To (keeping any other addresses typed there), and swaps the names in the greeting
  const pick = (email, on) => {
    const next = on ? [...picked, email] : picked.filter((e) => e !== email);
    const others = f.to
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter((e) => e && !contacts.some((c) => c.email === e.toLowerCase()));
    const before = names(picked);
    const after = names(next);
    setPicked(next);
    setF({
      ...f,
      to: [...contacts.filter((c) => next.includes(c.email)).map((c) => c.email), ...others].join(", "),
      body: before && after && before !== after ? f.body.split(before).join(after) : f.body,
    });
  };
  useEffect(() => {
    defaults.submit({ intent: "emailDefaults", id: String(po.id) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po.id]);
  useEffect(() => {
    if (defaults.data?.intent === "emailDefaults" && !defaults.data.error && !f) {
      const d = defaults.data;
      setF({ to: d.to, cc: "", subject: d.subject, body: d.body });
      setPicked((d.contacts ?? []).filter((c) => c.getsPo).map((c) => c.email));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaults.data]);
  useDone(sender);
  const sent = sender.state === "idle" && sender.data?.ok;
  const row = { display: "grid", gridTemplateColumns: "90px 1fr", gap: "8px", alignItems: "center", marginBottom: "8px" };
  return (
    <s-section heading={`Email ${po.poNumber}`}>
      {defaults.data?.error && <Err data={defaults.data} />}
      {!f && !defaults.data?.error && <span style={muted}>Loading…</span>}
      {f && !sent && (
        <>
          {contacts.length > 0 && (
            <div style={{ ...row, alignItems: "start" }}>
              <span>Send to</span>
              <div style={{ display: "grid", gap: "4px" }}>
                {contacts.map((c) => (
                  <label key={c.email} style={{ display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
                    <input type="checkbox" checked={picked.includes(c.email)} onChange={(e) => pick(c.email, e.target.checked)} />
                    <span>
                      <strong>{c.name || c.email}</strong>
                      {c.role ? ` (${c.role})` : ""}
                      {c.name ? <span style={muted}> · {c.email}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div style={row}>
            <span>To</span>
            <input value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="supplier@example.com" style={{ ...input, width: "100%" }} />
          </div>
          <div style={row}>
            <span>Cc</span>
            <input value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} placeholder="Optional" style={{ ...input, width: "100%" }} />
          </div>
          <div style={row}>
            <span>Bcc</span>
            <span style={{ ...input, width: "100%", background: "#f3f3f3", color: "#4a4a4a" }} title="Every PO email is copied here. It can't be changed.">
              {bcc} <span style={muted}>(always)</span>
            </span>
          </div>
          <div style={row}>
            <span>Subject</span>
            <input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ ...row, alignItems: "start" }}>
            <span>Message</span>
            <textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} rows={9} style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ ...row }}>
            <span />
            <span style={muted}>📎 {po.poNumber}.pdf is attached.{po.status === "pending" ? " Sending opens the PO." : ""}</span>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <s-button
              variant="primary"
              onClick={() => sender.submit({ intent: "email", id: String(po.id), ...f }, { method: "post" })}
              {...(sender.state !== "idle" ? { loading: true } : {})}
            >
              Send
            </s-button>
            <s-button variant="tertiary" onClick={onClose}>
              Cancel
            </s-button>
          </div>
          <Err data={sender.data} />
        </>
      )}
      {sent && (
        <div style={{ color: "#1a5e20" }}>
          ✓ Sent to {sender.data.to.join(", ")}
          {sender.data.cc.length ? `, cc ${sender.data.cc.join(", ")}` : ""}, bcc {sender.data.bcc}.{" "}
          <s-button variant="tertiary" onClick={onClose}>
            Done
          </s-button>
        </div>
      )}
    </s-section>
  );
}

function Details({ po, suppliers, locations, editable }) {
  const fetcher = useFetcher();
  const init = () => ({ supplierId: po.supplierId ? String(po.supplierId) : "", locationId: po.locationId ?? "", expectedAt: dayValue(po.expectedAt), supplierNote: po.supplierNote ?? "" });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [po.id, po.supplierId, po.locationId, po.expectedAt, po.supplierNote]); // eslint-disable-line react-hooks/exhaustive-deps
  useDone(fetcher);
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const canMoveLocation = ["pending", "open"].includes(po.status);
  return (
    <s-section heading="Details">
      <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <label>
          <div style={muted}>Supplier</div>
          <select value={f.supplierId} disabled={!editable} onChange={(e) => setF({ ...f, supplierId: e.target.value })} style={{ ...input, width: "100%" }}>
            <option value="">—</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div style={muted}>{po.supplierEmails ?? "No email"}</div>
        </label>
        <label>
          <div style={muted}>Receive at</div>
          <select value={f.locationId} disabled={!editable || !canMoveLocation} onChange={(e) => setF({ ...f, locationId: e.target.value })} style={{ ...input, width: "100%" }}>
            {!locations.some((l) => l.id === f.locationId) && <option value={f.locationId}>{po.locationName ?? "—"}</option>}
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <div style={muted}>Expected by</div>
          <input type="date" value={f.expectedAt} disabled={!editable} onChange={(e) => setF({ ...f, expectedAt: e.target.value })} style={{ ...input, width: "100%" }} />
        </label>
      </div>
      <label style={{ display: "block", marginTop: "10px" }}>
        <div style={muted}>Note for the supplier (printed on the PO)</div>
        <textarea value={f.supplierNote} disabled={!editable} onChange={(e) => setF({ ...f, supplierNote: e.target.value })} rows={2} style={{ ...input, width: "100%" }} />
      </label>
      {editable && dirty && (
        <div style={{ marginTop: "8px" }}>
          <s-button
            variant="primary"
            onClick={() =>
              fetcher.submit(
                { intent: "update", id: String(po.id), supplierId: f.supplierId, expectedAt: f.expectedAt, supplierNote: f.supplierNote, ...(f.locationId !== (po.locationId ?? "") ? { locationId: f.locationId } : {}) },
                { method: "post" },
              )
            }
            {...(fetcher.state !== "idle" ? { loading: true } : {})}
          >
            Save details
          </s-button>
        </div>
      )}
      <Err data={fetcher.data} />
    </s-section>
  );
}

function Lines({ po, editable, canMatch }) {
  const saver = useFetcher();
  const matcher = useFetcher();
  const toEdit = () => po.lines.map((l) => ({ ...l, quantity: String(l.quantity), unitCost: String(l.unitCost), taxRate: String(l.taxRate), tax: String(l.tax), taxOverride: false }));
  const [rows, setRows] = useState(toEdit);
  const checkedIn = po.lines.some((l) => (l.checkedIn ?? 0) > 0);
  useEffect(() => setRows(toEdit()), [po]); // eslint-disable-line react-hooks/exhaustive-deps
  useDone(saver);
  useDone(matcher);
  const dirty = editable && JSON.stringify(rows.map(({ taxOverride, ...r }) => r)) !== JSON.stringify(toEdit().map(({ taxOverride, ...r }) => r));
  const unmatched = po.lines.filter((l) => !l.matched).length;
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const calc = (r) => {
    const net = Math.round(Number(r.quantity) * Number(r.unitCost) * 100) / 100 || 0;
    const tax = r.taxOverride ? Number(r.tax) || 0 : Math.round(net * (Number(r.taxRate) || 0)) / 100;
    return { tax, total: Math.round((net + tax) * 100) / 100 };
  };
  const cellInput = { ...input, padding: "3px 6px", width: "100%" };
  return (
    <s-section heading={`Lines (${po.lines.length})`}>
      {unmatched > 0 && (
        <div style={{ marginBottom: "8px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <span style={pill("#fff4d6", "#7a4f01")}>
            {unmatched} line{unmatched === 1 ? "" : "s"} not found in Shopify
          </span>
          <span style={muted}>Matched by SKU, then barcode.{RECEIVE_ADDS_STOCK ? " Unmatched lines can still be received, but won't add stock." : ""}</span>
          {canMatch && (
            <s-button variant="tertiary" onClick={() => matcher.submit({ intent: "rematch", id: String(po.id) }, { method: "post" })} {...(matcher.state !== "idle" ? { loading: true } : {})}>
              Look again
            </s-button>
          )}
        </div>
      )}
      <div style={{ ...box, maxHeight: "560px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
          <thead>
            <tr>
              <th style={head}>#</th>
              <th style={head}>SKU</th>
              <th style={head}>Supplier code</th>
              <th style={head}>Supplier barcode</th>
              <th style={head}>Title</th>
              <th style={{ ...head, textAlign: "right" }}>Qty</th>
              <th style={{ ...head, textAlign: "right" }}>Unit cost</th>
              <th style={{ ...head, textAlign: "right" }}>Tax rate</th>
              <th style={{ ...head, textAlign: "right" }}>Tax</th>
              <th style={{ ...head, textAlign: "right" }}>Total</th>
              {!editable && <th style={{ ...head, textAlign: "right" }}>Received</th>}
              {!editable && checkedIn && (
                <th style={{ ...head, textAlign: "right" }} title="Counted in on the Receiving page (doesn't change stock)">
                  Checked in
                </th>
              )}
              {editable && <th style={head} />}
            </tr>
          </thead>
          <tbody>
            {(editable ? rows : po.lines).map((l, i) => {
              const c = editable ? calc(l) : l;
              return (
                <tr key={l.id ?? `n${i}`} style={{ background: !editable && l.received >= l.quantity ? "#f3faf1" : undefined }}>
                  <td style={{ ...cell, ...muted }}>{i + 1}</td>
                  {["sku", "supplierCode", "supplierBarcode"].map((k) => (
                    <td key={k} style={cell}>
                      {editable ? <input value={l[k] ?? ""} onChange={(e) => set(i, { [k]: e.target.value })} style={{ ...cellInput, minWidth: "90px" }} /> : l[k] ?? "—"}
                    </td>
                  ))}
                  <td style={{ ...cell, minWidth: "200px" }}>
                    {editable ? <input value={l.title} onChange={(e) => set(i, { title: e.target.value })} style={cellInput} /> : l.title}
                    {l.id && !editable && (l.matched ? <div style={muted}>✓ {l.shopifyTitle}</div> : <div style={{ ...muted, color: "#7a4f01" }}>Not found in Shopify</div>)}
                  </td>
                  <td style={num}>{editable ? <input value={l.quantity} inputMode="numeric" onChange={(e) => set(i, { quantity: e.target.value })} style={{ ...cellInput, width: "70px", textAlign: "right" }} /> : l.quantity.toLocaleString()}</td>
                  <td style={num}>{editable ? <input value={l.unitCost} inputMode="decimal" onChange={(e) => set(i, { unitCost: e.target.value })} style={{ ...cellInput, width: "90px", textAlign: "right" }} /> : money(l.unitCost, po.currency)}</td>
                  <td style={num}>
                    {editable ? (
                      <input value={l.taxRate} inputMode="decimal" onChange={(e) => set(i, { taxRate: e.target.value, taxOverride: false })} style={{ ...cellInput, width: "70px", textAlign: "right" }} />
                    ) : (
                      `${l.taxRate}%`
                    )}
                  </td>
                  <td style={num}>
                    {editable ? (
                      <input
                        value={l.taxOverride ? l.tax : String(c.tax)}
                        inputMode="decimal"
                        title="Type to override the worked-out tax"
                        onChange={(e) => set(i, { tax: e.target.value, taxOverride: true })}
                        style={{ ...cellInput, width: "80px", textAlign: "right" }}
                      />
                    ) : (
                      money(l.tax, po.currency)
                    )}
                  </td>
                  <td style={{ ...num, fontWeight: 600 }}>{money(c.total, po.currency)}</td>
                  {!editable && (
                    <td style={num}>
                      {l.received}/{l.quantity}
                    </td>
                  )}
                  {!editable && checkedIn && (
                    <td style={{ ...num, color: l.checkedIn > l.quantity ? "#b42318" : undefined }}>
                      {l.checkedIn}/{l.quantity}
                    </td>
                  )}
                  {editable && (
                    <td style={cell}>
                      <s-button variant="tertiary" tone="critical" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                        Remove
                      </s-button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...cell, fontWeight: 600 }} colSpan={5}>
                Totals
              </td>
              <td style={{ ...num, fontWeight: 600 }}>{po.lines.reduce((t, l) => t + l.quantity, 0).toLocaleString()}</td>
              <td style={num} colSpan={2}>
                Subtotal {money(po.subtotal, po.currency)}
              </td>
              <td style={num}>{money(po.taxTotal, po.currency)}</td>
              <td style={{ ...num, fontWeight: 700 }}>{money(po.total, po.currency)}</td>
              {!editable && <td style={num}>{po.lines.reduce((t, l) => t + l.received, 0).toLocaleString()}</td>}
              {!editable && checkedIn && <td style={num}>{po.lines.reduce((t, l) => t + (l.checkedIn ?? 0), 0).toLocaleString()}</td>}
              {editable && <td style={cell} />}
            </tr>
          </tfoot>
        </table>
      </div>
      {editable && (
        <div style={{ display: "flex", gap: "8px", marginTop: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <s-button
            variant="tertiary"
            onClick={() => setRows([...rows, { sku: "", supplierCode: "", supplierBarcode: "", title: "", quantity: "1", unitCost: "0", taxRate: rows[rows.length - 1]?.taxRate ?? "0", tax: "0", taxOverride: false }])}
          >
            + Add a line
          </s-button>
          {dirty && (
            <s-button
              variant="primary"
              onClick={() =>
                saver.submit(
                  { intent: "update", id: String(po.id), lines: JSON.stringify(rows.map((r) => ({ ...r, tax: r.taxOverride ? r.tax : undefined }))) },
                  { method: "post" },
                )
              }
              {...(saver.state !== "idle" ? { loading: true } : {})}
            >
              Save lines
            </s-button>
          )}
          <span style={muted}>Lines can be changed while the PO is pending.</span>
        </div>
      )}
      <Err data={saver.data} />
    </s-section>
  );
}

function Receive({ po }) {
  const fetcher = useFetcher();
  const [counts, setCounts] = useState({});
  const [scan, setScan] = useState("");
  const [msg, setMsg] = useState(null);
  const scanRef = useRef(null);
  useDone(fetcher, (d) => {
    setCounts({});
    setMsg({ ok: true, text: `Received ${d.units} unit${d.units === 1 ? "" : "s"}${d.stockChanged === false ? " (recorded only: stock in Shopify wasn't changed)" : d.notStocked ? ` (${d.notStocked} not in Shopify, so no stock added)` : ""}.` });
  });
  const open = po.lines.filter((l) => l.received < l.quantity);
  const total = Object.values(counts).reduce((t, n) => t + (Number(n) || 0), 0);
  const index = useMemo(() => po.lines, [po.lines]);
  const onScan = (e) => {
    e.preventDefault();
    const c = scan.trim().toLowerCase();
    setScan("");
    if (!c) return;
    const hit = (l) => [l.sku, l.supplierBarcode, l.supplierCode].some((v) => v && String(v).trim().toLowerCase() === c);
    const l = index.find((x) => hit(x) && x.received + (Number(counts[x.id]) || 0) < x.quantity) ?? index.find(hit);
    if (!l) return setMsg({ ok: false, text: `${scan.trim()} isn't on this PO.` });
    const now = Number(counts[l.id]) || 0;
    if (l.received + now >= l.quantity) return setMsg({ ok: false, text: `${l.title}: all ${l.quantity} already counted.` });
    setCounts({ ...counts, [l.id]: now + 1 });
    setMsg({ ok: true, text: `${l.title}: ${l.received + now + 1} of ${l.quantity}` });
  };
  return (
    <s-section heading="Receive">
      <div style={{ ...muted, marginBottom: "8px" }}>
        Scan items (SKU or supplier barcode), or type how many arrived.{" "}
        {RECEIVE_ADDS_STOCK
          ? `Receiving adds them to stock at ${po.locationName ?? "the PO's location"} in Shopify.`
          : "For now this only records what arrived: stock in Shopify isn't changed."}
      </div>
      <form onSubmit={onScan} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
        <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} placeholder="Scan a barcode" aria-label="Scan" autoComplete="off" style={{ ...input, width: "260px", fontSize: "15px" }} />
        <s-button variant="tertiary" onClick={() => setCounts(Object.fromEntries(open.map((l) => [l.id, l.quantity - l.received])))}>
          Everything that's left arrived
        </s-button>
        {msg && <span style={{ color: msg.ok ? "#1a5e20" : "#b42318", fontWeight: 600 }}>{msg.text}</span>}
      </form>
      <div style={{ ...box, maxHeight: "420px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
          <thead>
            <tr>
              <th style={head}>Item</th>
              <th style={{ ...head, textAlign: "right" }}>Ordered</th>
              <th style={{ ...head, textAlign: "right" }}>Received</th>
              <th style={{ ...head, textAlign: "right" }}>Arrived now</th>
            </tr>
          </thead>
          <tbody>
            {open.map((l) => (
              <tr key={l.id}>
                <td style={cell}>
                  {l.title}
                  <div style={muted}>{[l.sku, l.supplierBarcode].filter(Boolean).join(" · ")}</div>
                  {RECEIVE_ADDS_STOCK && !l.matched && <div style={{ ...muted, color: "#7a4f01" }}>Not in Shopify: no stock will be added</div>}
                </td>
                <td style={num}>{l.quantity}</td>
                <td style={num}>{l.received}</td>
                <td style={num}>
                  <input
                    value={counts[l.id] ?? ""}
                    inputMode="numeric"
                    placeholder="0"
                    onChange={(e) => setCounts({ ...counts, [l.id]: e.target.value.replace(/[^\d]/g, "") })}
                    style={{ ...input, width: "80px", textAlign: "right" }}
                    aria-label={`Arrived now: ${l.title}`}
                  />
                  <div style={muted}>of {l.quantity - l.received}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", gap: "8px", marginTop: "10px", alignItems: "center" }}>
        <s-button
          variant="primary"
          onClick={() => fetcher.submit({ intent: "receive", id: String(po.id), counts: JSON.stringify(counts) }, { method: "post" })}
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          {...(!total ? { disabled: true } : {})}
        >
          {RECEIVE_ADDS_STOCK ? `Receive ${total ? `${total} unit${total === 1 ? "" : "s"} ` : ""}into stock` : `Mark ${total ? `${total} unit${total === 1 ? "" : "s"} ` : ""}received`}
        </s-button>
      </div>
      <Err data={fetcher.data} />
    </s-section>
  );
}

function Notes({ poId, notes, canWrite }) {
  const adder = useFetcher();
  const remover = useFetcher();
  const [body, setBody] = useState("");
  useDone(adder, () => setBody(""));
  useDone(remover);
  return (
    <s-section heading="Private notes">
      <div style={{ ...muted, marginBottom: "8px" }}>Only staff see these. They're never on the PO or in emails.</div>
      {canWrite && (
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginBottom: "10px" }}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder="Add a note" style={{ ...input, flex: 1 }} />
          <s-button onClick={() => adder.submit({ intent: "addNote", id: String(poId), body }, { method: "post" })} {...(adder.state !== "idle" ? { loading: true } : {})} {...(!body.trim() ? { disabled: true } : {})}>
            Add note
          </s-button>
        </div>
      )}
      <Err data={adder.data} />
      {notes.length === 0 && <span style={muted}>No notes yet.</span>}
      {notes.map((n) => (
        <div key={n.id} style={{ padding: "8px 10px", background: "#fffbea", border: "1px solid #f3e3a1", borderRadius: "8px", marginBottom: "6px" }}>
          <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
          <div style={{ ...muted, display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
            {n.by ?? "Staff"} · {fmtDate(n.at, true)}
            {canWrite && (
              <s-button variant="tertiary" tone="critical" onClick={() => remover.submit({ intent: "deleteNote", id: String(poId), noteId: String(n.id) }, { method: "post" })}>
                Delete
              </s-button>
            )}
          </div>
        </div>
      ))}
      <Err data={remover.data} />
    </s-section>
  );
}
