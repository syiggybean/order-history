import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

// Who picked, packed and shipped each part of an order, its batch, scan
// overrides and packing videos, plus the full history (collapsed). Goes in
// every order flyout: <OrderAudit orderId="gid://shopify/Order/1" />.

const small = { fontSize: "12px", color: "#616161" };
const heading = { fontSize: "12px", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#616161", margin: 0 };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", background: bg, color: fg, fontSize: "12px", fontWeight: 600 });
const linkBtn = { appearance: "none", background: "none", border: 0, padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", textAlign: "left" };

const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "";
const mins = (s) => (s == null ? null : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);

function Step({ label, step, empty }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: "6px", alignItems: "baseline" }}>
      <span style={small}>{label}</span>
      {step ? (
        <span>
          <strong style={{ fontWeight: 600 }}>{step.by ?? (step.how === "shopify" ? "In Shopify" : "Unknown")}</strong>
          {step.at && <span style={small}> · {when(step.at)}</span>}
          {step.how === "flow" && <span style={small}> · flow mode</span>}
          {step.how === "merged" && <span style={small}> · in another order's box</span>}
          {step.detail && <div style={small}>{step.detail}</div>}
        </span>
      ) : (
        <span style={small}>{empty}</span>
      )}
    </div>
  );
}

const VIDEO_STATUS = { uploading: "Uploading…", failed: "Upload failed", replaced: "Replaced by a later packing", skipped: "Not recorded" };

function Part({ p, multi, canVideo }) {
  return (
    <div style={{ display: "grid", gap: "6px", border: "1px solid #e3e3e3", borderRadius: "8px", padding: "10px" }}>
      {(multi || p.overrides.length > 0) && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          {multi && <strong>Part {p.part}</strong>}
          {p.overrides.length > 0 && <span style={pill("#fde2dd", "#8e1f0b")}>⚠ Scan overridden</span>}
        </div>
      )}
      <Step label="Batch" step={p.batch ? { by: p.batch.title, at: null, detail: [p.batch.createdBy ? `created by ${p.batch.createdBy}` : null, p.batch.createdAt ? when(p.batch.createdAt) : null, p.batch.priority && p.batch.priority !== "Normal" ? `${p.batch.priority} priority` : null].filter(Boolean).join(" · ") || null } : null} empty="Not batched" />
      <Step label="Picked" step={p.picked} empty="Not yet" />
      <Step label="Packed" step={p.packed} empty="Not yet" />
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
            {[v.by, when(v.at), mins(v.seconds), v.status !== "done" ? VIDEO_STATUS[v.status] ?? v.status : null, v.error].filter(Boolean).join(" · ")}
            {v.status === "done" && !v.url && !canVideo ? " · ask an admin for Packing videos access to watch" : ""}
          </span>
          {v.clips.length > 0 && (
            <span style={small}>
              · {v.clips.length} customer clip{v.clips.length === 1 ? "" : "s"} ({v.clips.map((c) => c.status).join(", ")})
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function OrderAudit({ orderId = null, orderName = null, refreshKey = 0 }) {
  const f = useFetcher();
  const [open, setOpen] = useState(false);
  const submit = useRef(f.submit);
  submit.current = f.submit;
  useEffect(() => {
    if (!orderId && !orderName) return;
    submit.current({ orderId: orderId ?? "", orderName: orderName ?? "" }, { method: "post", action: "/app/order-audit" });
  }, [orderId, orderName, refreshKey]);
  const a = f.data?.audit;
  if (f.data?.denied) return null;
  return (
    <div style={{ display: "grid", gap: "8px", fontSize: "13px" }}>
      <h3 style={heading}>Who handled it</h3>
      {!f.data && <span style={small}>Loading…</span>}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      {a && a.parts.length === 0 && <span style={small}>MonkeyBean hasn't handled this order yet.</span>}
      {a?.parts.map((p) => (
        <Part key={p.id} p={p} multi={a.multiPart} canVideo={f.data.canVideo} />
      ))}
      {a && a.history.length > 0 && (
        <div style={{ display: "grid", gap: "6px" }}>
          <button type="button" style={{ ...linkBtn, fontWeight: 600 }} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "▾" : "▸"} Full history ({a.history.length})
          </button>
          {open && (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0" }}>
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
    </div>
  );
}
