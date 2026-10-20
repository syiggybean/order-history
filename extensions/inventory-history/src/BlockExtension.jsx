import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Inventory history card on product pages in Shopify admin.
// Data comes from the app's /api/inventory-history endpoint, which checks the
// signed-in staff member's permissions. People without access see a
// collapsed, empty card.

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

function Extension() {
  const productId = shopify.data.selected?.[0]?.id;

  const [state, setState] = useState({ loading: true });
  const [changes, setChanges] = useState([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [whoOptions, setWhoOptions] = useState([]);
  const [who, setWho] = useState(""); // "" = everyone, else "app|staff"
  const [loadingMore, setLoadingMore] = useState(false);
  const [openOrder, setOpenOrder] = useState(null); // change key whose order is expanded

  const whoParams = () => {
    if (!who) return {};
    const [app, staff] = who.split("|");
    return { whoApp: app, whoStaff: staff };
  };

  async function load(nextPage) {
    const data = await getJson({ productId, page: String(nextPage), ...whoParams() });
    if (data.hidden) return setState({ hidden: true });
    if (data.error) return setState({ error: data.error });
    setChanges((prev) => (nextPage === 1 ? data.changes : [...prev, ...data.changes]));
    setHasMore(data.hasMore);
    setPage(nextPage);
    if (data.whoOptions) setWhoOptions(data.whoOptions);
    setState({ ready: true, access: data.access });
  }

  useEffect(() => {
    if (!productId) return setState({ error: "No product selected." });
    setState((s) => (s.ready ? s : { loading: true }));
    setOpenOrder(null);
    load(1).catch((e) => setState({ error: e.message }));
  }, [productId, who]);

  if (state.hidden) {
    // No access: collapsed and empty
    return <s-admin-block heading="Inventory history" collapsedSummary="Not available">{null}</s-admin-block>;
  }

  return (
    <s-admin-block heading="Inventory history" collapsedSummary={changes.length ? `${changes.length} recent changes` : undefined}>
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

          {changes.length === 0 ? (
            <s-text color="subdued">No stock changes recorded{who ? " for this person or app" : " yet"}.</s-text>
          ) : (
            <s-stack direction="block" gap="small">
              {changes.map((c, i) => (
                <ChangeRow
                  key={c.key}
                  c={c}
                  first={i === 0}
                  orderOpen={openOrder === c.key}
                  onToggleOrder={() => setOpenOrder(openOrder === c.key ? null : c.key)}
                />
              ))}
            </s-stack>
          )}

          {hasMore && (
            <s-button
              loading={loadingMore || undefined}
              onClick={async () => {
                setLoadingMore(true);
                try {
                  await load(page + 1);
                } catch (e) {
                  setState({ error: e.message });
                }
                setLoadingMore(false);
              }}
            >
              Show more
            </s-button>
          )}
        </s-stack>
      )}
    </s-admin-block>
  );
}

function ChangeRow({ c, first, orderOpen, onToggleOrder }) {
  const main = c.parts?.[0];
  const rest = (c.parts ?? []).slice(1);

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
            {c.variant && <s-badge>{c.variant}</s-badge>}
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
        </s-stack>
        <s-stack direction="block" gap="small-400" alignItems="end">
          <s-text color="subdued">{fmtTime(c.at)}</s-text>
          {c.order && (
            <s-button variant="tertiary" onClick={onToggleOrder} accessibilityLabel="Show order details">
              {orderOpen ? "Hide order" : "View order"}
            </s-button>
          )}
        </s-stack>
      </s-stack>
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
