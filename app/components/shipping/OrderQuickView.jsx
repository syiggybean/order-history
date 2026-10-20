import { useEffect } from "react";
import { useFetcher } from "react-router";
import { FlagForm, ResolveFlag } from "./Review";
import { ProductName, fmtDate, muted, pill, small, ProductThumb } from "./ui";

const linkBtn = {
  appearance: "none",
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "#005bd3",
  fontWeight: 600,
  cursor: "pointer",
  textAlign: "left",
};

const STATE = {
  waiting: ["Waiting", "#fff4d6", "#7a4f01"],
  ready: ["Ready to ship", "#e3f1df", "#1a5e20"],
  batched: ["In a batch", "#eef3ff", "#1c4a9c"],
  packed: ["Packed", "#e3f1df", "#1a5e20"],
  labeling: ["Labeling", "#fff4d6", "#7a4f01"],
  shipped: ["Shipped", "#f1f1f1", "#4a4a4a"],
  closed: ["Closed", "#f1f1f1", "#6b6b6b"],
};
const money = (m) => (m ? new Intl.NumberFormat("en-US", { style: "currency", currency: m.currencyCode }).format(Number(m.amount)) : null);

const Section = ({ title, children }) => (
  <div style={{ marginBottom: "18px" }}>
    <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#616161", marginBottom: "8px" }}>{title}</div>
    {children}
  </div>
);

export function OrderQuickView({ orderId, onClose, onOpenBatch, canReview = false, startFlagging = false, onChanged }) {
  const fetcher = useFetcher();
  const load = () => fetcher.submit({ intent: "order", orderId }, { method: "post" });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);
  // After flagging or resolving: refresh this panel and the lists behind it
  const changed = () => {
    load();
    onChanged?.();
  };
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = fetcher.data?.intent === "order" && fetcher.data.orderId === orderId ? fetcher.data : null;
  const openFlags = d?.order?.flags?.filter((f) => f.status === "open") ?? [];
  const pastFlags = d?.order?.flags?.filter((f) => f.status !== "open") ?? [];
  const o = d?.order;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 999, display: "flex", justifyContent: "flex-end" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Order quick view"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(480px, 100%)", height: "100%", background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #e3e3e3" }}>
          <strong style={{ fontSize: "15px" }}>{o ? `Order ${o.name}` : "Order"}</strong>
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...linkBtn, color: "#303030", fontWeight: 400, fontSize: "20px", lineHeight: 1 }}>
            ×
          </button>
        </div>

        <div style={{ padding: "16px", overflowY: "auto", flexGrow: 1, fontSize: "13px" }}>
          {!d && <s-paragraph>Loading…</s-paragraph>}
          {d?.error && (
            <s-banner tone="critical">
              <s-paragraph>{d.error}</s-paragraph>
            </s-banner>
          )}

          {o && (
            <>
              <div style={{ marginBottom: "16px" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                  {o.cancelledAt && <span style={pill("#fde7e9", "#8e1f0b")}>Cancelled</span>}
                  {o.payment && <span style={pill(o.payment === "Paid" ? "#e3f1df" : "#fff4d6", o.payment === "Paid" ? "#1a5e20" : "#7a4f01")}>{o.payment}</span>}
                  {o.fulfillment && <span style={pill("#f1f1f1", "#4a4a4a")}>{o.fulfillment}</span>}
                </div>
                <div>
                  Placed {fmtDate(o.createdAt, true)}
                  {o.total ? ` · ${money(o.total)}` : ""}
                </div>
                {o.customer && (
                  <div style={{ marginTop: "4px" }}>
                    {o.customer.name}
                    <span style={muted}> · {o.customer.orders} order{o.customer.orders === 1 ? "" : "s"}</span>
                  </div>
                )}
                {o.address && (
                  <div style={{ ...small, marginTop: "4px" }}>
                    Ship to {o.address.name ? `${o.address.name}, ` : ""}
                    {o.address.place}
                    {o.address.country ? `, ${o.address.country}` : ""}
                  </div>
                )}
                {o.shippingMethods.length > 0 && <div style={{ ...small, marginTop: "2px" }}>{o.shippingMethods.join(" · ")}</div>}
                <div style={{ marginTop: "8px" }}>
                  <a href={`shopify:admin/orders/${o.number}`} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                    Open in Shopify ↗
                  </a>
                </div>
              </div>

              {(openFlags.length > 0 || pastFlags.length > 0 || canReview) && (
                <Section title={openFlags.length ? `Flagged for review · ${openFlags.length} open` : "Review"}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {openFlags.map((f) => (
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
                    {canReview && <FlagForm orderId={o.id} orderName={o.name} onDone={changed} startOpen={startFlagging} />}
                    {pastFlags.length > 0 && (
                      <details>
                        <summary style={{ ...small, cursor: "pointer" }}>
                          {pastFlags.length} resolved flag{pastFlags.length === 1 ? "" : "s"}
                        </summary>
                        {pastFlags.map((f) => (
                          <div key={f.id} style={{ ...small, marginTop: "6px" }}>
                            <strong>{f.reason}</strong>
                            {f.note ? `: ${f.note}` : ""} · resolved by {f.resolvedBy ?? "staff"} {fmtDate(f.resolvedAt, true)}: {f.resolution}
                          </div>
                        ))}
                      </details>
                    )}
                  </div>
                </Section>
              )}

              {o.shipments.length > 0 && (
                <Section title={`In the shipping hub${o.shipments.length > 1 ? ` · ${o.shipments.length} shipments` : ""}`}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {o.shipments.map((s) => {
                      const [label, bg, fg] = STATE[s.state] ?? [s.state, "#f1f1f1", "#4a4a4a"];
                      return (
                        <div key={s.id} style={{ border: "1px solid #e3e3e3", borderRadius: "8px", padding: "10px" }}>
                          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
                            {s.part && <strong>Part {s.part}</strong>}
                            <span style={pill(bg, fg)}>{label}</span>
                            {s.batch && (
                              <button type="button" style={{ ...linkBtn, fontSize: "12px" }} onClick={() => onOpenBatch(s.batch.id)}>
                                {s.batch.tag}
                                {s.batch.name ? ` · ${s.batch.name}` : ""}
                              </button>
                            )}
                          </div>
                          <div style={{ ...small, marginTop: "4px" }}>
                            {s.lines.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join(", ")}
                          </div>
                          {s.shippingMethod && <div style={small}>{s.shippingMethod}</div>}
                          {s.state === "waiting" && s.waitingReason && <div style={{ marginTop: "4px", color: "#7a4f01" }}>{s.waitingReason}</div>}
                          {s.flag && <div style={{ marginTop: "4px", color: "#b42318", fontWeight: 600 }}>{s.flag}</div>}
                          {s.override && (
                            <div style={{ ...small, marginTop: "4px" }}>
                              Let through outside a batch by {s.override.by ?? "staff"}: {s.override.reason}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}

              <Section title="Items">
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {o.lines.map((l) => (
                    <div key={l.id} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      <ProductThumb src={l.imageUrl} size={36} />
                      <div style={{ flex: 1 }}>
                        <div>
                          <strong>{l.quantity} ×</strong> <ProductName id={l.productId}>{l.title}</ProductName>
                          {l.variantTitle && <span style={muted}> · {l.variantTitle}</span>}
                        </div>
                        <div style={small}>
                          {[l.sku, l.unfulfilled ? `${l.unfulfilled} to ship` : l.quantity ? "Fulfilled" : null, l.removed ? `${l.removed} removed` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>

              {o.fulfillments.length > 0 && (
                <Section title="Fulfillments">
                  {o.fulfillments.map((f) => (
                    <div key={f.name} style={{ marginBottom: "6px" }}>
                      <strong>{f.name}</strong> <span style={muted}>· {fmtDate(f.at, true)}{f.status ? ` · ${f.status}` : ""}</span>
                      {f.tracking.map((t, i) => (
                        <div key={i} style={small}>
                          {t.company ? `${t.company} ` : ""}
                          {t.url ? (
                            <a href={t.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                              {t.number ?? "Track"}
                            </a>
                          ) : (
                            t.number
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </Section>
              )}

              {(o.tags.length > 0 || o.note) && (
                <Section title="Tags and note">
                  {o.tags.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: o.note ? "8px" : 0 }}>
                      {o.tags.map((t) => (
                        <span key={t} style={pill(/^batch-\d+$/i.test(t) ? "#fff5f7" : "#f1f1f1", "#303030")}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {o.note && <div style={{ whiteSpace: "pre-wrap", background: "#f7f7f7", borderRadius: "8px", padding: "8px 10px" }}>{o.note}</div>}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
