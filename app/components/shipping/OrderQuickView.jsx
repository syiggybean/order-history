import { FlagForm, ResolveFlag } from "./Review";
import { fmtDate, pill, small } from "./ui";
import { OrderFlyout } from "../OrderPanel";

// Shipping's order quick view: the shared order flyout, plus review flags
// (flag an order for review, resolve a flag) at the top of its Overview.

export function OrderQuickView({ orderId, onClose, onOpenBatch, canReview = false, startFlagging = false, onChanged }) {
  return (
    <OrderFlyout
      orderId={orderId}
      onClose={onClose}
      onOpenBatch={onOpenBatch}
      overviewTop={({ order, reload }) => {
        const flags = order?.flags ?? [];
        const open = flags.filter((f) => f.status === "open");
        const past = flags.filter((f) => f.status !== "open");
        if (!open.length && !past.length && !canReview) return null;
        // After flagging or resolving: refresh this panel and the lists behind it
        const changed = () => {
          reload();
          onChanged?.();
        };
        return (
          <div style={{ display: "grid", gap: "8px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid #eee" }}>
            {open.map((f) => (
              <div key={f.id} style={{ border: "1px solid #f3b5bd", background: "#fff8f8", borderRadius: "8px", padding: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                  <span style={pill("#fde7e9", "#8e1f0b")}>⚑ {f.reason}</span>
                  <span style={small}>
                    {f.createdBy ? `${f.createdBy} · ` : ""}
                    {fmtDate(f.createdAt, true)}
                  </span>
                </div>
                {f.note && <div style={{ marginTop: "6px", whiteSpace: "pre-wrap" }}>{f.note}</div>}
                {canReview && (
                  <div style={{ marginTop: "8px" }}>
                    <ResolveFlag flag={f} onDone={changed} />
                  </div>
                )}
              </div>
            ))}
            {canReview && order && <FlagForm orderId={order.id} orderName={order.name} onDone={changed} startOpen={startFlagging} />}
            {past.length > 0 && (
              <details>
                <summary style={{ ...small, cursor: "pointer" }}>
                  {past.length} resolved flag{past.length === 1 ? "" : "s"}
                </summary>
                {past.map((f) => (
                  <div key={f.id} style={{ ...small, marginTop: "6px" }}>
                    <strong>{f.reason}</strong>
                    {f.note ? `: ${f.note}` : ""} · resolved by {f.resolvedBy ?? "staff"} {fmtDate(f.resolvedAt, true)}: {f.resolution}
                  </div>
                ))}
              </details>
            )}
          </div>
        );
      }}
    />
  );
}
