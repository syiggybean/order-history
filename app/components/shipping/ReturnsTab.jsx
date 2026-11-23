import { useContext, useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { OrderViewContext } from "./OrderLink";
import { useParamSetter } from "./ui";
import { RETURNS_ACTION, ReturnCard, StartReturnFlyout } from "../Returns";

// Shipping → Returns: customer requests to approve, returns on their way back,
// and verifying what arrived. Returns come from Shopify (customers request them
// there, or staff start them from an order); refunds stay in Shopify.

const STAGES = [
  { id: "requested", label: "Requested" },
  { id: "awaiting", label: "Awaiting arrival" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];
const small = { fontSize: "12px", color: "#616161" };
const chip = (on) => ({
  font: "inherit",
  fontSize: "13px",
  padding: "4px 12px",
  borderRadius: "999px",
  border: `1px solid ${on ? "#1a1a1a" : "#c9c9c9"}`,
  background: on ? "#1a1a1a" : "#fff",
  color: on ? "#fff" : "#303030",
  cursor: "pointer",
});
const input = { font: "inherit", fontSize: "13px", padding: "6px 8px", border: "1px solid #8a8a8a", borderRadius: "8px" };
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "never");

export function ReturnsTab({ data, canReturns }) {
  const go = useParamSetter();
  const revalidator = useRevalidator();
  const openOrder = useContext(OrderViewContext);
  const sync = useFetcher();
  const find = useFetcher();
  const [q, setQ] = useState(data.q ?? "");
  const [startFor, setStartFor] = useState(null);
  const [orderText, setOrderText] = useState("");
  const refresh = () => revalidator.state === "idle" && revalidator.revalidate();
  useEffect(() => {
    if (sync.data?.ok) refresh();
  }, [sync.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // "New return": find the order by its number, then choose what's coming back
  useEffect(() => {
    const d = find.data;
    if (d?.intent === "lookupOrder" && d.found && d.orderId) setStartFor(d.orderId);
  }, [find.data]);
  const c = data.counts ?? {};
  const count = (id) => (id === "requested" ? c.requested : id === "awaiting" ? c.awaiting : null);

  return (
    <div style={{ display: "grid", gap: "14px", padding: "12px 0" }}>
      {data.status?.lastError && (
        <s-banner tone={/permission/i.test(data.status.lastError) ? "warning" : "critical"} heading="Returns can't be read from Shopify right now">
          <s-paragraph>{data.status.lastError}</s-paragraph>
        </s-banner>
      )}

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        {STAGES.map((s) => (
          <button key={s.id} type="button" style={chip(data.stage === s.id)} onClick={() => go({ rstage: s.id === "requested" ? null : s.id })}>
            {s.label}
            {count(s.id) ? ` (${count(s.id)})` : ""}
          </button>
        ))}
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            go({ rq: q.trim() || null });
          }}
          style={{ display: "flex", gap: "6px", marginLeft: "auto" }}
        >
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order #, customer…" aria-label="Search returns" style={{ ...input, width: "180px" }} />
          <button type="submit" style={chip(false)}>
            Search
          </button>
        </form>
      </div>

      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
        {canReturns && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (orderText.trim()) find.submit({ intent: "lookupOrder", q: orderText }, { method: "post" });
            }}
            style={{ display: "flex", gap: "6px", alignItems: "center" }}
          >
            <span style={{ fontWeight: 600 }}>New return for order</span>
            <input value={orderText} onChange={(e) => setOrderText(e.target.value)} placeholder="#" aria-label="Order number for a new return" style={{ ...input, width: "100px" }} />
            <button type="submit" style={chip(false)} disabled={find.state !== "idle"}>
              {find.state !== "idle" ? "Finding…" : "Start"}
            </button>
            {find.data?.intent === "lookupOrder" && !find.data.found && <span style={{ color: "#8e1f0b" }}>No order {find.data.name} in Shopify.</span>}
            {find.data?.error && <span style={{ color: "#8e1f0b" }}>{find.data.error}</span>}
          </form>
        )}
        <span style={{ ...small, marginLeft: "auto" }}>
          Checked Shopify {when(data.status?.lastRunAt)} · every 10 minutes
        </span>
        <button type="button" style={chip(false)} disabled={sync.state !== "idle"} onClick={() => sync.submit({ intent: "syncReturns" }, { method: "post", action: RETURNS_ACTION })}>
          {sync.state !== "idle" ? "Checking…" : "Check now"}
        </button>
      </div>
      {sync.data?.error && <span style={{ color: "#8e1f0b" }}>{sync.data.error}</span>}

      {data.list.length === 0 ? (
        <s-paragraph>
          {data.stage === "requested"
            ? "No return requests waiting for a decision."
            : data.stage === "awaiting"
              ? "Nothing on its way back."
              : data.q
                ? `No returns match “${data.q}”.`
                : "No returns yet."}
        </s-paragraph>
      ) : (
        <div style={{ display: "grid", gap: "10px", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", alignItems: "start" }}>
          {data.list.map((r) => (
            <ReturnCard key={r.id} r={r} canReturns={canReturns} showOrder onOpenOrder={openOrder ? (id) => openOrder(id) : null} onChanged={refresh} />
          ))}
        </div>
      )}
      {startFor && (
        <StartReturnFlyout
          orderId={startFor}
          onClose={() => {
            setStartFor(null);
            setOrderText("");
          }}
          onDone={refresh}
        />
      )}
    </div>
  );
}
