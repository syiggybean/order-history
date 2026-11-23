import { useContext, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Flyout } from "./Flyout";
import { OrderViewContext } from "./shipping/OrderLink";

// Who picked, packed and shipped each part of an order, its items and whether
// they were scanned, its batch, scan overrides and packing videos, plus the full
// history (collapsed) and Reship. Goes in every order flyout:
//   <OrderAudit orderId="gid://shopify/Order/1" />

const ACTION = "/app/order-audit";
const small = { fontSize: "12px", color: "#616161" };
const heading = { fontSize: "12px", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#616161", margin: 0 };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", background: bg, color: fg, fontSize: "12px", fontWeight: 600 });
const linkBtn = { appearance: "none", background: "none", border: 0, padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", textAlign: "left" };
const btn = { font: "inherit", fontSize: "13px", padding: "4px 12px", borderRadius: "8px", border: "1px solid #c9c9c9", background: "#fff", cursor: "pointer" };
const dark = { ...btn, background: "#1a1a1a", color: "#fff", border: "1px solid #1a1a1a" };
const field = { font: "inherit", fontSize: "13px", padding: "6px 8px", border: "1px solid #c9c9c9", borderRadius: "8px", boxSizing: "border-box" };

export const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "";
const mins = (s) => (s == null ? null : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);

function Step({ label, step, empty }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: "6px", alignItems: "baseline" }}>
      <span style={small}>{label}</span>
      {step ? (
        <span>
          <strong style={{ fontWeight: 600 }}>{step.by ?? (step.how === "shopify" ? "In Shopify" : "Not recorded")}</strong>
          {step.at && <span style={small}> · {when(step.at)}</span>}
          {step.how === "flow" && <span style={small}> · flow mode</span>}
          {step.detail && <div style={small}>{step.detail}</div>}
        </span>
      ) : (
        <span style={small}>{empty}</span>
      )}
    </div>
  );
}

const SCAN = {
  scanned: ["✓ Scanned", "#1a5e20"],
  partly: ["Partly scanned", "#7a4f01"],
  not_scanned: ["Not scanned", "#8e1f0b"],
  outside: ["Packed outside MonkeyBean", "#616161"],
};
export function Items({ items }) {
  if (!items?.length) return null;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "2px" }}>
      {items.map((it, i) => (
        <li key={i} style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "13px" }}>
          <span>
            {it.quantity} × {it.name}
          </span>
          {it.scan && <span style={{ fontSize: "12px", fontWeight: 600, color: SCAN[it.scan][1], whiteSpace: "nowrap" }}>{SCAN[it.scan][0]}</span>}
        </li>
      ))}
    </ul>
  );
}

const VIDEO_STATUS = { uploading: "Uploading…", failed: "Upload failed", replaced: "Replaced by a later packing", skipped: "Not recorded" };

export function Part({ p, multi, canVideo, openOrder, extra = null, onOpenBatch = null }) {
  return (
    <div style={{ display: "grid", gap: "6px", border: "1px solid #e3e3e3", borderRadius: "8px", padding: "10px" }}>
      {(multi || p.overrides.length > 0) && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          {multi && <strong>Part {p.part}</strong>}
          {p.overrides.length > 0 && <span style={pill("#fde2dd", "#8e1f0b")}>{p.overrides.some((o) => o.scan) ? "⚠ Scan overridden" : "⚠ Override"}</span>}
        </div>
      )}
      {extra}
      <Items items={p.items} />
      {p.inBox && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", padding: "6px 8px", borderRadius: "6px", background: "#eef3ff", fontSize: "13px" }}>
          <span>
            {p.inBox.done ? "Went" : "Goes"} out in <strong>{p.inBox.orderName}</strong>'s box. These are that box's details.
          </span>
          {p.inBox.orderId && (
            <button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => openOrder({ orderId: p.inBox.orderId, orderName: p.inBox.orderName })}>
              Open {p.inBox.orderName}
            </button>
          )}
        </div>
      )}
      {onOpenBatch && p.batch?.id ? (
        <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: "6px", alignItems: "baseline" }}>
          <span style={small}>Batch</span>
          <span>
            <button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => onOpenBatch(p.batch.id)}>
              {p.batch.title}
            </button>
            {p.batch.createdBy && <span style={small}> · created by {p.batch.createdBy}</span>}
          </span>
        </div>
      ) : (
      <Step
        label="Batch"
        step={
          p.batch
            ? {
                by: p.batch.title,
                detail:
                  [p.batch.createdBy ? `created by ${p.batch.createdBy}` : null, p.batch.createdAt ? when(p.batch.createdAt) : null, p.batch.priority && p.batch.priority !== "Normal" ? `${p.batch.priority} priority` : null]
                    .filter(Boolean)
                    .join(" · ") || null,
              }
            : null
        }
        empty="Not batched"
      />
      )}
      <Step label="Picked" step={p.picked} empty={p.shipped ? "Not in MonkeyBean" : "Not yet"} />
      <Step label="Packed" step={p.packed} empty={p.shipped ? "Not in MonkeyBean" : "Not yet"} />
      <Step label="Shipped" step={p.shipped} empty="Not yet" />
      {p.overrides.map((o, i) => (
        <div key={i} style={{ padding: "6px 8px", borderRadius: "6px", background: "#fdecea", color: "#8e1f0b", fontSize: "12px" }}>
          <strong>{o.kind}</strong>
          {o.by ? ` by ${o.by}` : ""}
          {o.at ? ` · ${when(o.at)}` : ""}
          {o.reason && <div style={{ color: "#5c1a10" }}>{o.reason}</div>}
        </div>
      ))}
      {p.videos.map((v) => (
        <div key={v.id} style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "baseline", fontSize: "13px" }}>
          <span>🎥</span>
          {v.url ? (
            <a href={v.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3", fontWeight: 600 }}>
              Packing video
            </a>
          ) : (
            <span style={{ fontWeight: 600 }}>Packing video</span>
          )}
          <span style={small}>
            {[v.by, when(v.at), mins(v.seconds), v.status !== "done" ? (VIDEO_STATUS[v.status] ?? v.status) : null, v.error].filter(Boolean).join(" · ")}
            {v.status === "done" && !v.url && !canVideo ? " · ask an admin for Packing videos access to watch" : ""}
          </span>
          {v.clips.length > 0 && (
            <span style={small}>
              · {v.clips.length} customer clip{v.clips.length === 1 ? "" : "s"} ({v.clips.map((c) => c.status).join(", ")})
            </span>
          )}
        </div>
      ))}
      {p.carried?.map((c) => (
        <div key={c.orderName} style={{ display: "grid", gap: "4px", padding: "6px 8px", borderRadius: "6px", background: "#f6f6f7" }}>
          <span style={{ fontSize: "13px" }}>
            Also carried items from <strong>{c.orderName}</strong>{" "}
            {c.orderId && (
              <button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => openOrder({ orderId: c.orderId, orderName: c.orderName })}>
                Open {c.orderName}
              </button>
            )}
          </span>
          <Items items={c.items} />
        </div>
      ))}
    </div>
  );
}

// Parts Shopify closed with nothing shipped from them (their items were moved
// to another part, cancelled or removed): folded away, so they don't read as
// a second shipment
export function EmptyParts({ parts }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "grid", gap: "4px" }}>
      <button type="button" style={{ ...linkBtn, fontSize: "12px", color: "#616161" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {parts.length === 1 ? `Part ${parts[0].part} was` : `${parts.length} parts were`} closed in Shopify with nothing shipped
      </button>
      {open && (
        <span style={small}>
          {parts.map((p) => `Part ${p.part}${p.closedAt ? ` (seen closed ${when(p.closedAt)})` : ""}`).join(", ")}. Shopify leaves an empty part behind when items are moved to
          another part (for example, split off to ship in another order's box), cancelled or removed. Nothing was sent from {parts.length === 1 ? "it" : "them"}.
        </span>
      )}
    </div>
  );
}

export function OrderAudit({ orderId = null, orderName = null, refreshKey = 0 }) {
  const f = useFetcher();
  const [open, setOpen] = useState(false);
  const [reshipping, setReshipping] = useState(false);
  const [other, setOther] = useState(null); // another order, opened from here
  const quickView = useContext(OrderViewContext);
  const submit = useRef(f.submit);
  submit.current = f.submit;
  const reload = () => submit.current({ orderId: orderId ?? "", orderName: orderName ?? "" }, { method: "post", action: ACTION });
  useEffect(() => {
    if (orderId || orderName) reload();
  }, [orderId, orderName, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The page's own order view when it has one (Shipping), else a flyout here
  const openOrder = (o) => (quickView && o.orderId ? quickView(o.orderId) : setOther(o));
  const a = f.data?.audit;
  if (f.data?.denied) return null;
  return (
    <div style={{ display: "grid", gap: "8px", fontSize: "13px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
        <h3 style={heading}>Who handled it</h3>
        {f.data?.canReship && orderId && (
          <button type="button" style={{ ...btn, fontSize: "12px", padding: "3px 10px" }} onClick={() => setReshipping(true)}>
            Reship items
          </button>
        )}
      </div>
      {!f.data && <span style={small}>Loading…</span>}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      {a && a.parts.length === 0 && <span style={small}>MonkeyBean hasn't handled this order yet.</span>}
      {a?.parts
        .filter((p) => !p.nothingSent)
        .map((p) => (
          <Part key={p.id} p={p} multi={a.multiPart} canVideo={f.data.canVideo} openOrder={openOrder} />
        ))}
      {a && a.parts.some((p) => p.nothingSent) && <EmptyParts parts={a.parts.filter((p) => p.nothingSent)} />}
      {a && a.history.length > 0 && (
        <div style={{ display: "grid", gap: "6px" }}>
          <button type="button" style={{ ...linkBtn, fontWeight: 600 }} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} Full history ({a.history.length})
          </button>
          {open && (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
              {a.history.map((e) => (
                <li key={e.id} style={{ display: "grid", gap: "1px", padding: "6px 0 6px 10px", borderLeft: `2px solid ${e.override ? "#e0a59b" : "#e3e3e3"}` }}>
                  <span>
                    <strong style={{ fontWeight: 600, color: e.override ? "#8e1f0b" : undefined }}>{e.label}</strong>
                    {e.by && <span> · {e.by}</span>}
                    {a.multiPart && e.part && <span style={small}> · part {e.part}</span>}
                    {e.batch && <span style={small}> · {e.batch}</span>}
                  </span>
                  <span style={small}>{when(e.at)}</span>
                  {e.detail && <span style={{ ...small, color: "#303030", overflowWrap: "anywhere" }}>{e.detail}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {reshipping && <ReshipFlyout orderId={orderId} onClose={() => setReshipping(false)} onMade={reload} />}
      {other && (
        <Flyout onClose={() => setOther(null)} label={`Order ${other.orderName}`} title={`Order ${other.orderName}`} width={480} zIndex={1050}>
          <OrderAudit orderId={other.orderId} orderName={other.orderName} />
        </Flyout>
      )}
    </div>
  );
}

// A free replacement order for some of the order's items
export function ReshipFlyout({ orderId, onClose, onMade }) {
  const load = useFetcher();
  const save = useFetcher();
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [takeStock, setTakeStock] = useState(""); // "1" | "0" (only for Other)
  const [notify, setNotify] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const submit = useRef(load.submit);
  submit.current = load.submit;
  useEffect(() => {
    submit.current({ intent: "reshipInfo", orderId }, { method: "post", action: ACTION });
  }, [orderId]);
  const info = load.data?.intent === "reshipInfo" ? load.data.info : null;
  const made = save.data?.intent === "reship" && save.data.ok ? save.data.made : null;
  useEffect(() => {
    if (made) onMade?.();
  }, [made]); // eslint-disable-line react-hooks/exhaustive-deps
  const def = info?.reasons.find((r) => r.reason === reason);
  const takes = def ? (def.takesStock ?? (takeStock === "1" ? true : takeStock === "0" ? false : null)) : null;
  const chosen = info ? info.lines.filter((l) => Number(qty[l.id]) > 0) : [];
  const ready = chosen.length > 0 && def && takes !== null && (reason !== "Other" || note.trim());
  const go = () =>
    save.submit(
      {
        intent: "reship",
        orderId,
        items: JSON.stringify(chosen.map((l) => ({ lineItemId: l.id, quantity: Number(qty[l.id]) }))),
        reason,
        note,
        notify: notify ? "1" : "0",
        takeStock: reason === "Other" ? takeStock : "",
      },
      { method: "post", action: ACTION },
    );
  const change = (fn) => (...args) => {
    fn(...args);
    setConfirming(false);
  };
  return (
    <Flyout onClose={onClose} label="Reship items" title={info ? `Reship from ${info.orderName}` : "Reship items"} width={500} zIndex={1060}>
      <div style={{ display: "grid", gap: "14px", fontSize: "13px" }}>
        {!info && !load.data?.error && <span style={small}>Loading…</span>}
        {load.data?.error && <span style={{ color: "#8e1f0b" }}>{load.data.error}</span>}
        {made && (
          <div style={{ display: "grid", gap: "4px", padding: "10px", borderRadius: "8px", background: "#eaf6ec" }}>
            <strong>
              Made {made.name}: {made.items}
            </strong>
            <span>
              {made.takesStock ? "The items came out of stock." : "Stock wasn't changed."} It will show in Shipping to batch, pack and label like any other order.
            </span>
            <a href={`shopify:admin/orders/${made.number}`} target="_top" style={{ color: "#005bd3", fontWeight: 600 }}>
              Open {made.name} in Shopify ↗
            </a>
          </div>
        )}
        {info && !made && (
          <>
            {info.earlier.length > 0 && (
              <div style={{ padding: "8px 10px", borderRadius: "8px", background: "#fff4d6", color: "#7a4f01" }}>
                <strong>Already reshipped before:</strong>
                {info.earlier.map((e, i) => (
                  <div key={i}>
                    {when(e.at)} · {e.by ?? "Staff"} · {e.detail}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gap: "6px" }}>
              <h3 style={heading}>Items to send again</h3>
              {info.lines.map((l) => (
                <label key={l.id} style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", padding: "6px 8px", border: "1px solid #eee", borderRadius: "8px" }}>
                  <span style={{ display: "grid", minWidth: 0 }}>
                    <span>
                      {l.title}
                      {l.variantTitle ? ` (${l.variantTitle})` : ""}
                    </span>
                    <span style={small}>
                      {l.sku ? `${l.sku} · ` : ""}
                      {l.quantity} ordered
                    </span>
                  </span>
                  <select
                    aria-label={`How many ${l.title}`}
                    value={qty[l.id] ?? "0"}
                    onChange={change((e) => setQty({ ...qty, [l.id]: e.target.value }))}
                    style={{ ...field, width: "64px" }}
                  >
                    {Array.from({ length: l.quantity + 1 }, (_, n) => (
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
              <select value={reason} onChange={change((e) => setReason(e.target.value))} style={field}>
                <option value="">Choose a reason…</option>
                {info.reasons.map((r) => (
                  <option key={r.reason} value={r.reason}>
                    {r.reason}
                  </option>
                ))}
              </select>
            </label>
            {reason === "Other" && (
              <div style={{ display: "grid", gap: "4px" }}>
                <span style={small}>Did the first one leave the shelf?</span>
                <label style={{ display: "flex", gap: "6px" }}>
                  <input type="radio" name="takeStock" checked={takeStock === "1"} onChange={change(() => setTakeStock("1"))} />
                  Yes: take the reshipped items out of stock
                </label>
                <label style={{ display: "flex", gap: "6px" }}>
                  <input type="radio" name="takeStock" checked={takeStock === "0"} onChange={change(() => setTakeStock("0"))} />
                  No, it was never sent: leave stock as it is
                </label>
              </div>
            )}
            {def && takes !== null && (
              <div style={{ padding: "6px 10px", borderRadius: "8px", background: takes ? "#f6f6f7" : "#eef3ff" }}>
                <strong>Stock:</strong>{" "}
                {takes ? "comes off. A second one leaves the shelf." : "stays the same. The one counted the first time is still on the shelf; this one replaces it."}
              </div>
            )}
            <label style={{ display: "grid", gap: "4px" }}>
              <span style={small}>Note {reason === "Other" ? "(required)" : "(optional)"}</span>
              <textarea value={note} onChange={change((e) => setNote(e.target.value))} rows={2} maxLength={500} style={{ ...field, resize: "vertical" }} />
            </label>
            <div style={{ display: "grid", gap: "4px" }}>
              <span style={small}>Ships to</span>
              <span>{info.address ?? <span style={{ color: "#8e1f0b" }}>No shipping address on {info.orderName}</span>}</span>
              {info.method && <span style={small}>Shipping method: {info.method} (free)</span>}
            </div>
            <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
              Email the customer tracking when it ships
            </label>
            {save.data?.error && <span style={{ color: "#8e1f0b" }}>{save.data.error}</span>}
            {!confirming ? (
              <button type="button" style={{ ...dark, justifySelf: "start", opacity: ready && info.hasAddress ? 1 : 0.5 }} disabled={!ready || !info.hasAddress} onClick={() => setConfirming(true)}>
                Create reship order
              </button>
            ) : (
              <div style={{ display: "grid", gap: "8px", padding: "10px", border: "1px solid #ecd58f", background: "#fffbea", borderRadius: "8px" }}>
                <span>
                  This makes a <strong>$0 order</strong> in Shopify for {chosen.map((l) => `${qty[l.id]} × ${l.title}`).join(", ")}, tagged "Reship". Stock{" "}
                  {takes ? "comes off" : "stays the same"}.
                </span>
                <span style={{ display: "flex", gap: "8px" }}>
                  <button type="button" style={dark} disabled={save.state !== "idle"} onClick={go}>
                    {save.state !== "idle" ? "Creating…" : "Yes, create it"}
                  </button>
                  <button type="button" style={btn} disabled={save.state !== "idle"} onClick={() => setConfirming(false)}>
                    Cancel
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
