import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { OrderLink } from "./OrderLink";
import { MethodBadge } from "./MethodBadge";
import { box, fmtDate, muted, pill, small } from "./ui";

// Order Merge: a customer's open orders to the same address, shipped in one box.
// The main order (left) goes in whole; tick which items of the other orders
// (right) go with it. Its label is bought in Shopify as usual; the app then
// fulfills the ticked items of the other orders with the same tracking.

const label = (l) => `${l.title}${l.variantTitle ? ` – ${l.variantTitle}` : ""}`;
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

function StatePill({ s }) {
  if (s.state === "ready") return <span style={pill("#e3f1df", "#1a5e20")}>Ready</span>;
  return (
    <span style={pill("#fff1e3", "#8a4b00")} title={s.waitingReason ?? ""}>
      Waiting{s.releaseDay ? ` · releases ${dayLabel(s.releaseDay)}` : ""}
    </span>
  );
}

function Lines({ s, picks = null, onToggle = null }) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: "6px" }}>
      {s.lines.map((l) => {
        const on = picks ? picks.has(l.id) : true;
        return (
          <li key={l.id} style={{ display: "flex", gap: "8px", alignItems: "center", opacity: on ? 1 : 0.6 }}>
            {picks && (
              <input type="checkbox" checked={on} onChange={() => onToggle(l.id)} aria-label={`Put ${label(l)} from ${s.orderName} in the box`} style={{ margin: 0, width: "18px", height: "18px" }} />
            )}
            {l.imageUrl ? (
              <img src={l.imageUrl} alt="" style={{ width: "32px", height: "32px", objectFit: "cover", borderRadius: "4px", flexShrink: 0 }} />
            ) : (
              <span style={{ width: "32px", height: "32px", borderRadius: "4px", background: "#f1f1f1", flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{l.quantity} ×</span> {label(l)}
              {l.sku && <span style={small}> · {l.sku}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function OrderCard({ s, children, right = null }) {
  return (
    <div style={{ ...box, padding: "12px", overflow: "visible" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <OrderLink orderId={s.orderId} orderNumber={s.orderNumber} name={s.orderName} />
        {s.part && <span style={small}>part {s.part}</span>}
        <StatePill s={s} />
        <span style={{ flex: 1 }} />
        {right}
      </div>
      <div style={{ ...small, marginTop: "4px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        Ordered {fmtDate(s.orderCreatedAt)}
        {s.shippingMethod && <MethodBadge method={s.shippingMethod} />}
      </div>
      {s.state !== "ready" && s.waitingReason && <div style={{ ...small, color: "#8a4b00", marginTop: "4px" }}>{s.waitingReason}</div>}
      {children}
    </div>
  );
}

function Group({ g }) {
  const fetcher = useFetcher();
  const ready = g.shipments.filter((s) => s.state === "ready");
  const [mainId, setMainId] = useState(ready[0]?.id);
  const main = g.shipments.find((s) => s.id === mainId) ?? ready[0];
  const others = g.shipments.filter((s) => s.id !== main.id && s.orderId !== main.orderId);
  // Ticked items: ready orders' items to start with; waiting orders' items are left for the person to choose
  const startPicks = () => new Map(others.map((s) => [s.id, new Set(s.state === "ready" ? s.lines.map((l) => l.id) : [])]));
  const [picks, setPicks] = useState(startPicks);
  useEffect(() => setPicks(startPicks()), [mainId]); // eslint-disable-line react-hooks/exhaustive-deps
  const methods = useMemo(() => [...new Set(g.shipments.map((s) => s.shippingMethod).filter(Boolean))], [g.shipments]);
  const [method, setMethod] = useState(main.shippingMethod ?? methods[0] ?? "");
  useEffect(() => setMethod(main.shippingMethod ?? methods[0] ?? ""), [mainId]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (sid, lid) =>
    setPicks((cur) => {
      const n = new Map(cur);
      const set = new Set(n.get(sid) ?? []);
      if (set.has(lid)) set.delete(lid);
      else set.add(lid);
      n.set(sid, set);
      return n;
    });
  const chosen = others.flatMap((s) => s.lines.filter((l) => picks.get(s.id)?.has(l.id)).map((l) => ({ s, l })));
  const items = chosen.reduce((n, x) => n + x.l.quantity, 0);
  const notReady = [...new Set(chosen.filter((x) => x.s.state !== "ready").map((x) => x.s.orderName))];
  const busy = fetcher.state !== "idle";
  const result = fetcher.data?.intent === "mergeOrders" ? fetcher.data : null;
  const submit = () =>
    fetcher.submit(
      {
        intent: "mergeOrders",
        main: String(main.id),
        method,
        riders: JSON.stringify(others.map((s) => ({ shipmentId: s.id, lineIds: [...(picks.get(s.id) ?? [])] })).filter((r) => r.lineIds.length)),
      },
      { method: "post" },
    );

  if (result?.ok)
    return (
      <s-banner tone="success" heading={`${result.mainOrderName} now ships with ${result.items} more item${result.items === 1 ? "" : "s"}`}>
        <s-paragraph>Batch {result.mainOrderName} as usual: the other orders' items are on its pick list, packing slip and pack bench.</s-paragraph>
      </s-banner>
    );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px", alignItems: "start" }}>
      <div>
        <div style={{ ...small, fontWeight: 700, marginBottom: "6px" }}>Main order: goes in the box whole{ready.length > 1 ? "" : ""}</div>
        <OrderCard s={main}>
          <Lines s={main} />
        </OrderCard>
      </div>
      <div style={{ display: "grid", gap: "10px" }}>
        <div style={{ ...small, fontWeight: 700 }}>Tick what goes in the same box</div>
        {others.map((s) => (
          <OrderCard
            key={s.id}
            s={s}
            right={
              s.state === "ready" && ready.length > 1 ? (
                <button type="button" onClick={() => setMainId(s.id)} style={{ appearance: "none", border: 0, background: "none", color: "#005bd3", font: "inherit", fontSize: "12px", cursor: "pointer", padding: 0 }}>
                  Make this the main order
                </button>
              ) : null
            }
          >
            <Lines s={s} picks={picks.get(s.id) ?? new Set()} onToggle={(lid) => toggle(s.id, lid)} />
          </OrderCard>
        ))}
      </div>
      <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", paddingTop: "4px" }}>
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          Ship by
          <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Shipping method for the box" style={{ font: "inherit", padding: "5px 8px", borderRadius: "8px", border: "1px solid #c9c9c9" }}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            {!methods.length && <option value="">Main order's method</option>}
          </select>
        </label>
        <s-button variant="primary" onClick={submit} {...(busy ? { loading: true } : {})} {...(!items ? { disabled: true } : {})}>
          {items ? `Ship ${items} more item${items === 1 ? "" : "s"} with ${main.orderName}` : "Tick items to merge"}
        </s-button>
        {notReady.length > 0 && <span style={{ ...small, color: "#8a4b00" }}>Not ready yet: {notReady.join(", ")}. Make sure those items are on the shelf before packing.</span>}
        {result?.error && <span style={{ color: "#b42318" }}>{result.error}</span>}
      </div>
    </div>
  );
}

function Merges({ merges }) {
  const fetcher = useFetcher();
  if (!merges.length) return null;
  const status = (m) =>
    m.status === "shipped"
      ? pill("#e3f1df", "#1a5e20")
      : m.status === "cancelled"
        ? pill("#f1f1f1", "#4a4a4a")
        : m.error
          ? pill("#fde7e9", "#8e1f0b")
          : pill("#eef3ff", "#1c4a9c");
  const statusText = (m) =>
    m.status === "shipped" ? "Shipped" : m.status === "cancelled" ? "Ended" : m.error ? "Needs attention" : m.mainState === "shipped" ? "Fulfilling the others…" : m.batchId ? "In a batch" : "To batch";
  return (
    <s-section heading="Merged boxes">
      <div style={{ display: "grid", gap: "8px" }}>
        {merges.map((m) => (
          <div key={m.id} style={{ ...box, padding: "10px 12px", overflow: "visible", display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
            <span style={{ flex: "1 1 320px", minWidth: 0 }}>
              <OrderLink orderId={m.mainOrderId} orderNumber={m.mainOrderId?.split("/").pop()} name={m.mainOrderName} />{" "}
              <span>
                + {m.riders.map((r) => `${r.items} from ${r.orderName}${r.done ? " ✓" : ""}`).join(", ")}
              </span>
              <div style={small}>
                {m.method ? `${m.method} · ` : ""}merged {fmtDate(m.createdAt, true)}
                {m.createdBy ? ` by ${m.createdBy}` : ""}
                {m.shippedAt ? ` · shipped ${fmtDate(m.shippedAt, true)}` : ""}
              </div>
              {m.error && <div style={{ ...small, color: "#b42318" }}>{m.error}</div>}
            </span>
            <span style={status(m)}>{statusText(m)}</span>
            {m.canUndo && (
              <s-button variant="tertiary" onClick={() => fetcher.submit({ intent: "undoMerge", id: String(m.id) }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
                Undo
              </s-button>
            )}
          </div>
        ))}
      </div>
      {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "8px" }}>{fetcher.data.error}</div>}
    </s-section>
  );
}

export function MergeTab({ data }) {
  const [open, setOpen] = useState(null);
  if (!data) return null;
  const { groups, addressesChecked, merges } = data;
  return (
    <>
      <s-section heading="Order Merge">
        <s-paragraph>
          <span style={muted}>
            Customers with more than one open order to the same address. Merge to send them in one box: the main order goes in whole, and you choose which items of
            the other orders go with it. Buy the label on the main order in Shopify as usual; the app then marks the other orders' items as shipped with the same
            tracking number, and Shopify emails the customer for each order.
          </span>
        </s-paragraph>
        {!addressesChecked && groups.length > 0 && (
          <div style={{ margin: "10px 0" }}>
            <s-banner tone="warning">
              <s-paragraph>Shopify didn't share shipping addresses, so these are grouped by customer only. Check the addresses match before merging.</s-paragraph>
            </s-banner>
          </div>
        )}
        {!groups.length ? (
          <s-paragraph>Nothing to merge: no customer has more than one open order to the same address right now (with at least one ready to ship).</s-paragraph>
        ) : (
          <div style={{ display: "grid", gap: "10px", marginTop: "10px" }}>
            {groups.map((g) => {
              const orders = new Set(g.shipments.map((s) => s.orderId)).size;
              const isOpen = open === g.key;
              return (
                <div key={g.key} style={{ ...box, padding: "12px 14px", overflow: "visible" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
                    <strong>{g.customerName ?? "Customer"}</strong>
                    <span style={small}>{orders} orders · {g.shipments.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.quantity, 0), 0)} items</span>
                    <span style={small}>{g.shipments.map((s) => s.orderName).join(", ")}</span>
                    <span style={{ flex: 1 }} />
                    <s-button variant={isOpen ? "tertiary" : "secondary"} onClick={() => setOpen(isOpen ? null : g.key)}>
                      {isOpen ? "Close" : "Review and merge"}
                    </s-button>
                  </div>
                  {g.address && <div style={{ ...small, marginTop: "4px" }}>{Array.isArray(g.address) ? g.address.join(", ") : g.address}</div>}
                  {isOpen && (
                    <div style={{ marginTop: "12px" }}>
                      <Group g={g} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </s-section>
      <Merges merges={merges} />
    </>
  );
}
