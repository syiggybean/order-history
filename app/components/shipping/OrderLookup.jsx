import { useContext, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Flyout } from "../Flyout";
import { ShopAdminContext } from "./Notice";
import { STORE_TZ, muted, pill, small } from "./ui";

// "Find an order": type an order number, see where it is in Shipping or why it isn't listed.

const STATE_TAB = { ready: "ready", waiting: "waiting", batched: "batches", packed: "batches", labeling: "batches" };
const STATE_LABEL = {
  ready: ["Ready to ship", "#cdfee1", "#0c5132"],
  waiting: ["Waiting", "#fff1c2", "#5e4200"],
  batched: ["In a batch", "#e0f0ff", "#00427c"],
  packed: ["Packed", "#e0f0ff", "#00427c"],
  labeling: ["Labeling", "#e0f0ff", "#00427c"],
  shipped: ["Shipped", "#f1f1f1", "#303030"],
  closed: ["Closed in app", "#fee8eb", "#8e1f0b"],
};
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: STORE_TZ, dateStyle: "medium", timeStyle: "short" }) : "");
const words = (s) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—");

export function OrderLookupBox({ onGo }) {
  const fetcher = useFetcher();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const busy = fetcher.state !== "idle";
  const data = fetcher.data?.intent === "lookupOrder" || fetcher.data?.intent === "resyncOrder" ? fetcher.data : null;
  useEffect(() => {
    if (data && !busy) setOpen(true);
  }, [data, busy]);

  const submit = (intent) => fetcher.submit({ intent, q: text }, { method: "post" });
  return (
    <>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) submit("lookupOrder");
        }}
        style={{ display: "flex", gap: "6px", alignItems: "center", marginLeft: "auto", padding: "4px 0" }}
      >
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Find order #"
          aria-label="Find an order by number"
          style={{ width: "130px", padding: "6px 8px", border: "1px solid #8a8a8a", borderRadius: "8px", font: "inherit" }}
        />
        <s-button type="submit" disabled={busy || !text.trim() || undefined} loading={(busy && fetcher.formData?.get("intent") === "lookupOrder") || undefined}>
          Find
        </s-button>
      </form>
      {open && data && (
        <Flyout label="Order lookup" title={data.name ? `Where is ${data.name}?` : "Order lookup"} width={500} onClose={() => setOpen(false)}>
          <LookupResult
            data={data}
            busy={busy}
            onResync={() => submit("resyncOrder")}
            onGo={(tab, batchId) => {
              setOpen(false);
              onGo?.(tab, data.name, batchId);
            }}
          />
        </Flyout>
      )}
    </>
  );
}

export function LookupResult({ data, busy, onResync, onGo }) {
  const shopAdmin = useContext(ShopAdminContext);
  if (data.error) return <s-banner tone="critical">{data.error}</s-banner>;
  if (!data.found)
    return (
      <s-banner tone="warning" heading={`No order ${data.name} in Shopify`}>
        <s-paragraph>Check the number. Draft orders and orders from other stores don't show here.</s-paragraph>
      </s-banner>
    );
  const anyProblem = data.canResync;
  const listed = data.parts.find((p) => p.shipment && STATE_TAB[p.shipment.state]);
  const listedTab = listed ? STATE_TAB[listed.shipment.state] : null;
  return (
    <div style={{ display: "grid", gap: "14px" }}>
      <div
        role="status"
        style={{
          padding: "10px 12px",
          borderRadius: "8px",
          background: anyProblem ? "#fff1e3" : "#f1f8f5",
          borderLeft: `4px solid ${anyProblem ? "#e3a008" : "#29845a"}`,
        }}
      >
        <strong>{anyProblem ? "Not listed" : "Found"}</strong>
        <div style={{ marginTop: "4px" }}>{data.summary}</div>
        {data.resynced && <div style={{ ...small, marginTop: "6px" }}>Re-read from Shopify just now.</div>}
      </div>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        {listedTab && <s-button onClick={() => onGo(listedTab, listed.shipment.batchId)}>Show on {listedTab === "ready" ? "Ready to ship" : listedTab === "waiting" ? "Waiting" : `batch ${listed.shipment.batchId}`}</s-button>}
        {onResync && (
          <s-button variant={anyProblem ? "primary" : "secondary"} onClick={onResync} disabled={busy || undefined} loading={busy || undefined}>
            Re-sync from Shopify
          </s-button>
        )}
        {shopAdmin && (
          <a href={`${shopAdmin}/orders/${data.number}`} target="_blank" rel="noreferrer" style={{ alignSelf: "center", color: "#005bd3", fontWeight: 600 }}>
            Open in Shopify ↗
          </a>
        )}
      </div>

      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
        <dt style={muted}>Placed</dt>
        <dd style={{ margin: 0 }}>{when(data.createdAt)}</dd>
        <dt style={muted}>Payment</dt>
        <dd style={{ margin: 0 }}>{data.payment ?? "—"}</dd>
        <dt style={muted}>Fulfillment</dt>
        <dd style={{ margin: 0 }}>{data.fulfillment ?? "—"}</dd>
        <dt style={muted}>Left to ship</dt>
        <dd style={{ margin: 0 }}>{data.unfulfilled} unit{data.unfulfilled === 1 ? "" : "s"}</dd>
        {data.cancelledAt && (
          <>
            <dt style={muted}>Cancelled</dt>
            <dd style={{ margin: 0 }}>{when(data.cancelledAt)}</dd>
          </>
        )}
      </dl>

      {data.unseen.length > 0 && (
        <div>
          <h3 style={{ fontSize: "13px", margin: "0 0 6px" }}>Items the app can't see</h3>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            {data.unseen.map((x, i) => (
              <li key={i}>
                {x.quantity} × {x.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 style={{ fontSize: "13px", margin: "0 0 6px" }}>In Shopify ({data.parts.length} part{data.parts.length === 1 ? "" : "s"})</h3>
        <div style={{ display: "grid", gap: "8px" }}>
          {data.parts.map((p, i) => {
            const st = p.shipment ? STATE_LABEL[p.shipment.state] : null;
            return (
              <div key={p.fulfillmentOrderId} style={{ border: `1px solid ${p.problem ? "#e3a008" : "#e3e3e3"}`, borderRadius: "8px", padding: "10px 12px" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>Part {i + 1}</strong>
                  <span style={pill("#f1f1f1", "#303030")}>{words(p.status)}</span>
                  {st && <span style={pill(st[1], st[2])}>{st[0]}</span>}
                  {p.location && <span style={small}>{p.location}</span>}
                </div>
                <div style={{ marginTop: "6px" }}>{p.verdict}</div>
                {p.holds.length > 0 && <div style={{ ...small, marginTop: "4px" }}>Holds: {p.holds.join("; ")}</div>}
                {p.lines.length > 0 && (
                  <ul style={{ ...small, margin: "6px 0 0", paddingLeft: "18px" }}>
                    {p.lines.map((l, j) => (
                      <li key={j}>
                        {l.quantity} × {l.name}
                        {!l.requiresShipping && " (doesn't need shipping)"}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          {!data.parts.length && <div style={muted}>Shopify returned no parts this app can see.</div>}
        </div>
      </div>

      {data.events.length > 0 && (
        <div>
          <h3 style={{ fontSize: "13px", margin: "0 0 6px" }}>Activity in Shipping</h3>
          <ul style={{ ...small, margin: 0, paddingLeft: "18px" }}>
            {data.events.map((e) => (
              <li key={e.id}>
                {when(e.at)} · {e.detail ?? words(e.type)}
                {e.userName ? ` · ${e.userName}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
