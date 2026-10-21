import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// "Inventory history" in the product page's More actions menu.
// Opens a window with the product's stock changes. Data comes from the app's
// /api/inventory-history endpoint, which checks the signed-in staff member's
// permissions; condition/shouldRender.js hides the menu item for people
// without access.

export default async () => {
  render(<Extension />, document.body);
};

const fmtTime = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const whoKey = (w) => (w ? `${w.app ?? ""}|${w.staff ?? ""}` : "");

async function getJson(params) {
  const res = await fetch(`/api/inventory-history?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`The app returned ${res.status}`);
  return res.json();
}

async function postJson(body) {
  const res = await fetch("/api/inventory-history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`The app returned ${res.status}`);
  if (data.error) throw new Error(data.error);
  return data;
}

const DEFAULT_RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "365d", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

function Extension() {
  const productId = shopify.data.selected?.[0]?.id;

  const [state, setState] = useState({ loading: true });
  const [changes, setChanges] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(null);
  const [whoOptions, setWhoOptions] = useState([]);
  const [rangeOptions, setRangeOptions] = useState(DEFAULT_RANGES);
  const [who, setWho] = useState(""); // "" = everyone, else "app|staff"
  const [range, setRange] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openOrder, setOpenOrder] = useState(null); // change key whose order is expanded
  const [notice, setNotice] = useState(null); // message after an undo

  const filterParams = () => {
    const p = {};
    if (who) {
      const [app, staff] = who.split("|");
      p.whoApp = app;
      p.whoStaff = staff;
    }
    p.range = range;
    if (range === "custom") {
      if (from) p.from = from;
      if (to) p.to = to;
    }
    return p;
  };

  async function load(nextPage, all = showAll) {
    const data = await getJson({ productId, page: String(nextPage), ...filterParams(), ...(all ? { all: "1" } : {}) });
    if (data.hidden) return setState({ hidden: true });
    if (data.error) return setState({ error: data.error });
    setChanges((prev) => (nextPage === 1 ? data.changes : [...prev, ...data.changes]));
    setHasMore(data.hasMore);
    setTruncated(data.truncated ?? null);
    setPage(nextPage);
    if (data.whoOptions) setWhoOptions(data.whoOptions);
    if (data.rangeOptions) setRangeOptions(data.rangeOptions);
    setState({ ready: true, access: data.access ?? {} });
  }

  useEffect(() => {
    if (!productId) return setState({ error: "No product selected." });
    setState((s) => (s.ready ? s : { loading: true }));
    setOpenOrder(null);
    load(1).catch((e) => setState({ error: e.message }));
  }, [productId, who, range, from, to, showAll]);

  const refresh = () => {
    setState({ loading: true });
    setOpenOrder(null);
    setNotice(null);
    load(1).catch((e) => setState({ error: e.message }));
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      await load(page + 1);
    } catch (e) {
      setState({ error: e.message });
    }
    setLoadingMore(false);
  };

  const canUndo = Boolean(state.access?.undo);
  const filtered = Boolean(who) || range !== "all";

  return (
    <s-admin-action heading="Inventory history" loading={state.loading || undefined}>
      {state.hidden && <s-text>You don't have access to inventory history. Ask an admin of the app for access.</s-text>}

      {state.loading && (
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-spinner accessibilityLabel="Loading inventory history" />
          <s-text color="subdued">Loading…</s-text>
        </s-stack>
      )}

      {state.error && (
        <s-banner tone="critical">
          <s-text>Couldn't load inventory history: {state.error}</s-text>
        </s-banner>
      )}

      {state.ready && (
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-select label="Dates" value={range} onChange={(e) => setRange(e.currentTarget.value)}>
              {rangeOptions.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
              <s-option value="custom">Custom dates</s-option>
            </s-select>
            {whoOptions.length > 1 && (
              <s-select label="Who" value={who} onChange={(e) => setWho(e.currentTarget.value)}>
                <s-option value="">Everyone</s-option>
                {whoOptions.map((w) => (
                  <s-option key={whoKey(w)} value={whoKey(w)}>
                    {w.who} ({w.changes})
                  </s-option>
                ))}
              </s-select>
            )}
          </s-stack>

          {range === "custom" && (
            <s-stack direction="inline" gap="base">
              <s-date-field label="From" value={from} onChange={(e) => setFrom(e.currentTarget.value ?? "")} />
              <s-date-field label="To" value={to} onChange={(e) => setTo(e.currentTarget.value ?? "")} />
            </s-stack>
          )}

          {notice && (
            <s-banner tone="success" dismissible onDismiss={() => setNotice(null)}>
              <s-text>{notice}</s-text>
            </s-banner>
          )}

          {changes.length === 0 ? (
            <s-text color="subdued">No stock changes recorded{filtered ? " that match these filters" : " yet"}.</s-text>
          ) : (
            <s-stack direction="block" gap="small">
              {changes.map((c, i) => (
                <ChangeRow
                  key={c.key}
                  c={c}
                  first={i === 0}
                  canUndo={canUndo}
                  orderOpen={openOrder === c.key}
                  onToggleOrder={() => setOpenOrder(openOrder === c.key ? null : c.key)}
                  onUndone={(msg) => {
                    setNotice(msg);
                    load(1).catch((e) => setState({ error: e.message }));
                  }}
                />
              ))}
            </s-stack>
          )}

          {truncated && (
            <s-text color="subdued">
              Showing the latest {truncated.toLocaleString()} changes. Choose a date range to see older ones.
            </s-text>
          )}

          {(hasMore || showAll) && (
            <s-stack direction="inline" gap="small">
              {hasMore && (
                <s-button loading={loadingMore || undefined} onClick={loadMore}>
                  Show more
                </s-button>
              )}
              {hasMore && !showAll && <s-button onClick={() => setShowAll(true)}>Show all</s-button>}
              {showAll && <s-button onClick={() => setShowAll(false)}>Show fewer</s-button>}
            </s-stack>
          )}
        </s-stack>
      )}

      <s-button slot="primary-action" onClick={() => shopify.close()}>
        Done
      </s-button>
      <s-button slot="secondary-actions" onClick={refresh}>
        Refresh
      </s-button>
    </s-admin-action>
  );
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function ChangeRow({ c, first, canUndo, orderOpen, onToggleOrder, onUndone }) {
  const main = c.parts?.[0];
  const rest = (c.parts ?? []).slice(1);
  const [undo, setUndo] = useState(null); // { loading } | { preview } | { error } | { working, preview }

  const startUndo = async () => {
    setUndo({ loading: true });
    try {
      const { preview } = await postJson({ intent: "preview", key: c.key });
      setUndo({ preview });
    } catch (e) {
      setUndo({ error: e.message });
    }
  };

  const confirmUndo = async () => {
    setUndo((u) => ({ ...u, working: true }));
    try {
      const { undone } = await postJson({ intent: "undo", key: c.key });
      setUndo(null);
      onUndone(`Undone. Available stock${c.location ? ` at ${c.location}` : ""} is now ${undone.after}.`);
    } catch (e) {
      setUndo({ error: e.message });
    }
  };

  return (
    <s-stack direction="block" gap="small-300">
      {!first && <s-divider />}
      <s-stack direction="inline" justifyContent="space-between" alignItems="start" gap="base">
        <s-stack direction="block" gap="small-400">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {main && (
              <s-text type="strong" tone={main.change < 0 ? "critical" : main.change > 0 ? "success" : undefined}>
                {signed(main.change)} {main.label}
              </s-text>
            )}
            {rest.map((p) => (
              <s-text key={p.state} color="subdued">
                {signed(p.change)} {p.label}
              </s-text>
            ))}
            {c.catalog && <s-badge tone={c.catalog.action === "deleted" ? "critical" : "success"}>{c.catalog.label}</s-badge>}
            {c.variant && <s-badge>{c.variant}</s-badge>}
            {c.isUndo && <s-badge tone="info">Undo</s-badge>}
            {c.undoneBy && <s-badge tone="warning">Undone</s-badge>}
          </s-stack>
          {c.pending ? (
            <s-text color="subdued">Details on the way…</s-text>
          ) : (
            <s-text color="subdued">
              {c.who}
              {c.reasonLabel ? ` · ${c.reasonLabel}` : ""}
              {c.location ? ` · ${c.location}` : ""}
            </s-text>
          )}
          {c.undoneBy && (
            <s-text color="subdued">
              Undone by {c.undoneBy.name} on {fmtDay(c.undoneBy.at)}
            </s-text>
          )}
        </s-stack>
        <s-stack direction="block" gap="small-400" alignItems="end">
          <s-text color="subdued">{fmtTime(c.at)}</s-text>
          {c.order && (
            <s-button variant="tertiary" onClick={onToggleOrder} accessibilityLabel="Show order details">
              {orderOpen ? "Hide order" : "View order"}
            </s-button>
          )}
          {canUndo && c.undoable && !undo?.preview && (
            <s-button
              variant="tertiary"
              loading={undo?.loading || undefined}
              onClick={startUndo}
              accessibilityLabel="Undo this change"
            >
              Undo
            </s-button>
          )}
        </s-stack>
      </s-stack>

      {undo?.error && (
        <s-banner tone="critical" dismissible onDismiss={() => setUndo(null)}>
          <s-text>Couldn't undo: {undo.error}</s-text>
        </s-banner>
      )}

      {undo?.preview && (
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="block" gap="small">
            <s-text type="strong">Undo this change?</s-text>
            <s-text>
              This makes a {signed(undo.preview.delta)} adjustment. Available stock
              {c.location ? ` at ${c.location}` : ""} goes from {undo.preview.current} to {undo.preview.after}.
            </s-text>
            {undo.preview.after < 0 && (
              <s-text tone="critical">Stock will be below zero afterwards.</s-text>
            )}
            <s-stack direction="inline" gap="small">
              <s-button variant="primary" tone="critical" loading={undo.working || undefined} onClick={confirmUndo}>
                Undo change
              </s-button>
              <s-button disabled={undo.working || undefined} onClick={() => setUndo(null)}>
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-box>
      )}

      {orderOpen && c.order && <OrderQuickView orderId={c.order.id} />}
    </s-stack>
  );
}

function OrderQuickView({ orderId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    getJson({ order: orderId })
      .then((d) => setState(d.order ? { order: d.order } : { error: "This order couldn't be found." }))
      .catch((e) => setState({ error: e.message }));
  }, [orderId]);

  if (state.loading) return <s-spinner accessibilityLabel="Loading order" />;
  if (state.error) return <s-text color="subdued">{state.error}</s-text>;

  const o = state.order;
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
          <s-text type="strong">
            {o.name}
            {o.customer ? ` · ${o.customer}` : ""}
          </s-text>
          <s-link href={`shopify:admin/orders/${o.id}`} target="_top">
            Open order
          </s-link>
        </s-stack>
        <s-stack direction="inline" gap="small-200">
          {o.cancelled && <s-badge tone="critical">Canceled</s-badge>}
          {o.payment && <s-badge>{o.payment}</s-badge>}
          {o.fulfillment && <s-badge>{o.fulfillment}</s-badge>}
        </s-stack>
        <s-text color="subdued">
          Placed {fmtTime(o.createdAt)}
          {o.total ? ` · ${o.total}` : ""}
        </s-text>
        <s-stack direction="block" gap="small-400">
          {o.items.map((li, i) => (
            <s-text key={i}>
              {li.quantity} × {li.title}
              {li.variant ? ` (${li.variant})` : ""}
            </s-text>
          ))}
        </s-stack>
      </s-stack>
    </s-box>
  );
}
