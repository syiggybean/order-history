import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { OrderLink } from "./OrderLink";
import { MethodBadge } from "./MethodBadge";
import { box, fmtDate, input, muted, pill, small, useParamSetter } from "./ui";

// Order Merge: find a customer, see their open orders and history, and arrange
// their items into boxes any way you like (ready or not). An order split across
// boxes becomes separate shipments in Shopify; a box with several orders ships as
// one (label on one order, the others fulfilled with the same tracking).

const label = (l) => `${l.title}${l.variantTitle ? ` – ${l.variantTitle}` : ""}`;
const dayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" };

function StatePill({ o }) {
  if (!o) return null;
  if (o.state === "ready") return <span style={pill("#e3f1df", "#1a5e20")}>Ready</span>;
  return (
    <span style={pill("#fff1e3", "#8a4b00")} title={o.waitingReason ?? ""}>
      Waiting{o.releaseDay ? ` · releases ${dayLabel(o.releaseDay)}` : ""}
    </span>
  );
}

// ---- Finding a customer -------------------------------------------------------

function CustomerSearch() {
  const fetcher = useFetcher();
  const go = useParamSetter();
  const [q, setQ] = useState("");
  const timer = useRef(null);
  const results = fetcher.data?.intent === "findCustomers" ? fetcher.data.customers : null;
  const ask = (text) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fetcher.submit({ intent: "findCustomers", q: text }, { method: "post" }), 250);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fetcher.submit({ intent: "findCustomers", q }, { method: "post" });
        }}
        style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}
      >
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (e.target.value.trim().length >= 2) ask(e.target.value.trim());
          }}
          placeholder="Customer name or order number"
          aria-label="Find a customer"
          style={{ ...input, flex: "1 1 280px", maxWidth: "420px", padding: "8px 10px" }}
        />
        <s-button variant="primary" onClick={() => fetcher.submit({ intent: "findCustomers", q }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
          Find customer
        </s-button>
      </form>
      {results && (
        <div style={{ marginTop: "10px", display: "grid", gap: "6px" }}>
          {!results.length && <div style={small}>No customers matching "{fetcher.data.q}".</div>}
          {results.map((c) => (
            <button
              key={c.customerId}
              type="button"
              onClick={() => go({ customer: c.customerId }, { replace: false })}
              style={{ ...box, overflow: "visible", textAlign: "left", background: "#fff", padding: "8px 12px", font: "inherit", cursor: "pointer", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}
            >
              <strong>{c.name ?? "Customer"}</strong>
              <span style={small}>
                {c.openOrders} open order{c.openOrders === 1 ? "" : "s"} · {c.orders} in all · last ordered {fmtDate(c.lastOrderAt)}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ color: "#005bd3", fontWeight: 600 }}>Plan boxes →</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- The planner ----------------------------------------------------------------

let rowSeq = 0;
const rowsFrom = (plan) => plan.boxes.flatMap((b, bi) => b.lines.map((l) => ({ ...l, rid: ++rowSeq, box: bi })));
const metaFrom = (plan) => plan.boxes.map((b) => ({ labelShipmentId: b.labelShipmentId, method: b.method ?? "", sameAddress: false }));

function Planner({ plan }) {
  const go = useParamSetter();
  const save = useFetcher();
  const [rows, setRows] = useState(() => rowsFrom(plan));
  const [meta, setMeta] = useState(() => metaFrom(plan));
  const planKey = JSON.stringify(plan.boxes);
  useEffect(() => {
    setRows(rowsFrom(plan));
    setMeta(metaFrom(plan));
  }, [planKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const orderOf = useMemo(() => new Map(plan.orders.map((o) => [o.shipmentId, o])), [plan.orders]);

  const move = (rid, to) => {
    if (to === "new") {
      setMeta((m) => [...m, { labelShipmentId: null, method: "", sameAddress: false }]);
      setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, box: meta.length } : r)));
    } else setRows((rs) => rs.map((r) => (r.rid === rid ? { ...r, box: Number(to) } : r)));
  };
  const splitOne = (rid) =>
    setRows((rs) => rs.flatMap((r) => (r.rid === rid && r.quantity > 1 ? [{ ...r, quantity: r.quantity - 1 }, { ...r, rid: ++rowSeq, quantity: 1 }] : [r])));
  const addBox = () => setMeta((m) => [...m, { labelShipmentId: null, method: "", sameAddress: false }]);
  const reset = () => {
    setRows(rowsFrom(plan));
    setMeta(metaFrom(plan));
  };

  // What each box holds
  const boxes = meta.map((m, i) => {
    const items = rows.filter((r) => r.box === i);
    const sids = [...new Set(items.map((r) => r.shipmentId))];
    const orders = sids.map((sid) => orderOf.get(sid)).filter(Boolean);
    const labelId = sids.includes(m.labelShipmentId) ? m.labelShipmentId : (orders.find((o) => o.state === "ready") ?? orders[0])?.shipmentId ?? null;
    const methods = [...new Set(orders.map((o) => o.shippingMethod).filter(Boolean))];
    const method = m.method && methods.includes(m.method) ? m.method : (orderOf.get(labelId)?.shippingMethod ?? methods[0] ?? "");
    const waiting = orders.filter((o) => o.state !== "ready");
    const addresses = new Set(orders.map((o) => o.addressKey).filter(Boolean));
    return { i, items, orders, labelId, methods, method, waiting, mixedAddress: addresses.size > 1 && !m.sameAddress, addressDiffers: addresses.size > 1, sameAddress: m.sameAddress };
  });
  const used = boxes.filter((b) => b.items.length);
  // What will change
  const splits = plan.orders
    .map((o) => ({ o, n: new Set(rows.filter((r) => r.shipmentId === o.shipmentId).map((r) => r.box)).size }))
    .filter((x) => x.n > 1);
  const together = used.filter((b) => b.orders.length > 1);
  const changed = JSON.stringify(rows.map((r) => [r.shipmentId, r.id, r.quantity, r.box]).sort()) !== JSON.stringify(rowsFrom(plan).map((r) => [r.shipmentId, r.id, r.quantity, r.box]).sort()) || JSON.stringify(meta) !== JSON.stringify(metaFrom(plan));
  const blocked = used.some((b) => b.mixedAddress);
  const submit = () => {
    const out = used.map((b) => {
      const sum = new Map();
      for (const r of b.items) {
        const k = `${r.shipmentId}|${r.id}`;
        sum.set(k, { shipmentId: r.shipmentId, id: r.id, quantity: (sum.get(k)?.quantity ?? 0) + r.quantity });
      }
      return { items: [...sum.values()], labelShipmentId: b.labelId, method: b.method || null, ...(b.sameAddress && b.addressDiffers ? { sameAddress: true } : {}) };
    });
    save.submit({ intent: "saveBoxes", customer: plan.customerId, plan: JSON.stringify({ boxes: out }) }, { method: "post" });
  };
  const result = save.data?.intent === "saveBoxes" ? save.data : null;
  const boxName = (i) => `Box ${used.findIndex((b) => b.i === i) + 1 || i + 1}`;

  return (
    <>
      <s-section>
        <button type="button" style={{ ...linkBtn, marginBottom: "8px" }} onClick={() => go({ customer: null }, { replace: false })}>
          ← All customers
        </button>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "baseline" }}>
          <h2 style={{ margin: 0, fontSize: "20px" }}>{plan.name ?? "Customer"}</h2>
          <span style={small}>
            {plan.orders.length} open order{plan.orders.length === 1 ? "" : "s"} to plan
            {plan.inWork.length ? ` · ${plan.inWork.length} already in a batch` : ""}
          </span>
        </div>
        {!plan.addressesChecked && plan.orders.length > 1 && (
          <div style={{ marginTop: "10px" }}>
            <s-banner tone="warning">
              <s-paragraph>Shopify didn't share shipping addresses, so check the orders in a box all go to the same address.</s-paragraph>
            </s-banner>
          </div>
        )}
        {result?.ok && (
          <div style={{ marginTop: "10px" }} className="sh-rise">
            <s-banner tone="success" heading={`Saved: ${result.boxes} box${result.boxes === 1 ? "" : "es"}`}>
              <s-paragraph>
                {[result.splits?.length ? `Split in Shopify: ${result.splits.join(", ")}.` : null, result.merged?.length ? `Shipping together: ${result.merged.join("; ")}.` : null].filter(Boolean).join(" ") ||
                  "No changes needed."}
              </s-paragraph>
            </s-banner>
          </div>
        )}
        {result?.error && (
          <div style={{ marginTop: "10px" }}>
            <s-banner tone="critical">
              <s-paragraph>{result.error}</s-paragraph>
            </s-banner>
          </div>
        )}

        {!plan.orders.length ? (
          <s-paragraph>No open orders to plan for this customer (orders already in a batch are listed below).</s-paragraph>
        ) : (
          <>
            <div style={{ ...small, margin: "12px 0 8px" }}>
              Move items between boxes with the Box menu; Split takes one off to move it on its own. Each box ships as one package; ready or not is up to you (a box
              waits until everything in it is ready).
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "12px", alignItems: "start" }}>
              {boxes.map((b) =>
                !b.items.length && b.i < plan.boxes.length ? null : (
                  <div key={b.i} style={{ ...box, overflow: "visible", padding: "12px", background: b.items.length ? "#fff" : "#fafafa", borderStyle: b.items.length ? "solid" : "dashed" }}>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "15px" }}>{b.items.length ? boxName(b.i) : "New box"}</strong>
                      {b.items.length > 0 && <span style={small}>{b.items.reduce((n, r) => n + r.quantity, 0)} items</span>}
                      <span style={{ flex: 1 }} />
                      {b.items.length > 0 &&
                        (b.waiting.length ? (
                          <span style={pill("#fff1e3", "#8a4b00")} title={b.waiting.map((o) => `${o.orderName}: ${o.waitingReason ?? "waiting"}`).join("\n")}>
                            Waits for {b.waiting.map((o) => o.orderName).join(", ")}
                          </span>
                        ) : (
                          <span style={pill("#e3f1df", "#1a5e20")}>Ready</span>
                        ))}
                    </div>
                    {!b.items.length && <div style={{ ...small, marginTop: "6px" }}>Move items here with their Box menu.</div>}
                    {b.addressDiffers && (
                      <div style={{ marginTop: "6px", padding: "8px 10px", borderRadius: "8px", background: b.sameAddress ? "#f6f6f7" : "#fde7e9", fontSize: "12px" }}>
                        <div style={{ color: b.sameAddress ? "#4a4a4a" : "#8e1f0b", fontWeight: 600 }}>Shopify has different addresses on these orders:</div>
                        {b.orders.map((o) => (
                          <div key={o.shipmentId} style={{ marginTop: "2px" }}>
                            <strong>{o.orderName}:</strong> {Array.isArray(o.address) ? o.address.join(", ") : (o.address ?? "no address")}
                          </div>
                        ))}
                        <label style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "6px", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={b.sameAddress}
                            onChange={(e) => setMeta((m) => m.map((x, j) => (j === b.i ? { ...x, sameAddress: e.target.checked } : x)))}
                          />
                          It's the same place: ship them together (the label goes to {orderOf.get(b.labelId)?.orderName ?? "the label order"}'s address)
                        </label>
                      </div>
                    )}
                    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gap: "8px" }}>
                      {b.items.map((r) => {
                        const o = orderOf.get(r.shipmentId);
                        return (
                          <li key={r.rid} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            {r.imageUrl ? (
                              <img src={r.imageUrl} alt="" style={{ width: "34px", height: "34px", objectFit: "cover", borderRadius: "4px", flexShrink: 0 }} />
                            ) : (
                              <span style={{ width: "34px", height: "34px", borderRadius: "4px", background: "#f1f1f1", flexShrink: 0 }} />
                            )}
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span style={{ fontWeight: 600 }}>{r.quantity} ×</span> {label(r)}
                              <div style={small}>
                                {o?.orderName}
                                {o?.state !== "ready" ? ` · ${o?.releaseDay ? `releases ${dayLabel(o.releaseDay)}` : "waiting"}` : ""}
                              </div>
                            </span>
                            {r.quantity > 1 && (
                              <button type="button" style={{ ...linkBtn, fontSize: "12px" }} onClick={() => splitOne(r.rid)} title="Take one off, to move it on its own">
                                Split
                              </button>
                            )}
                            <select value={r.box} onChange={(e) => move(r.rid, e.target.value)} aria-label={`Box for ${label(r)} (${o?.orderName})`} style={{ ...input, padding: "3px 4px", fontSize: "12px" }}>
                              {boxes
                                .filter((x) => x.items.length || x.i === r.box || x.i >= plan.boxes.length)
                                .map((x) => (
                                  <option key={x.i} value={x.i}>
                                    {x.items.length ? boxName(x.i) : "New box"}
                                  </option>
                                ))}
                              <option value="new">+ New box</option>
                            </select>
                          </li>
                        );
                      })}
                    </ul>
                    {b.orders.length > 0 && (
                      <div style={{ display: "grid", gap: "6px", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #eee", fontSize: "13px" }}>
                        {b.orders.length > 1 && (
                          <label style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                            Label on
                            <select
                              value={b.labelId ?? ""}
                              onChange={(e) => setMeta((m) => m.map((x, j) => (j === b.i ? { ...x, labelShipmentId: Number(e.target.value) } : x)))}
                              aria-label={`Order to buy the label on for ${boxName(b.i)}`}
                              style={{ ...input, padding: "3px 6px" }}
                            >
                              {b.orders.map((o) => (
                                <option key={o.shipmentId} value={o.shipmentId}>
                                  {o.orderName}
                                </option>
                              ))}
                            </select>
                            <span style={small}>the others are marked shipped with its tracking</span>
                          </label>
                        )}
                        {b.methods.length > 1 ? (
                          <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                            Ship by
                            <select
                              value={b.method}
                              onChange={(e) => setMeta((m) => m.map((x, j) => (j === b.i ? { ...x, method: e.target.value } : x)))}
                              aria-label={`Shipping method for ${boxName(b.i)}`}
                              style={{ ...input, padding: "3px 6px" }}
                            >
                              {b.methods.map((x) => (
                                <option key={x} value={x}>
                                  {x}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          b.method && (
                            <span style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
                              Ship by <MethodBadge method={b.method} />
                            </span>
                          )
                        )}
                      </div>
                    )}
                  </div>
                ),
              )}
              <button type="button" onClick={addBox} style={{ ...box, overflow: "visible", borderStyle: "dashed", background: "#fff", minHeight: "80px", font: "inherit", color: "#005bd3", fontWeight: 600, cursor: "pointer" }}>
                + New box
              </button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginTop: "14px" }}>
              <s-button variant="primary" onClick={submit} {...(save.state !== "idle" ? { loading: true } : {})} {...(!changed || blocked ? { disabled: true } : {})}>
                Save boxes
              </s-button>
              {changed && (
                <s-button variant="tertiary" onClick={reset}>
                  Undo changes
                </s-button>
              )}
              <span style={small}>
                {!changed
                  ? "Showing how these orders ship today."
                  : [splits.length ? `Splits ${splits.map((x) => `${x.o.orderName} into ${x.n}`).join(", ")} in Shopify` : null, together.length ? `${together.length} box${together.length === 1 ? "" : "es"} with more than one order` : null]
                      .filter(Boolean)
                      .join(" · ") || "Saves the new arrangement"}
              </span>
            </div>
          </>
        )}
      </s-section>

      <s-section heading="Orders">
        <div style={{ ...box }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <tbody>
              {plan.orders.map((o) => (
                <tr key={`o${o.shipmentId}`}>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>
                    <OrderLink orderId={o.orderId} orderNumber={o.orderNumber} name={o.orderName} />
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>{fmtDate(o.orderCreatedAt)}</td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>
                    <StatePill o={o} />
                    {o.state !== "ready" && o.waitingReason && <div style={small}>{o.waitingReason}</div>}
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>{o.shippingMethod ? <MethodBadge method={o.shippingMethod} /> : "—"}</td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee", ...small }}>{Array.isArray(o.address) ? o.address.join(", ") : (o.address ?? "")}</td>
                </tr>
              ))}
              {plan.inWork.map((o) => (
                <tr key={`w${o.shipmentId}`} style={{ opacity: 0.75 }}>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>
                    <OrderLink orderId={o.orderId} orderNumber={o.orderNumber} name={o.orderName} />
                  </td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>{fmtDate(o.orderCreatedAt)}</td>
                  <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }} colSpan={3}>
                    <span style={pill("#eef3ff", "#1c4a9c")}>{o.state === "packed" || o.state === "labeling" ? "Packed" : "In a batch"}</span>{" "}
                    <span style={small}>Take it out of its batch to re-plan it. {o.items.map((i) => `${i.quantity} × ${label(i)}`).join(", ")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>

      {plan.history.length > 0 && (
        <s-section heading="Order history">
          <div style={{ ...box }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <tbody>
                {plan.history.map((o) => (
                  <tr key={o.shipmentId}>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>
                      <OrderLink orderId={o.orderId} orderNumber={o.orderNumber} name={o.orderName} />
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>{fmtDate(o.orderCreatedAt)}</td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee" }}>
                      {o.state === "shipped" ? <span style={pill("#f1f1f1", "#1a5e20")}>Shipped{o.closedAt ? ` ${fmtDate(o.closedAt)}` : ""}</span> : <span style={pill("#f1f1f1", "#4a4a4a")}>Closed</span>}
                    </td>
                    <td style={{ padding: "8px 10px", borderBottom: "1px solid #eee", ...small }}>{o.items.map((i) => `${i.quantity} × ${label(i)}`).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </s-section>
      )}
    </>
  );
}

// ---- Merges list -------------------------------------------------------------------

function Merges({ merges }) {
  const fetcher = useFetcher();
  if (!merges?.length) return null;
  const status = (m) =>
    m.status === "shipped" ? pill("#e3f1df", "#1a5e20") : m.status === "cancelled" ? pill("#f1f1f1", "#4a4a4a") : m.error ? pill("#fde7e9", "#8e1f0b") : pill("#eef3ff", "#1c4a9c");
  const statusText = (m) =>
    m.status === "shipped" ? "Shipped" : m.status === "cancelled" ? "Ended" : m.error ? "Needs attention" : m.mainState === "shipped" ? "Fulfilling the others…" : m.batchId ? "In a batch" : "To batch";
  return (
    <s-section heading="Boxes with more than one order">
      <div style={{ display: "grid", gap: "8px" }}>
        {merges.map((m) => (
          <div key={m.id} style={{ ...box, padding: "10px 12px", overflow: "visible", display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
            <span style={{ flex: "1 1 320px", minWidth: 0 }}>
              <OrderLink orderId={m.mainOrderId} orderNumber={m.mainOrderId?.split("/").pop()} name={m.mainOrderName} />{" "}
              <span>+ {m.riders.map((r) => `${r.items} from ${r.orderName}${r.done ? " ✓" : ""}`).join(", ")}</span>
              <div style={small}>
                {m.method ? `${m.method} · ` : ""}planned {fmtDate(m.createdAt, true)}
                {m.createdBy ? ` by ${m.createdBy}` : ""}
                {m.shippedAt ? ` · shipped ${fmtDate(m.shippedAt, true)}` : ""}
              </div>
              {m.error && <div style={{ ...small, color: "#b42318" }}>{m.error}</div>}
            </span>
            <span style={status(m)}>{statusText(m)}</span>
            {m.canUndo && (
              <s-button variant="tertiary" onClick={() => fetcher.submit({ intent: "undoMerge", id: String(m.id) }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
                Ship separately
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
  const go = useParamSetter();
  if (!data) return null;
  if (data.plan !== undefined)
    return data.plan ? (
      <Planner plan={data.plan} />
    ) : (
      <s-section>
        <button type="button" style={linkBtn} onClick={() => go({ customer: null }, { replace: false })}>
          ← All customers
        </button>
        <s-paragraph>That customer couldn't be found.</s-paragraph>
      </s-section>
    );
  const { groups = [], merges = [] } = data;
  return (
    <>
      <s-section heading="Order Merge">
        <s-paragraph>
          <span style={muted}>
            Find a customer to see their open orders and order history, then arrange their items into boxes however you like: ship orders together, or split an
            order to send part of it now. Buy each box's label on one of its orders in Shopify as usual; the app marks the box's other orders shipped with the
            same tracking, and Shopify emails the customer for each.
          </span>
        </s-paragraph>
        <div style={{ marginTop: "10px" }}>
          <CustomerSearch />
        </div>
      </s-section>
      {groups.length > 0 && (
        <s-section heading="Suggestions: several open orders to one address">
          <div style={{ display: "grid", gap: "6px" }}>
            {groups.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => go({ customer: g.customerId }, { replace: false })}
                style={{ ...box, overflow: "visible", textAlign: "left", background: "#fff", padding: "8px 12px", font: "inherit", cursor: "pointer", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" }}
              >
                <strong>{g.customerName ?? "Customer"}</strong>
                <span style={small}>{g.shipments.map((s) => s.orderName).join(", ")}</span>
                {g.address && <span style={small}>{Array.isArray(g.address) ? g.address.join(", ") : g.address}</span>}
                <span style={{ flex: 1 }} />
                <span style={{ color: "#005bd3", fontWeight: 600 }}>Plan boxes →</span>
              </button>
            ))}
          </div>
        </s-section>
      )}
      <Merges merges={merges} />
    </>
  );
}
