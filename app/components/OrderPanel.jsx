import { useContext, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Flyout } from "./Flyout";
import { OrderViewContext } from "./shipping/OrderLink";
import { EmptyParts, Part, ReshipFlyout, when } from "./OrderAudit";
import { ReturnCard, StartReturnFlyout } from "./Returns";

// The order flyout, the same on every page (Shipping quick view, "Where is #…",
// tickets): a short header with the order's status and actions, then tabs.
//   Overview: anything that needs attention, where it is, items, money, address, tracking
//   Shipping: each part — Shopify's state, who picked / packed / shipped, videos
//   Returns:  its returns, and starting one
//   History:  everything logged in MonkeyBean
// Pages add their own bits through props: `top` (under the header),
// `overviewTop` (top of Overview), `actions` (extra header buttons).
// Each may be a function ({ order, reload }) => node.

const ACTION = "/app/order-audit";
const small = { fontSize: "12px", color: "#616161" };
const muted = { color: "#616161" };
const heading = { fontSize: "12px", fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "#616161", margin: "0 0 6px" };
const btn = { font: "inherit", fontSize: "12px", padding: "3px 10px", borderRadius: "8px", border: "1px solid #c9c9c9", background: "#fff", cursor: "pointer", whiteSpace: "nowrap" };
const linkBtn = { appearance: "none", background: "none", border: 0, padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", fontWeight: 600 };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", background: bg, color: fg, fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });
const section = { display: "grid", gap: "6px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid #eee" };
const money = (m) => (m ? new Intl.NumberFormat("en-US", { style: "currency", currency: m.currencyCode }).format(Number(m.amount)) : null);
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }) : "");
const call = (v, ctx) => (typeof v === "function" ? v(ctx) : v);

const STATE = {
  waiting: ["Waiting", "#fff4d6", "#7a4f01"],
  ready: ["Ready to ship", "#e3f1df", "#1a5e20"],
  batched: ["In a batch", "#eef3ff", "#1c4a9c"],
  packed: ["Packed", "#e3f1df", "#1a5e20"],
  labeling: ["Labeling", "#fff4d6", "#7a4f01"],
  shipped: ["Shipped", "#f1f1f1", "#4a4a4a"],
  closed: ["Closed", "#f1f1f1", "#6b6b6b"],
};
const words = (s) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");

export function OrderFlyout({ orderId, onClose, title = null, top = null, overviewTop = null, actions = null, onOpenBatch = null, refreshKey = 0, zIndex = 999, startTab = "overview" }) {
  const f = useFetcher();
  const [tab, setTab] = useState(startTab);
  const [reshipping, setReshipping] = useState(false);
  const [returning, setReturning] = useState(false);
  const [other, setOther] = useState(null);
  const quickView = useContext(OrderViewContext);
  const submit = useRef(f.submit);
  submit.current = f.submit;
  const reload = () => submit.current({ intent: "panel", orderId }, { method: "post", action: ACTION });
  useEffect(() => {
    if (orderId) reload();
  }, [orderId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = f.data?.intent === "panel" ? f.data : null;
  const o = d?.order;
  const ctx = { order: o, reload, data: d };
  const openOrder = (x) => (quickView && x.orderId ? quickView(x.orderId) : setOther(x));

  const parts = d?.audit?.parts ?? [];
  const live = parts.filter((p) => !p.nothingSent);
  const overrides = live.flatMap((p) => p.overrides.map((ov) => ({ ...ov, part: p.part })));
  const openReturns = (d?.returns ?? []).filter((r) => r.stage === "requested" || r.stage === "awaiting");
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "shipping", label: `Shipping${live.length ? ` (${live.length})` : ""}` },
    { id: "returns", label: `Returns${d?.returns?.length ? ` (${d.returns.length})` : ""}`, dot: openReturns.length > 0 },
    { id: "history", label: `History${d?.audit?.history?.length ? ` (${d.audit.history.length})` : ""}` },
  ];

  return (
    <Flyout onClose={onClose} label="Order" title={title ?? (o ? `Order ${o.name}` : "Order")} width={540} zIndex={zIndex} bodyStyle={{ padding: 0, fontSize: "13px", display: "flex", flexDirection: "column" }}>
      {!d && !f.data?.error && <div style={{ padding: "16px", ...muted }}>Loading…</div>}
      {f.data?.error && <div style={{ padding: "16px", color: "#8e1f0b" }}>{f.data.error}</div>}
      {o && (
        <>
          {/* Header: status, who, actions */}
          <div style={{ padding: "12px 16px 0", display: "grid", gap: "6px" }}>
            {title && <strong style={{ fontSize: "15px" }}>Order {o.name}</strong>}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
              {o.cancelledAt && <span style={pill("#fde7e9", "#8e1f0b")}>Cancelled</span>}
              {o.payment && <span style={pill(o.payment === "Paid" ? "#e3f1df" : "#fff4d6", o.payment === "Paid" ? "#1a5e20" : "#7a4f01")}>{o.payment}</span>}
              {o.fulfillment && <span style={pill("#f1f1f1", "#4a4a4a")}>{o.fulfillment}</span>}
              <span style={small}>
                {fmtDay(o.createdAt)}
                {o.total ? ` · ${money(o.total)}` : ""}
              </span>
            </div>
            {o.customer && (
              <div>
                <strong style={{ fontWeight: 600 }}>{o.customer.name}</strong>
                <span style={small}>
                  {" "}
                  · {o.customer.orders} order{o.customer.orders === 1 ? "" : "s"}
                  {o.customer.email ? ` · ${o.customer.email}` : ""}
                </span>
              </div>
            )}
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
              <a href={`shopify:admin/orders/${o.number}`} target="_blank" rel="noreferrer" style={{ ...btn, color: "#303030", textDecoration: "none" }}>
                Open in Shopify ↗
              </a>
              {d.can?.reship && (
                <button type="button" style={btn} onClick={() => setReshipping(true)}>
                  Reship items
                </button>
              )}
              {d.can?.returns && (
                <button type="button" style={btn} onClick={() => setReturning(true)}>
                  Start return
                </button>
              )}
              {call(actions, ctx)}
            </div>
            {call(top, ctx)}
          </div>

          {/* Tabs */}
          <div role="tablist" aria-label="Order details" style={{ display: "flex", gap: "2px", padding: "8px 16px 0", borderBottom: "1px solid #e3e3e3", marginTop: "8px", overflowX: "auto" }}>
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                style={{
                  appearance: "none",
                  border: 0,
                  borderBottom: `2px solid ${tab === t.id ? "#1a1a1a" : "transparent"}`,
                  background: "none",
                  padding: "6px 10px",
                  font: "inherit",
                  fontWeight: tab === t.id ? 700 : 500,
                  color: tab === t.id ? "#1a1a1a" : "#616161",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t.label}
                {t.dot && <span aria-label="needs attention" style={{ display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: "#e51c00", marginLeft: "4px", verticalAlign: "middle" }} />}
              </button>
            ))}
          </div>

          <div role="tabpanel" style={{ padding: "14px 16px", overflowY: "auto", flexGrow: 1 }}>
            {tab === "overview" && <Overview d={d} o={o} overrides={overrides} openReturns={openReturns} setTab={setTab} slot={call(overviewTop, ctx)} />}
            {tab === "shipping" && <ShippingTab d={d} openOrder={openOrder} onOpenBatch={onOpenBatch} />}
            {tab === "returns" && <ReturnsTab d={d} reload={reload} onStart={() => setReturning(true)} />}
            {tab === "history" && <HistoryTab d={d} />}
          </div>
        </>
      )}
      {reshipping && <ReshipFlyout orderId={orderId} onClose={() => setReshipping(false)} onMade={reload} />}
      {returning && (
        <StartReturnFlyout
          orderId={orderId}
          onClose={() => setReturning(false)}
          onDone={() => {
            reload();
            setTab("returns");
          }}
        />
      )}
      {other && <OrderFlyout orderId={other.orderId} onClose={() => setOther(null)} zIndex={zIndex + 60} />}
    </Flyout>
  );
}

function Overview({ d, o, overrides, openReturns, setTab, slot }) {
  const w = d.where;
  const attention = [
    ...(o.cancelledAt ? [{ tone: "red", text: `Cancelled ${fmtDay(o.cancelledAt)}` }] : []),
    ...(o.flags ?? []).filter((x) => x.status === "open").map((x) => ({ tone: "red", text: `Flagged for review: ${x.reason}` })),
    ...(w?.canResync ? [{ tone: "amber", text: "Shipping and Shopify disagree about this order. See Where it is." }] : []),
    ...overrides.map((ov) => ({ tone: "red", text: `Part ${ov.part}: ${ov.kind.toLowerCase()}${ov.by ? ` by ${ov.by}` : ""}${ov.reason ? ` (${ov.reason})` : ""}`, tab: "shipping" })),
    ...openReturns.map((r) => ({ tone: "amber", text: `${r.name ?? "Return"}: ${r.stageLabel.toLowerCase()}`, tab: "returns" })),
  ];
  const tone = { red: ["#fdecea", "#8e1f0b"], amber: ["#fff4d6", "#7a4f01"] };
  const m = o.money ?? {};
  const row = (label, value, strong) =>
    value ? (
      <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontWeight: strong ? 600 : 400 }}>
        <span style={strong ? {} : muted}>{label}</span>
        <span>{value}</span>
      </div>
    ) : null;
  return (
    <div>
      {slot}
      {attention.length > 0 && (
        <div style={{ ...section, gap: "4px" }}>
          {attention.map((a, i) => (
            <div key={i} style={{ display: "flex", gap: "6px", alignItems: "baseline", padding: "6px 8px", borderRadius: "6px", background: tone[a.tone][0], color: tone[a.tone][1] }}>
              <span aria-hidden>⚠</span>
              <span style={{ flexGrow: 1 }}>{a.text}</span>
              {a.tab && (
                <button type="button" style={{ ...linkBtn, fontSize: "12px" }} onClick={() => setTab(a.tab)}>
                  View
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {w && (
        <div style={section}>
          <h3 style={heading}>Where it is</h3>
          <span>{w.summary}</span>
          {w.unseen?.length > 0 && <span style={small}>Not visible to MonkeyBean: {w.unseen.map((x) => `${x.quantity} × ${x.name}`).join(", ")}</span>}
        </div>
      )}

      <div style={section}>
        <h3 style={heading}>Items</h3>
        {o.lines.map((l) => (
          <div key={l.id} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            {l.imageUrl ? <img src={l.imageUrl} alt="" width={36} height={36} style={{ borderRadius: "6px", objectFit: "cover", flexShrink: 0 }} /> : <span style={{ width: 36, height: 36, borderRadius: "6px", background: "#f1f1f1", flexShrink: 0 }} />}
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <div>
                {l.quantity} × {l.title}
                {l.variantTitle && <span style={muted}> · {l.variantTitle}</span>}
              </div>
              <div style={small}>{[l.sku, l.unfulfilled ? `${l.unfulfilled} to ship` : l.quantity ? "Shipped" : null, l.removed ? `${l.removed} removed` : null].filter(Boolean).join(" · ")}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ ...section, gap: "2px" }}>
        {row("Subtotal", money(m.subtotal))}
        {m.discounts && Number(m.discounts.amount) > 0 && row("Discounts", `−${money(m.discounts)}`)}
        {row(`Shipping${o.shippingMethods?.length ? ` (${o.shippingMethods.join(", ")})` : ""}`, money(m.shipping))}
        {row("Tax", money(m.tax))}
        {row("Total", money(m.total), true)}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px", ...section }}>
        <div style={{ display: "grid", gap: "2px", alignContent: "start" }}>
          <h3 style={heading}>Ship to</h3>
          {o.address ? (
            <>
              {(o.address.lines ?? [o.address.name, o.address.place, o.address.country]).filter(Boolean).map((x, i) => (
                <span key={i}>{x}</span>
              ))}
              {o.address.phone && <span style={small}>{o.address.phone}</span>}
            </>
          ) : (
            <span style={muted}>No shipping address</span>
          )}
        </div>
        <div style={{ display: "grid", gap: "4px", alignContent: "start" }}>
          <h3 style={heading}>Tracking</h3>
          {o.fulfillments.length === 0 && <span style={muted}>Nothing shipped yet</span>}
          {o.fulfillments.map((x) => (
            <div key={x.name} style={{ display: "grid" }}>
              <span>
                {x.status ?? "Shipped"} · {fmtDay(x.at)}
              </span>
              {x.tracking.map((t, i) => (
                <span key={i} style={small}>
                  {t.company ? `${t.company} ` : ""}
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                      {t.number ?? "Track"}
                    </a>
                  ) : (
                    t.number
                  )}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {(o.note || o.tags?.length > 0) && (
        <div style={{ display: "grid", gap: "4px" }}>
          {o.note && (
            <>
              <h3 style={heading}>Order note</h3>
              <span style={{ whiteSpace: "pre-wrap" }}>{o.note}</span>
            </>
          )}
          {o.tags?.length > 0 && <span style={small}>Tags: {o.tags.join(", ")}</span>}
        </div>
      )}
    </div>
  );
}

function ShippingTab({ d, openOrder, onOpenBatch }) {
  const a = d.audit;
  const where = d.where?.parts ?? [];
  const parts = a?.parts ?? [];
  const live = parts.filter((p) => !p.nothingSent);
  // Parts Shopify has that MonkeyBean doesn't (e.g. at another app's location)
  const known = new Set(parts.map((p) => p.fulfillmentOrderId).filter(Boolean));
  const extra = where.filter((w) => !known.has(w.fulfillmentOrderId) && w.status !== "CLOSED");
  if (!live.length && !extra.length) return <span style={muted}>MonkeyBean hasn't handled this order yet.</span>;
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      {live.map((p) => {
        const w = where.find((x) => x.fulfillmentOrderId === p.fulfillmentOrderId);
        const st = STATE[p.state];
        return (
          <Part
            key={p.id}
            p={p}
            multi
            canVideo={d.can?.video}
            openOrder={openOrder}
            onOpenBatch={onOpenBatch}
            extra={
              <div style={{ display: "grid", gap: "2px" }}>
                <span style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
                  {st && <span style={pill(st[1], st[2])}>{st[0]}</span>}
                  {w?.location && <span style={small}>{w.location}</span>}
                </span>
                {w?.verdict && <span style={{ ...small, color: w.problem ? "#7a4f01" : "#616161" }}>{w.verdict}</span>}
                {w?.holds?.length > 0 && <span style={small}>Holds: {w.holds.join("; ")}</span>}
              </div>
            }
          />
        );
      })}
      {extra.map((w) => (
        <div key={w.fulfillmentOrderId} style={{ display: "grid", gap: "4px", border: "1px solid #e3a008", borderRadius: "8px", padding: "10px" }}>
          <strong>In Shopify, not in MonkeyBean</strong>
          <span style={small}>
            {words(w.status)}
            {w.location ? ` · ${w.location}` : ""}
          </span>
          <span>{w.verdict}</span>
          <span style={small}>{w.lines.map((l) => `${l.quantity} × ${l.name}`).join(", ")}</span>
        </div>
      ))}
      {parts.some((p) => p.nothingSent) && <EmptyParts parts={parts.filter((p) => p.nothingSent)} />}
    </div>
  );
}

function ReturnsTab({ d, reload, onStart }) {
  const list = d.returns ?? [];
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      {list.length === 0 && <span style={muted}>No returns for this order.</span>}
      {list.map((r) => (
        <ReturnCard key={r.id} r={r} canReturns={d.can?.returns} onChanged={reload} />
      ))}
      {d.can?.returns && (
        <div>
          <button type="button" style={btn} onClick={onStart}>
            Start a return
          </button>
        </div>
      )}
    </div>
  );
}

function HistoryTab({ d }) {
  const a = d.audit;
  if (!a?.history?.length) return <span style={muted}>Nothing logged in MonkeyBean yet.</span>;
  return (
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
  );
}
