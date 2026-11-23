import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Flyout } from "./Flyout";
import { CONDITIONS, DECLINE_REASONS } from "../returns";

// Returns, shared by the order flyout and Shipping → Returns: a return's card
// (approve / decline a request, verify a package that arrived) and starting one.

export const RETURNS_ACTION = "/app/order-audit";
const small = { fontSize: "12px", color: "#616161" };
const heading = { fontSize: "12px", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#616161", margin: 0 };
const btn = { font: "inherit", fontSize: "13px", padding: "4px 12px", borderRadius: "8px", border: "1px solid #c9c9c9", background: "#fff", cursor: "pointer" };
const dark = { ...btn, background: "#1a1a1a", color: "#fff", border: "1px solid #1a1a1a" };
const field = { font: "inherit", fontSize: "13px", padding: "6px 8px", border: "1px solid #c9c9c9", borderRadius: "8px", boxSizing: "border-box" };
const linkBtn = { appearance: "none", background: "none", border: 0, padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", fontWeight: 600 };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", background: bg, color: fg, fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });

export const STAGE_PILL = {
  requested: ["#fff1d6", "#7a4f01"],
  awaiting: ["#e0f0ff", "#00427c"],
  verified: ["#d9f2df", "#1a5e20"],
  closed: ["#f1f1f1", "#4a4a4a"],
  declined: ["#fde2dd", "#8e1f0b"],
  cancelled: ["#f1f1f1", "#6b6b6b"],
};
const COND_COLOR = { resellable: "#1a5e20", damaged: "#8e1f0b", wrong_item: "#8e1f0b", missing: "#8e1f0b" };

const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "";

// One return: what's coming back, where it is, and what to do next
export function ReturnCard({ r, canReturns, onChanged, showOrder = false, onOpenOrder }) {
  const f = useFetcher();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("OTHER");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const busy = f.state !== "idle";
  const done = f.data?.ok ? f.data : null;
  useEffect(() => {
    if (done) {
      setDeclining(false);
      onChanged?.();
    }
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = (intent, extra = {}) => f.submit({ intent, returnId: String(r.id), notify: notify ? "1" : "0", ...extra }, { method: "post", action: RETURNS_ACTION });
  const [bg, fg] = STAGE_PILL[r.stage] ?? STAGE_PILL.closed;
  return (
    <div style={{ display: "grid", gap: "8px", border: "1px solid #e3e3e3", borderRadius: "8px", padding: "10px 12px", fontSize: "13px" }}>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <strong>{r.name ?? "Return"}</strong>
        <span style={pill(bg, fg)}>{r.stageLabel}</span>
        <span style={small}>{r.sourceLabel}</span>
        <span style={{ ...small, marginLeft: "auto" }}>{when(r.requestedAt)}</span>
      </div>
      {showOrder && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "baseline" }}>
          {onOpenOrder ? (
            <button type="button" style={linkBtn} onClick={() => onOpenOrder(r.orderId)}>
              {r.orderName}
            </button>
          ) : (
            <strong>{r.orderName}</strong>
          )}
          {r.customerName && <span>· {r.customerName}</span>}
        </div>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "4px" }}>
        {r.items.map((it) => (
          <li key={it.returnLineItemId} style={{ display: "grid", gap: "1px" }}>
            <span>
              {it.quantity} × {it.title}
              {it.variantTitle ? ` (${it.variantTitle})` : ""}
              {it.sku ? <span style={small}> · {it.sku}</span> : null}
            </span>
            {(it.reason || it.reasonNote) && <span style={small}>Reason: {[it.reason, it.reasonNote].filter(Boolean).join(" · ")}</span>}
            {it.customerNote && <span style={small}>Customer says: “{it.customerNote}”</span>}
            {it.found?.length > 0 && (
              <span style={{ fontSize: "12px", fontWeight: 600 }}>
                {it.found.map((x, i) => (
                  <span key={i} style={{ color: COND_COLOR[x.condition], marginRight: "8px" }}>
                    {x.quantity} {CONDITIONS[x.condition]?.label.toLowerCase() ?? x.condition}
                  </span>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {(r.reason || r.note) && r.source === "staff" && (
        <span style={small}>
          Why: {r.reason}
          {r.note ? ` · ${r.note}` : ""}
        </span>
      )}
      {r.approvedBy && <span style={small}>Approved by {r.approvedBy}{r.approvedAt ? ` · ${when(r.approvedAt)}` : ""}</span>}
      {r.declineNote && <span style={{ ...small, color: "#8e1f0b" }}>Declined: {r.declineNote}</span>}
      {r.verifiedAt && (
        <span style={{ ...small, color: "#1a5e20" }}>
          Verified by {r.verifiedBy ?? "staff"} · {when(r.verifiedAt)}
          {r.restocked ? ` · ${r.restocked} restocked` : " · nothing restocked"}
          {r.verifyNote ? ` · ${r.verifyNote}` : ""}
        </span>
      )}
      {r.stage === "verified" && <span style={small}>Refund it in Shopify if it hasn't been.</span>}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}

      {canReturns && r.stage === "requested" && !declining && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button type="button" style={dark} disabled={busy} onClick={() => send("approveReturn")}>
            {busy && f.formData?.get("intent") === "approveReturn" ? "Approving…" : "Approve request"}
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => setDeclining(true)}>
            Decline…
          </button>
          <label style={{ display: "flex", gap: "4px", alignItems: "center", ...small }}>
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer
          </label>
        </div>
      )}
      {canReturns && declining && (
        <div style={{ display: "grid", gap: "6px", padding: "8px", border: "1px solid #f3b5bd", background: "#fff8f8", borderRadius: "8px" }}>
          <label style={{ display: "grid", gap: "3px" }}>
            <span style={small}>Why it's declined</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)} style={field}>
              {Object.entries(DECLINE_REASONS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: "3px" }}>
            <span style={small}>Note for the customer{reason === "OTHER" ? " (required)" : ""}</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} style={{ ...field, resize: "vertical" }} />
          </label>
          <span style={{ display: "flex", gap: "8px" }}>
            <button type="button" style={{ ...dark, background: "#8e1f0b", borderColor: "#8e1f0b" }} disabled={busy || (reason === "OTHER" && !note.trim())} onClick={() => send("declineReturn", { reason, note })}>
              {busy ? "Declining…" : "Decline request"}
            </button>
            <button type="button" style={btn} disabled={busy} onClick={() => setDeclining(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {canReturns && r.stage === "awaiting" && (
        <div>
          <button type="button" style={dark} onClick={() => setVerifying(true)}>
            Package arrived: verify items
          </button>
        </div>
      )}
      {verifying && <VerifyFlyout r={r} onClose={() => setVerifying(false)} onDone={() => onChanged?.()} />}
    </div>
  );
}

// The package arrived: a condition for every unit
export function VerifyFlyout({ r, onClose, onDone }) {
  const f = useFetcher();
  // One row per unit, so two of an item can come back in different shape
  const units = r.items.flatMap((it) => Array.from({ length: Math.min(it.quantity, 50) }, (_, n) => ({ key: `${it.returnLineItemId}#${n}`, it, n })));
  const [cond, setCond] = useState({});
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const done = f.data?.ok ? f.data.ret : null;
  useEffect(() => {
    if (done) onDone?.();
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = units.every((u) => cond[u.key]);
  const restock = units.filter((u) => CONDITIONS[cond[u.key]]?.restock).length;
  const allSame = (c) => setCond(Object.fromEntries(units.map((u) => [u.key, c])));
  const submit = () => {
    const tally = new Map();
    for (const u of units) {
      const k = `${u.it.returnLineItemId}|${cond[u.key]}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    const found = [...tally].map(([k, quantity]) => {
      const [returnLineItemId, condition] = k.split("|");
      return { returnLineItemId, condition, quantity };
    });
    f.submit({ intent: "verifyReturn", returnId: String(r.id), found: JSON.stringify(found), note }, { method: "post", action: RETURNS_ACTION });
  };
  return (
    <Flyout onClose={onClose} label="Verify return" title={`Verify ${r.name ?? "return"}`} width={500} zIndex={1070}>
      <div style={{ display: "grid", gap: "12px", fontSize: "13px" }}>
        {done ? (
          <div style={{ display: "grid", gap: "6px", padding: "10px", borderRadius: "8px", background: "#eaf6ec" }}>
            <strong>Verified.</strong>
            <span>{done.restocked ? `${done.restocked} item${done.restocked === 1 ? "" : "s"} went back into stock.` : "Nothing was restocked."} Refund it in Shopify if it hasn't been.</span>
            <button type="button" style={{ ...btn, justifySelf: "start" }} onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <span style={small}>
              {r.orderName}
              {r.customerName ? ` · ${r.customerName}` : ""}. Mark what came back for each item.
            </span>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
              <span style={small}>Mark all:</span>
              {Object.entries(CONDITIONS).map(([k, c]) => (
                <button key={k} type="button" style={{ ...btn, fontSize: "12px", padding: "2px 8px" }} onClick={() => (allSame(k), setConfirming(false))}>
                  {c.label}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gap: "6px" }}>
              {units.map((u) => (
                <div key={u.key} style={{ display: "grid", gap: "6px", padding: "8px", border: "1px solid #eee", borderRadius: "8px" }}>
                  <span style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    {u.it.image && <img src={u.it.image} alt="" width={32} height={32} style={{ borderRadius: "4px", objectFit: "cover" }} />}
                    <span>
                      {u.it.title}
                      {u.it.variantTitle ? ` (${u.it.variantTitle})` : ""}
                      {u.it.quantity > 1 ? <span style={small}> · {u.n + 1} of {u.it.quantity}</span> : null}
                    </span>
                  </span>
                  {u.it.customerNote && <span style={small}>Customer says: “{u.it.customerNote}”</span>}
                  <span role="radiogroup" aria-label={`Condition of ${u.it.title}`} style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                    {Object.entries(CONDITIONS).map(([k, c]) => {
                      const on = cond[u.key] === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          onClick={() => (setCond({ ...cond, [u.key]: k }), setConfirming(false))}
                          style={{ ...btn, fontSize: "12px", padding: "3px 10px", ...(on ? { background: COND_COLOR[k], color: "#fff", border: `1px solid ${COND_COLOR[k]}` } : {}) }}
                        >
                          {c.label}
                        </button>
                      );
                    })}
                  </span>
                </div>
              ))}
            </div>
            <label style={{ display: "grid", gap: "3px" }}>
              <span style={small}>Note (optional)</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} style={{ ...field, resize: "vertical" }} />
            </label>
            {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
            {!confirming ? (
              <button type="button" style={{ ...dark, justifySelf: "start", opacity: all ? 1 : 0.5 }} disabled={!all} onClick={() => setConfirming(true)}>
                Verify
              </button>
            ) : (
              <div style={{ display: "grid", gap: "8px", padding: "10px", border: "1px solid #ecd58f", background: "#fffbea", borderRadius: "8px" }}>
                <span>
                  {restock ? `${restock} item${restock === 1 ? "" : "s"} will go back into stock.` : "Nothing will be restocked."} Shopify records the rest as damaged or missing. This can't be
                  changed afterwards.
                </span>
                <span style={{ display: "flex", gap: "8px" }}>
                  <button type="button" style={dark} disabled={f.state !== "idle"} onClick={submit}>
                    {f.state !== "idle" ? "Saving…" : "Yes, verify"}
                  </button>
                  <button type="button" style={btn} disabled={f.state !== "idle"} onClick={() => setConfirming(false)}>
                    Back
                  </button>
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Flyout>
  );
}

// Staff start a return for some of an order's shipped items
export function StartReturnFlyout({ orderId, onClose, onDone }) {
  const load = useFetcher();
  const save = useFetcher();
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [notify, setNotify] = useState(false);
  const submit = useRef(load.submit);
  submit.current = load.submit;
  useEffect(() => {
    submit.current({ intent: "returnable", orderId }, { method: "post", action: RETURNS_ACTION });
  }, [orderId]);
  const info = load.data?.intent === "returnable" ? load.data.info : null;
  const made = save.data?.intent === "startReturn" && save.data.ok ? save.data.made : null;
  useEffect(() => {
    if (made) onDone?.();
  }, [made]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = info ? info.items.filter((i) => Number(qty[i.fulfillmentLineItemId]) > 0) : [];
  const ready = chosen.length > 0 && reason && (reason !== "Other" || note.trim());
  return (
    <Flyout onClose={onClose} label="Start a return" title={info ? `Start a return · ${info.orderName}` : "Start a return"} width={500} zIndex={1060}>
      <div style={{ display: "grid", gap: "14px", fontSize: "13px" }}>
        {!info && !load.data?.error && <span style={small}>Loading…</span>}
        {load.data?.error && <span style={{ color: "#8e1f0b" }}>{load.data.error}</span>}
        {made && (
          <div style={{ display: "grid", gap: "6px", padding: "10px", borderRadius: "8px", background: "#eaf6ec" }}>
            <strong>Started {made.name ?? "the return"}.</strong>
            <span>It's in Shipping → Returns as "Awaiting arrival". Verify the items when the package comes back.</span>
            <button type="button" style={{ ...btn, justifySelf: "start" }} onClick={onClose}>
              Done
            </button>
          </div>
        )}
        {info && !made && info.items.length === 0 && <span style={small}>Nothing on {info.orderName} can be returned: only shipped items that aren't already being returned can.</span>}
        {info && !made && info.items.length > 0 && (
          <>
            <div style={{ display: "grid", gap: "6px" }}>
              <h3 style={heading}>Items coming back</h3>
              {info.items.map((i) => (
                <label key={i.fulfillmentLineItemId} style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", border: "1px solid #eee", borderRadius: "8px" }}>
                  <span style={{ display: "grid", minWidth: 0 }}>
                    <span>
                      {i.title}
                      {i.variantTitle ? ` (${i.variantTitle})` : ""}
                    </span>
                    <span style={small}>
                      {i.sku ? `${i.sku} · ` : ""}
                      {i.quantity} can be returned
                    </span>
                  </span>
                  <select aria-label={`How many ${i.title}`} value={qty[i.fulfillmentLineItemId] ?? "0"} onChange={(e) => setQty({ ...qty, [i.fulfillmentLineItemId]: e.target.value })} style={{ ...field, width: "64px" }}>
                    {Array.from({ length: i.quantity + 1 }, (_, n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <label style={{ display: "grid", gap: "4px" }}>
              <h3 style={heading}>Why</h3>
              <select value={reason} onChange={(e) => setReason(e.target.value)} style={field}>
                <option value="">Choose a reason…</option>
                {info.reasons.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: "4px" }}>
              <span style={small}>Note {reason === "Other" ? "(required)" : "(optional)"}</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} style={{ ...field, resize: "vertical" }} />
            </label>
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              Email the customer that a return was started
            </label>
            {save.data?.error && <span style={{ color: "#8e1f0b" }}>{save.data.error}</span>}
            <button
              type="button"
              style={{ ...dark, justifySelf: "start", opacity: ready ? 1 : 0.5 }}
              disabled={!ready || save.state !== "idle"}
              onClick={() =>
                save.submit(
                  { intent: "startReturn", orderId, items: JSON.stringify(chosen.map((i) => ({ fulfillmentLineItemId: i.fulfillmentLineItemId, quantity: Number(qty[i.fulfillmentLineItemId]) }))), reason, note, notify: notify ? "1" : "0" },
                  { method: "post", action: RETURNS_ACTION },
                )
              }
            >
              {save.state !== "idle" ? "Starting…" : "Start return"}
            </button>
          </>
        )}
      </div>
    </Flyout>
  );
}
