import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { OrderLink } from "./OrderLink";
import { box, cell, fmtDate, head, input, muted, pill, small, useParamSetter } from "./ui";

export const FLAG_REASONS = ["Address problem", "Possible fraud", "Customer contacted us", "Item or stock problem", "Payment problem", "Other"];

const FLAG_RED = ["#fde7e9", "#8e1f0b"];

// Small marker for rows whose order has an open flag
export function FlagMarker({ flags }) {
  if (!flags?.length) return null;
  const first = flags[0];
  return (
    <div style={{ marginTop: "4px" }} title={flags.map((f) => `${f.reason}${f.note ? `: ${f.note}` : ""}${f.by ? ` (${f.by})` : ""}`).join("\n")}>
      <span style={pill(...FLAG_RED)}>
        ⚑ {first.reason}
        {flags.length > 1 ? ` +${flags.length - 1}` : ""}
      </span>
    </div>
  );
}

// Flag an order: a reason and an optional note
export function FlagForm({ orderId, orderName, onDone, compact = false, startOpen = false }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(startOpen);
  const formRef = useRef(null);
  // Opened from a row's "Flag for review": bring the form into view
  useEffect(() => {
    if (startOpen) formRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [startOpen]);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const r = fetcher.data?.intent === "flagOrder" ? fetcher.data : null;
  useEffect(() => {
    if (r?.ok) {
      setOpen(false);
      setReason("");
      setNote("");
      onDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);
  if (!open)
    return (
      <s-button variant={compact ? "tertiary" : "secondary"} onClick={() => setOpen(true)}>
        ⚑ Flag for review
      </s-button>
    );
  return (
    <div
      ref={formRef}
      className="sh-rise"
      style={{ border: "1px solid #f3b5bd", background: "#fff8f8", borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}
    >
      <strong>Flag {orderName} for the team</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        {FLAG_REASONS.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setReason(x)}
            aria-pressed={reason === x}
            style={{
              appearance: "none",
              font: "inherit",
              fontSize: "12px",
              padding: "4px 10px",
              borderRadius: "999px",
              cursor: "pointer",
              border: `1px solid ${reason === x ? "#8e1f0b" : "#d5d5d5"}`,
              background: reason === x ? "#fde7e9" : "#fff",
              color: reason === x ? "#8e1f0b" : "#303030",
              fontWeight: reason === x ? 600 : 400,
            }}
          >
            {x}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder={reason === "Other" ? "What's the issue? (required)" : "Note for the team (optional)"}
        aria-label="Note"
        style={{ ...input, width: "100%", boxSizing: "border-box" }}
      />
      {r?.error && <div style={{ color: "#b42318" }}>{r.error}</div>}
      <div style={{ display: "flex", gap: "8px" }}>
        <s-button
          variant="primary"
          tone="critical"
          onClick={() => fetcher.submit({ intent: "flagOrder", orderId, orderName, reason, note }, { method: "post" })}
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          {...(!reason ? { disabled: true } : {})}
        >
          Flag order
        </s-button>
        <s-button variant="tertiary" onClick={() => setOpen(false)}>
          Cancel
        </s-button>
      </div>
    </div>
  );
}

// Resolve: say what was done
export function ResolveFlag({ flag, onDone }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const r = fetcher.data?.intent === "resolveFlag" ? fetcher.data : null;
  useEffect(() => {
    if (r?.ok) {
      setOpen(false);
      setText("");
      onDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);
  if (!open)
    return (
      <s-button variant="secondary" onClick={() => setOpen(true)}>
        Resolve
      </s-button>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "220px" }}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What was done?"
        aria-label="What was done"
        style={input}
        autoFocus
        onKeyDown={(e) => e.key === "Enter" && text.trim() && fetcher.submit({ intent: "resolveFlag", id: String(flag.id), resolution: text }, { method: "post" })}
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <s-button
          variant="primary"
          onClick={() => fetcher.submit({ intent: "resolveFlag", id: String(flag.id), resolution: text }, { method: "post" })}
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          {...(!text.trim() ? { disabled: true } : {})}
        >
          Mark resolved
        </s-button>
        <s-button variant="tertiary" onClick={() => setOpen(false)}>
          Cancel
        </s-button>
      </div>
      {r?.error && <span style={{ color: "#b42318", fontSize: "12px" }}>{r.error}</span>}
    </div>
  );
}

function Reopen({ flag }) {
  const fetcher = useFetcher();
  return (
    <s-button variant="tertiary" onClick={() => fetcher.submit({ intent: "reopenFlag", id: String(flag.id) }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
      Reopen
    </s-button>
  );
}

const STATE = { waiting: "Waiting", ready: "Ready", batched: "In a batch", packed: "Packed", labeling: "Labeling", shipped: "Shipped", closed: "Closed" };

export function ReviewTab({ flags, status, canReview }) {
  const go = useParamSetter();
  return (
    <s-section heading="Review">
      <s-paragraph>
        <span style={muted}>
          Orders someone flagged for the team. Flag an order from its quick view (click the order number anywhere on this page). Flagged orders are
          left out of auto-batching until resolved.
        </span>
      </s-paragraph>
      <div role="tablist" style={{ display: "inline-flex", border: "1px solid #d5d5d5", borderRadius: "8px", overflow: "hidden", margin: "10px 0" }}>
        {[
          ["open", "Open"],
          ["resolved", "Resolved"],
        ].map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={status === v}
            onClick={() => go({ status: v === "open" ? null : v })}
            style={{ appearance: "none", border: 0, padding: "6px 12px", font: "inherit", cursor: "pointer", background: status === v ? "#1a1a1a" : "#fff", color: status === v ? "#fff" : "#303030" }}
          >
            {label}
          </button>
        ))}
      </div>
      {!flags.length ? (
        <s-paragraph>{status === "open" ? "Nothing flagged. 🎉" : "Nothing resolved yet."}</s-paragraph>
      ) : (
        <div style={{ ...box, maxHeight: "680px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Order", "Issue", "Flagged", "Shipments", status === "open" ? "" : "Resolved"].map((h, i) => (
                  <th key={i} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flags.map((f, i) => (
                <tr key={f.id} className="sh-rise" style={{ animationDelay: `${(i % 12) * 25}ms` }}>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    <OrderLink orderId={f.orderId} orderNumber={f.orderNumber} name={f.orderName} />
                  </td>
                  <td style={cell}>
                    <span style={pill(...FLAG_RED)}>⚑ {f.reason}</span>
                    {f.note && <div style={{ marginTop: "4px", whiteSpace: "pre-wrap" }}>{f.note}</div>}
                  </td>
                  <td style={cell}>
                    {fmtDate(f.createdAt, true)}
                    <div style={small}>{f.createdBy ?? ""}</div>
                  </td>
                  <td style={{ ...cell, ...small }}>
                    {f.shipments.length
                      ? f.shipments.map((s, j) => (
                          <div key={j}>
                            {s.part ? `Part ${s.part}: ` : ""}
                            {STATE[s.state] ?? s.state}
                          </div>
                        ))
                      : "—"}
                  </td>
                  <td style={cell}>
                    {status === "open" ? (
                      canReview && <ResolveFlag flag={f} />
                    ) : (
                      <>
                        <div>{f.resolution}</div>
                        <div style={small}>
                          {f.resolvedBy ?? ""} · {fmtDate(f.resolvedAt, true)}
                        </div>
                        {canReview && <Reopen flag={f} />}
                      </>
                    )}
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
