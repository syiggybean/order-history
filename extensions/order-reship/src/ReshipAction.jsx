import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// "Reship items" on Shopify's order page (More actions, or the MonkeyBean
// card's button). Makes a free ($0) replacement order through the app's
// /api/order-tools endpoint, which checks the "Create reship orders"
// permission. Stock comes off or stays the same depending on the reason.

export default async () => {
  render(<Extension />, document.body);
};

const fmtTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

async function getJson(params) {
  const res = await fetch(`/api/order-tools?${new URLSearchParams(params)}`);
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`The app returned ${res.status}`);
  if (data.error) throw new Error(data.error);
  return data;
}

async function postJson(body) {
  const res = await fetch("/api/order-tools", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`The app returned ${res.status}`);
  if (data.error) throw new Error(data.error);
  return data;
}

function Extension() {
  const orderId = shopify.data.selected?.[0]?.id;
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [takeStock, setTakeStock] = useState(""); // "1" | "0" (Other only)
  const [notify, setNotify] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);

  useEffect(() => {
    if (!orderId) return setLoadError("No order selected.");
    getJson({ orderId, reshipInfo: "1" })
      .then((d) => setInfo(d.info))
      .catch((e) => setLoadError(e.message));
  }, [orderId]);

  const def = info?.reasons.find((r) => r.reason === reason);
  const takes = def ? (def.takesStock ?? (takeStock === "1" ? true : takeStock === "0" ? false : null)) : null;
  const chosen = info ? info.lines.filter((l) => Number(qty[l.id]) > 0) : [];
  const ready = Boolean(info?.hasAddress) && chosen.length > 0 && def && takes !== null && (reason !== "Other" || note.trim());
  const edit = (fn) => (e) => {
    fn(e.currentTarget.value ?? "");
    setConfirming(false);
    setError(null);
  };

  async function create() {
    setWorking(true);
    setError(null);
    try {
      const d = await postJson({
        intent: "reship",
        orderId,
        items: chosen.map((l) => ({ lineItemId: l.id, quantity: Number(qty[l.id]) })),
        reason,
        note,
        notify,
        takeStock: reason === "Other" ? takeStock === "1" : undefined,
      });
      setMade(d.made);
    } catch (e) {
      setError(e.message);
      setConfirming(false);
    }
    setWorking(false);
  }

  return (
    <s-admin-action heading={info ? `Reship from ${info.orderName}` : "Reship items"} loading={!info && !loadError ? true : undefined}>
      {loadError && (
        <s-banner tone="critical">
          <s-text>{loadError}</s-text>
        </s-banner>
      )}

      {made && (
        <s-banner tone="success" heading={`Made ${made.name}`}>
          <s-stack direction="block" gap="small-300">
            <s-text>{made.items}</s-text>
            <s-text>{made.takesStock ? "The items came out of stock." : "Stock wasn't changed."} It will show in MonkeyBean's Shipping like any other order.</s-text>
            <s-link href={`shopify:admin/orders/${made.number}`} target="_top">
              Open {made.name}
            </s-link>
          </s-stack>
        </s-banner>
      )}

      {info && !made && (
        <s-stack direction="block" gap="base">
          {info.earlier.length > 0 && (
            <s-banner tone="warning" heading="Already reshipped before">
              <s-stack direction="block" gap="small-400">
                {info.earlier.map((e, i) => (
                  <s-text key={i}>
                    {fmtTime(e.at)} · {e.by ?? "Staff"} · {e.detail}
                  </s-text>
                ))}
              </s-stack>
            </s-banner>
          )}

          <s-stack direction="block" gap="small">
            <s-heading>Items to send again</s-heading>
            {info.lines.map((l) => (
              <s-number-field
                key={l.id}
                label={`${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`}
                details={`${l.sku ? `${l.sku} · ` : ""}${l.quantity} ordered`}
                value={qty[l.id] ?? "0"}
                min={0}
                max={l.quantity}
                step={1}
                onChange={edit((v) => setQty({ ...qty, [l.id]: v }))}
              />
            ))}
          </s-stack>

          <s-select label="Why" value={reason} onChange={edit(setReason)}>
            <s-option value="">Choose a reason…</s-option>
            {info.reasons.map((r) => (
              <s-option key={r.reason} value={r.reason}>
                {r.reason}
              </s-option>
            ))}
          </s-select>

          {reason === "Other" && (
            <s-select label="Did the first one leave the shelf?" value={takeStock} onChange={edit(setTakeStock)}>
              <s-option value="">Choose…</s-option>
              <s-option value="1">Yes: take the reshipped items out of stock</s-option>
              <s-option value="0">No, it was never sent: leave stock as it is</s-option>
            </s-select>
          )}

          {def && takes !== null && (
            <s-banner tone="info">
              <s-text>
                Stock {takes ? "comes off: a second one leaves the shelf." : "stays the same: the one counted the first time is still on the shelf, and this one replaces it."}
              </s-text>
            </s-banner>
          )}

          <s-text-area label={reason === "Other" ? "Note (required)" : "Note (optional)"} value={note} maxLength={500} rows={2} onChange={edit(setNote)} />

          <s-stack direction="block" gap="small-400">
            <s-text color="subdued">Ships to</s-text>
            {info.hasAddress ? <s-text>{info.address}</s-text> : <s-text tone="critical">This order has no shipping address.</s-text>}
            {info.method && <s-text color="subdued">Shipping method: {info.method} (free)</s-text>}
          </s-stack>

          <s-checkbox label="Email the customer tracking when it ships" checked={notify || undefined} onChange={(e) => setNotify(e.currentTarget.checked)} />

          {error && (
            <s-banner tone="critical">
              <s-text>{error}</s-text>
            </s-banner>
          )}
          {confirming && (
            <s-banner tone="warning">
              <s-text>
                This makes a $0 order in Shopify for {chosen.map((l) => `${qty[l.id]} × ${l.title}`).join(", ")}, tagged "Reship". Stock {takes ? "comes off" : "stays the same"}.
              </s-text>
            </s-banner>
          )}
        </s-stack>
      )}

      {made || loadError ? (
        <s-button slot="primary-action" onClick={() => shopify.close()}>
          Done
        </s-button>
      ) : confirming ? (
        <s-button slot="primary-action" variant="primary" loading={working || undefined} onClick={create}>
          Yes, create it
        </s-button>
      ) : (
        <s-button slot="primary-action" variant="primary" disabled={!ready || undefined} onClick={() => setConfirming(true)}>
          Create reship order
        </s-button>
      )}
      {!made && (
        <s-button slot="secondary-actions" onClick={() => (confirming ? setConfirming(false) : shopify.close())}>
          {confirming ? "Back" : "Cancel"}
        </s-button>
      )}
    </s-admin-action>
  );
}
