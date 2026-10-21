import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// "Block customer" in a customer's More actions menu. Blocks the customer
// (and, by default, their shipping addresses) from shopping, or unblocks
// either. Data and permission checks come from the app's /api/blocklist.

export default async () => {
  render(<Extension />, document.body);
};

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

function Extension() {
  const customerId = shopify.data.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true });
  const [blockCustomer, setBlockCustomer] = useState(true);
  const [addresses, setAddresses] = useState({});
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const apply = (data) => {
    // Nothing blocked yet: everything ticked by default
    const fresh = !data.known && !data.addresses.some((a) => a.blocked);
    setBlockCustomer(fresh ? true : data.blocked);
    setAddresses(Object.fromEntries(data.addresses.map((a) => [a.key, fresh ? true : a.blocked])));
    setReason(data.reason ?? "");
    setState({ ready: true, data });
  };

  useEffect(() => {
    if (!customerId) return setState({ error: "No customer selected." });
    fetch(`/api/blocklist?${new URLSearchParams({ customerId })}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.hidden) return setState({ hidden: true });
        if (d.error) return setState({ error: d.error });
        apply(d);
      })
      .catch((e) => setState({ error: e.message }));
  }, [customerId]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/blocklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, customer: blockCustomer, addresses, reason }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      apply(d);
      const n = d.addresses.filter((a) => a.blocked).length;
      const text = d.blocked
        ? `${d.name} is blocked${n ? `, with ${n} address${n === 1 ? "" : "es"}` : ""}.`
        : n
          ? `${d.name} can shop. ${n} address${n === 1 ? " is" : "es are"} still blocked.`
          : `${d.name} is not blocked.`;
      setMessage({ tone: "success", text });
      // Not every admin screen offers toasts; the message above is enough
      try {
        shopify.toast?.show?.(text);
      } catch {
        /* no toast here */
      }
    } catch (e) {
      setMessage({ tone: "critical", text: e.message });
    }
    setSaving(false);
  };

  const d = state.data;
  const canManage = Boolean(d?.canManage);
  const anyBlocked = d && (d.blocked || d.addresses.some((a) => a.blocked));
  const changed =
    d &&
    (blockCustomer !== d.blocked || d.addresses.some((a) => Boolean(addresses[a.key]) !== a.blocked) || (reason ?? "") !== (d.reason ?? ""));

  return (
    <s-admin-action heading={anyBlocked ? "Blocked customer" : "Block customer"} loading={state.loading || undefined}>
      {state.hidden && <s-text>You don't have access to the block list. Ask an admin of the app.</s-text>}
      {state.error && (
        <s-banner tone="critical">
          <s-text>{state.error}</s-text>
        </s-banner>
      )}
      {state.ready && (
        <s-stack direction="block" gap="base">
          {d.blocked ? (
            <s-banner tone="critical">
              <s-text>
                {d.name} has been blocked from shopping since {fmtDate(d.blockedAt)}
                {d.blockedBy ? ` (by ${d.blockedBy})` : ""}.
              </s-text>
            </s-banner>
          ) : (
            <s-text color="subdued">
              Blocked customers see a red banner on your store, can't add to cart or check out, and any order that still comes through is put on hold
              and flagged. Blocked addresses catch orders shipping there from any account, including guest checkout.
            </s-text>
          )}

          <s-checkbox
            label={`Block ${d.name}${d.email ? ` (${d.email})` : ""} from shopping`}
            checked={blockCustomer || undefined}
            disabled={!canManage || undefined}
            onChange={(e) => setBlockCustomer(e.currentTarget.checked)}
          />

          <s-stack direction="block" gap="small">
            <s-text type="strong">Shipping addresses</s-text>
            {d.addresses.length === 0 && <s-text color="subdued">This customer has no saved addresses.</s-text>}
            {d.addresses.map((a) => (
              <s-checkbox
                key={a.key}
                label={`Block ${a.display}${a.removed ? " (no longer on their account)" : ""}`}
                checked={addresses[a.key] || undefined}
                disabled={!canManage || undefined}
                onChange={(e) => setAddresses((x) => ({ ...x, [a.key]: e.currentTarget.checked }))}
              />
            ))}
          </s-stack>

          <s-text-area
            label="Reason (for your team; the customer never sees this)"
            value={reason}
            disabled={!canManage || undefined}
            onInput={(e) => setReason(e.currentTarget.value)}
          />

          {!canManage && <s-text color="subdued">Blocking and unblocking needs "View + block and unblock" access in the app.</s-text>}
          {message && (
            <s-banner tone={message.tone}>
              <s-text>{message.text}</s-text>
            </s-banner>
          )}
        </s-stack>
      )}
      {canManage && state.ready && (
        <s-button slot="primary-action" variant="primary" tone={blockCustomer ? "critical" : undefined} loading={saving || undefined} disabled={!changed || undefined} onClick={save}>
          {!d.known && !anyBlocked ? "Block" : "Save"}
        </s-button>
      )}
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Close
      </s-button>
    </s-admin-action>
  );
}
