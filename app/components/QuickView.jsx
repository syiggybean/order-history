import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

// The Pre-orders page handles loading and saving for the quick view,
// so it works the same from any page in the app.
const QUICK_VIEW_ACTION = "/app/preorders";

const linkButton = {
  appearance: "none",
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "#005bd3",
  textDecoration: "underline",
  cursor: "pointer",
  textAlign: "left",
};

export function ProductLink({ id, title, onOpen }) {
  if (!id) return title;
  return (
    <button type="button" style={linkButton} onClick={() => onOpen(id)}>
      {title}
    </button>
  );
}

const tagChip = (gt) => ({
  display: "inline-block",
  padding: "2px 8px",
  margin: "0 6px 6px 0",
  borderRadius: "999px",
  fontSize: "12px",
  background: gt ? "#ffe4ec" : "#f1f1f1",
  border: `1px solid ${gt ? "#f7a8b8" : "#e3e3e3"}`,
  fontWeight: gt ? 600 : 400,
});

const SYNC_MESSAGES = {
  updated: "Saved. Tags and shipping profile were updated to match the new date.",
  unchanged: "Saved. Tags and shipping profile were already correct for this date.",
  busy: "Saved. A full run is in progress, so tags and shipping profile will update when it finishes.",
  missing: "Saved, but tags and shipping profile weren't updated because a shipping profile is missing.",
};

export function QuickView({ productId, onClose, onSaved, canEdit = true }) {
  const fetcher = useFetcher();
  const [details, setDetails] = useState(null);
  const [release, setRelease] = useState("");
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  // Load the product when the panel opens
  useEffect(() => {
    setDetails(null);
    setMessage(null);
    setError(null);
    fetcher.submit({ intent: "product", productId }, { method: "post", action: QUICK_VIEW_ACTION });
  }, [productId]);

  useEffect(() => {
    const d = fetcher.data;
    if (!d) return;
    if (d.error) {
      setError(d.error);
      return;
    }
    if (d.details) {
      setDetails(d.details);
      setRelease(d.details.release ?? "");
    }
    if (d.intent === "saveRelease") {
      setMessage(SYNC_MESSAGES[d.sync?.status] ?? "Saved.");
      if (d.sync?.errors?.length) setError(d.sync.errors.join(" "));
      onSaved();
    }
  }, [fetcher.data]);

  // Close with Escape
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const saving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "saveRelease";
  const loading = !details && !error;
  const dirty = details && release && release !== (details.release ?? "");

  const save = () => {
    setMessage(null);
    setError(null);
    fetcher.submit({ intent: "saveRelease", productId, release }, { method: "post", action: QUICK_VIEW_ACTION });
  };

  const row = { display: "flex", justifyContent: "space-between", gap: "12px", padding: "8px 0", borderBottom: "1px solid #f1f1f1" };

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000, display: "flex", justifyContent: "flex-end" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Product quick view"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(440px, 100%)", height: "100%", background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #e3e3e3" }}>
          <strong style={{ fontSize: "15px" }}>Quick view</strong>
          <button type="button" onClick={onClose} aria-label="Close" style={{ ...linkButton, color: "#303030", textDecoration: "none", fontSize: "20px", lineHeight: 1 }}>
            ×
          </button>
        </div>

        <div style={{ padding: "16px", overflowY: "auto", flexGrow: 1 }}>
          {loading && <s-paragraph>Loading…</s-paragraph>}

          {error && (
            <div style={{ marginBottom: "12px" }}>
              <s-banner tone="critical">
                <s-paragraph>{error}</s-paragraph>
              </s-banner>
            </div>
          )}

          {details && (
            <>
              <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", marginBottom: "16px" }}>
                {details.image && (
                  <img src={details.image} alt="" style={{ width: "72px", height: "auto", borderRadius: "4px", flexShrink: 0 }} />
                )}
                <div>
                  <strong style={{ fontSize: "15px" }}>{details.title}</strong>
                  <div style={{ color: "#616161", marginTop: "4px" }}>{details.status.charAt(0) + details.status.slice(1).toLowerCase()}</div>
                  <div style={{ marginTop: "6px" }}>
                    <a href={`shopify:admin/products/${details.legacyId}`} target="_top" style={{ color: "#005bd3" }}>
                      Open in Shopify
                    </a>
                  </div>
                </div>
              </div>

              <label htmlFor="qv-release" style={{ display: "block", fontWeight: 600, marginBottom: "6px" }}>
                Release date
              </label>
              {canEdit ? (
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    id="qv-release"
                    type="date"
                    value={release}
                    onChange={(e) => setRelease(e.target.value)}
                    style={{ font: "inherit", padding: "6px 8px", border: "1px solid #c9c9c9", borderRadius: "8px" }}
                  />
                  <s-button
                    variant="primary"
                    onClick={save}
                    {...(saving ? { loading: true } : {})}
                    {...(!dirty ? { disabled: true } : {})}
                  >
                    Save
                  </s-button>
                </div>
              ) : (
                <div id="qv-release">{details.release ?? "Not set"}</div>
              )}
              {message && (
                <div style={{ marginTop: "10px" }}>
                  <s-banner tone="success">
                    <s-paragraph>{message}</s-paragraph>
                  </s-banner>
                </div>
              )}

              <div style={{ marginTop: "20px" }}>
                <div style={row}>
                  <span>Days until release</span>
                  <strong>{details.days ?? "—"}</strong>
                </div>
                <div style={row}>
                  <span>GT tag</span>
                  <strong>{details.gtTags.length ? details.gtTags.join(", ") : "None"}</strong>
                </div>
                <div style={row}>
                  <span>Shipping profile</span>
                  <strong style={{ textAlign: "right" }}>{details.profiles.join(", ")}</strong>
                </div>
                {details.release && (
                  <div style={{ ...row, color: "#616161" }}>
                    <span>Expected for this date</span>
                    <span style={{ textAlign: "right" }}>
                      {details.expectedTag ?? "No GT tag"} · {details.expectedProfile ?? "—"}
                    </span>
                  </div>
                )}
              </div>

              <div style={{ marginTop: "20px" }}>
                <div style={{ fontWeight: 600, marginBottom: "8px" }}>All tags</div>
                {details.tags.length === 0 ? (
                  <span style={{ color: "#616161" }}>No tags</span>
                ) : (
                  <div>
                    {details.tags.map((t) => (
                      <span key={t} style={tagChip(details.gtTags.includes(t))}>
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
