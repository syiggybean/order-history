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

// Clearing old returns that were dealt with before MonkeyBean tracked them
function BulkHandled({ list, onDone }) {
  const f = useFetcher();
  const [days, setDays] = useState(30);
  const [note, setNote] = useState("");
  const [closeToo, setCloseToo] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const cutoff = Date.now() - days * 86400e3;
  const old = list.filter((r) => r.stage === "awaiting" && r.requestedAt && new Date(r.requestedAt).getTime() < cutoff);
  useEffect(() => {
    if (f.data?.ok) {
      setConfirming(false);
      onDone?.();
    }
  }, [f.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ display: "grid", gap: "8px", padding: "10px 12px", border: "1px solid #e3e3e3", borderRadius: "8px", background: "#fafafa" }}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <strong>Old returns</strong>
        <span>Mark everything started more than</span>
        <input type="number" min={1} max={3650} value={days} onChange={(e) => (setDays(Math.max(1, Number(e.target.value) || 1)), setConfirming(false))} aria-label="Days" style={{ ...input, width: "70px" }} />
        <span>days ago as already handled</span>
        <strong>({old.length})</strong>
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note, e.g. Handled before MonkeyBean tracked returns" maxLength={500} style={{ ...input, flexGrow: 1, minWidth: "220px" }} />
        <label style={{ display: "flex", gap: "6px", alignItems: "center", ...small }}>
          <input type="checkbox" checked={closeToo} onChange={(e) => (setCloseToo(e.target.checked), setConfirming(false))} /> Also close them in Shopify
        </label>
        {!confirming ? (
          <button type="button" style={chip(false)} disabled={!old.length} onClick={() => setConfirming(true)}>
            Mark {old.length} already handled
          </button>
        ) : (
          <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <span>
              {old.length} return{old.length === 1 ? "" : "s"} leave Awaiting arrival; stock isn't changed{closeToo ? " and they're closed in Shopify" : ""}.
            </span>
            <button type="button" style={chip(true)} disabled={f.state !== "idle"} onClick={() => f.submit({ intent: "handleReturns", ids: JSON.stringify(old.map((r) => r.id)), note, close: closeToo ? "1" : "0" }, { method: "post", action: RETURNS_ACTION })}>
              {f.state !== "idle" ? "Saving…" : "Yes, mark them"}
            </button>
            <button type="button" style={chip(false)} disabled={f.state !== "idle"} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        )}
      </div>
      {f.data?.ok && (
        <span style={small}>
          Marked {f.data.handled}.{f.data.failed?.length ? ` ${f.data.failed.length} not changed: ${f.data.failed.map((x) => `${x.name}: ${x.error}`).join("; ")}` : ""}
        </span>
      )}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
    </div>
  );
}

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

      {canReturns && data.stage === "awaiting" && data.list.length > 0 && <BulkHandled list={data.list} onDone={refresh} />}

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
