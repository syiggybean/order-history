import { useState } from "react";
import { useFetcher } from "react-router";
import { fmtDate, small } from "./ui";

const STRIPES = "repeating-linear-gradient(135deg, #fff7d6 0 14px, #fff1bf 14px 28px)";

// Shown on every tab while this person is in sandbox mode
export function SandboxBanner({ summary }) {
  const fetcher = useFetcher();
  const [confirmReset, setConfirmReset] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const busy = fetcher.state !== "idle";
  return (
    <div
      role="status"
      style={{ background: STRIPES, border: "1px solid #e8c95a", borderRadius: "10px", padding: "12px 14px", marginBottom: "14px" }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
        <span style={{ background: "#1a1a1a", color: "#ffd84d", fontWeight: 800, fontSize: "12px", letterSpacing: ".08em", padding: "3px 8px", borderRadius: "6px" }}>
          SANDBOX
        </span>
        <strong>You're working on a practice copy.</strong>
        <span style={{ flex: 1 }} />
        {!confirmReset ? (
          <s-button variant="tertiary" onClick={() => setConfirmReset(true)}>
            Reset copy
          </s-button>
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span style={small}>Start over from the real lists? Sandbox batches and flags are cleared.</span>
            <s-button onClick={() => fetcher.submit({ intent: "resetSandbox" }, { method: "post" })} {...(busy ? { loading: true } : {})}>
              Reset
            </s-button>
            <s-button variant="tertiary" onClick={() => setConfirmReset(false)}>
              Cancel
            </s-button>
          </span>
        )}
        <s-button variant="primary" onClick={() => fetcher.submit({ intent: "leaveSandbox" }, { method: "post" })} {...(busy && !confirmReset ? { loading: true } : {})}>
          Leave sandbox
        </s-button>
      </div>
      <div style={{ ...small, color: "#5c4400", marginTop: "6px" }}>
        Batch, pick, flag and pack as much as you like: the real shipping lists aren't touched and nothing is sent to Shopify. Other staff keep working
        normally.
        {summary.copiedAt ? ` Copied ${fmtDate(summary.copiedAt, true)}${summary.copied ? ` (${summary.copied.toLowerCase()})` : ""}.` : ""}
      </div>
      <div style={{ marginTop: "8px" }}>
        <button
          type="button"
          onClick={() => setShowSkipped((v) => !v)}
          style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", fontSize: "12px", fontWeight: 600, color: "#5c4400", cursor: "pointer" }}
          aria-expanded={showSkipped}
        >
          {showSkipped ? "▾" : "▸"} Would have sent to Shopify: {summary.skippedCount} change{summary.skippedCount === 1 ? "" : "s"} (skipped)
        </button>
        {showSkipped && (
          <div style={{ marginTop: "6px", background: "rgba(255,255,255,.75)", borderRadius: "8px", padding: "8px 10px", fontSize: "12px" }}>
            {!summary.skipped.length ? (
              <span>Nothing yet. Add shipments to a batch and the order tags it would add show up here.</span>
            ) : (
              <>
                {summary.skipped.map((s) => (
                  <div key={s.id} style={{ display: "flex", gap: "8px" }}>
                    <span style={{ color: "#8a6d00", whiteSpace: "nowrap" }}>{fmtDate(s.at, true)}</span>
                    <span>{s.detail}</span>
                  </div>
                ))}
                {summary.skippedCount > summary.skipped.length && <div style={{ marginTop: "4px" }}>…and {summary.skippedCount - summary.skipped.length} more</div>}
              </>
            )}
          </div>
        )}
      </div>
      {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{fetcher.data.error}</div>}
    </div>
  );
}

// The way in: a button in the page header
export function EnterSandboxButton() {
  const fetcher = useFetcher();
  return (
    <s-button
      slot="secondary-actions"
      onClick={() => fetcher.submit({ intent: "enterSandbox" }, { method: "post" })}
      {...(fetcher.state !== "idle" ? { loading: true } : {})}
    >
      Try in sandbox
    </s-button>
  );
}

// Settings tab: what sandbox mode is
export function SandboxSettings({ on }) {
  const fetcher = useFetcher();
  return (
    <s-section heading="Sandbox mode">
      <s-paragraph>
        Practise the whole workflow (batching, picking, flagging, and packing once it arrives) on a copy of today's shipments. Nothing is sent to
        Shopify, the real lists aren't touched, and it only applies to you; other staff keep working normally. Order and product details still load
        from Shopify so the copy looks real.
      </s-paragraph>
      <div style={{ marginTop: "10px" }}>
        {on ? (
          <s-button onClick={() => fetcher.submit({ intent: "leaveSandbox" }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
            Leave sandbox
          </s-button>
        ) : (
          <s-button variant="primary" onClick={() => fetcher.submit({ intent: "enterSandbox" }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
            Enter sandbox mode
          </s-button>
        )}
      </div>
    </s-section>
  );
}
