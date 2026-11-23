import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// MonkeyBean card on Shopify's order page: who picked, packed and shipped each
// part, its items and whether they were scanned, scan overrides, packing videos,
// the full history, and a Reship button (opens the order-reship action).
// Shopify's own timeline names the app; this names the person.

export default async () => {
  render(<Extension />, document.body);
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const mins = (s) => (s == null ? null : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s` : `${Math.round(s)}s`);
const SCAN = { scanned: ["Scanned", "success"], partly: ["Partly scanned", "warning"], not_scanned: ["Not scanned", "critical"] };

function Step({ label, step, empty }) {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="baseline">
      <s-text color="subdued">{label}:</s-text>
      {step ? (
        <s-text>
          <s-text type="strong">{step.by ?? (step.how === "shopify" ? "In Shopify" : "Not recorded")}</s-text>
          {step.at ? ` · ${fmtTime(step.at)}` : ""}
          {step.how === "flow" ? " · flow mode" : ""}
          {step.detail ? ` · ${step.detail}` : ""}
        </s-text>
      ) : (
        <s-text color="subdued">{empty}</s-text>
      )}
    </s-stack>
  );
}

function Items({ items }) {
  if (!items?.length) return null;
  return (
    <s-stack direction="block" gap="small-400">
      {items.map((it, i) => (
        <s-stack key={i} direction="inline" gap="small-200" alignItems="center">
          <s-text>
            {it.quantity} × {it.name}
          </s-text>
          {it.scan && <s-badge tone={SCAN[it.scan][1]}>{SCAN[it.scan][0]}</s-badge>}
        </s-stack>
      ))}
    </s-stack>
  );
}

function Part({ p, multi }) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        {(multi || p.overrides.length > 0) && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {multi && <s-text type="strong">Part {p.part}</s-text>}
            {p.overrides.length > 0 && <s-badge tone="critical">Scan overridden</s-badge>}
          </s-stack>
        )}
        <Items items={p.items} />
        {p.inBox && (
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>
              {p.inBox.done ? "Went" : "Goes"} out in {p.inBox.orderName}'s box. These are that box's details.
            </s-text>
            {p.inBox.orderId && (
              <s-link href={`shopify:admin/orders/${p.inBox.orderId.split("/").pop()}`} target="_top">
                Open {p.inBox.orderName}
              </s-link>
            )}
          </s-stack>
        )}
        <Step
          label="Batch"
          step={p.batch ? { by: p.batch.title, detail: [p.batch.createdBy ? `created by ${p.batch.createdBy}` : null, p.batch.priority && p.batch.priority !== "Normal" ? `${p.batch.priority} priority` : null].filter(Boolean).join(" · ") || null } : null}
          empty="Not batched"
        />
        <Step label="Picked" step={p.picked} empty="Not yet" />
        <Step label="Packed" step={p.packed} empty="Not yet" />
        <Step label="Shipped" step={p.shipped} empty="Not yet" />
        {p.overrides.map((o, i) => (
          <s-banner key={i} tone="critical" heading={`${o.kind}${o.by ? ` by ${o.by}` : ""}`}>
            <s-text>
              {o.at ? `${fmtTime(o.at)}` : ""}
              {o.reason ? ` · ${o.reason}` : ""}
            </s-text>
          </s-banner>
        ))}
        {p.videos.map((v) => (
          <s-stack key={v.id} direction="inline" gap="small-200" alignItems="center">
            {v.url ? (
              <s-link href={v.url} target="_blank">
                Packing video
              </s-link>
            ) : (
              <s-text type="strong">Packing video</s-text>
            )}
            <s-text color="subdued">{[v.by, fmtTime(v.at), mins(v.seconds), v.status !== "done" ? v.status : null].filter(Boolean).join(" · ")}</s-text>
            {v.clips.length > 0 && <s-text color="subdued">· {v.clips.length} customer clip{v.clips.length === 1 ? "" : "s"}</s-text>}
          </s-stack>
        ))}
        {p.carried?.map((c) => (
          <s-stack key={c.orderName} direction="block" gap="small-400">
            <s-stack direction="inline" gap="small-200">
              <s-text>Also carried items from {c.orderName}</s-text>
              {c.orderId && (
                <s-link href={`shopify:admin/orders/${c.orderId.split("/").pop()}`} target="_top">
                  Open
                </s-link>
              )}
            </s-stack>
            <Items items={c.items} />
          </s-stack>
        ))}
      </s-stack>
    </s-box>
  );
}

function Extension() {
  const orderId = shopify.data.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!orderId) return setState({ error: "No order selected." });
    fetch(`/api/order-tools?${new URLSearchParams({ orderId })}`)
      .then((r) => r.json())
      .then((d) => setState(d.hidden ? { hidden: true } : d.error ? { error: d.error } : { ready: true, ...d }))
      .catch((e) => setState({ error: e.message }));
  }, [orderId]);

  if (state.hidden) return <s-admin-block heading="MonkeyBean" collapsedSummary="Not available">{null}</s-admin-block>;
  const a = state.audit;
  const summary = a?.parts?.length ? a.parts.map((p) => p.packed?.by && `Packed by ${p.packed.by}`).filter(Boolean)[0] ?? null : null;

  return (
    <s-admin-block heading="MonkeyBean · Who handled it" collapsedSummary={summary ?? undefined}>
      <s-stack direction="block" gap="base">
        {state.loading && <s-spinner accessibilityLabel="Loading" />}
        {state.error && (
          <s-banner tone="critical">
            <s-text>{state.error}</s-text>
          </s-banner>
        )}
        {state.canReship && (
          <s-stack direction="inline">
            <s-button onClick={() => shopify.navigation?.navigate("extension:order-reship")}>Reship items</s-button>
          </s-stack>
        )}
        {a && a.parts.length === 0 && <s-text color="subdued">MonkeyBean hasn't handled this order yet.</s-text>}
        {a?.parts.map((p) => (
          <Part key={p.id} p={p} multi={a.multiPart} />
        ))}
        {a && a.history.length > 0 && (
          <s-stack direction="block" gap="small">
            <s-stack direction="inline">
              <s-button variant="tertiary" onClick={() => setOpen(!open)}>
                {open ? "Hide full history" : `Full history (${a.history.length})`}
              </s-button>
            </s-stack>
            {open &&
              a.history.map((e, i) => (
                <s-stack key={e.id} direction="block" gap="small-400">
                  {i > 0 && <s-divider />}
                  <s-text>
                    <s-text type="strong" tone={e.override ? "critical" : undefined}>
                      {e.label}
                    </s-text>
                    {e.by ? ` · ${e.by}` : ""}
                    {a.multiPart && e.part ? ` · part ${e.part}` : ""}
                    {e.batch ? ` · ${e.batch}` : ""}
                  </s-text>
                  <s-text color="subdued">{fmtTime(e.at)}</s-text>
                  {e.detail && <s-text color="subdued">{e.detail}</s-text>}
                </s-stack>
              ))}
          </s-stack>
        )}
      </s-stack>
    </s-admin-block>
  );
}
