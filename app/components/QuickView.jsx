import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Flyout } from "./Flyout";

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
    <Flyout onClose={onClose} label="Product quick view" title="Quick view">

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
                  <div style={{ marginTop: "6px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                    <a href={`shopify:admin/products/${details.legacyId}`} target="_top" style={{ color: "#005bd3" }}>
                      Open in Shopify
                    </a>
                    {details.storeUrl && (
                      <a
                        href={details.storeUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "#005bd3" }}
                        title={details.storePreview ? "Not on sale yet: opens Shopify's preview of the page" : undefined}
                      >
                        {details.storePreview ? "Preview in store ↗" : "View in store ↗"}
                        <span style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}> (opens in a new tab)</span>
                      </a>
                    )}
                  </div>
                </div>
              </div>

              <Bins productId={productId} />

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
                {details.template && (
                  <div style={row}>
                    <span>Product template</span>
                    <strong style={{ textAlign: "right" }}>
                      {details.template}
                      {details.expectedTemplate && details.expectedTemplate !== details.template && (
                        <span style={{ display: "block", fontWeight: 400, color: "#8a6116" }}>Should be {details.expectedTemplate}</span>
                      )}
                    </strong>
                  </div>
                )}
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
    </Flyout>
  );
}

// ---------------------------------------------------------------------------
// Bin locations for the product's variants (also the "Bin location" field in Shopify)
// ---------------------------------------------------------------------------

const BINS_ACTION = "/app/bins";

function Bins({ productId }) {
  const f = useFetcher();
  useEffect(() => {
    f.submit({ intent: "productBins", productId }, { method: "post", action: BINS_ACTION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);
  const d = f.data?.intent === "productBins" ? f.data : null;
  if (!d) return <div style={{ marginBottom: "18px", color: "#616161", fontSize: "13px" }}>Loading bins…</div>;
  if (d.error) return null;
  const many = d.variants.length > 1;
  return (
    <div style={{ marginBottom: "18px" }}>
      <div style={{ fontWeight: 600, marginBottom: "6px" }}>
        Bin location{many ? "s" : ""}
        {d.sandbox && <span style={{ fontWeight: 400, color: "#7a4f01", fontSize: "12px" }}> · sandbox copy</span>}
      </div>
      <div style={{ display: "grid", gap: "6px" }}>
        {d.variants.map((v) => (
          <BinRow key={v.variantId} v={v} many={many} canEdit={d.canEdit} />
        ))}
      </div>
      {!d.canEdit && d.variants.some((v) => !v.bin) && (
        <div style={{ color: "#616161", fontSize: "12px", marginTop: "4px" }}>Changing bins needs the Stock permission “Edit bin locations”.</div>
      )}
    </div>
  );
}

function BinRow({ v, many, canEdit }) {
  const f = useFetcher();
  const [value, setValue] = useState(v.bin ?? "");
  const [saved, setSaved] = useState(v.bin ?? "");
  useEffect(() => {
    if (f.state === "idle" && f.data?.intent === "setBin" && f.data.ok) setSaved(f.data.bin ?? "");
  }, [f.state, f.data]);
  const save = () => {
    if (value.trim() === saved) return;
    f.submit({ intent: "setBin", item: JSON.stringify(v), bin: value.trim() }, { method: "post", action: BINS_ACTION });
  };
  const status =
    f.state !== "idle" ? { text: "Saving…", color: "#616161" } : f.data?.error ? { text: f.data.error, color: "#b42318" } : f.data?.shopifyError ? { text: "Saved here; not in Shopify yet", color: "#8a6100" } : f.data?.ok && value.trim() === saved ? { text: "✓ Saved", color: "#1a7f37" } : null;
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
      {many && (
        <span style={{ minWidth: "120px", flex: "1 1 120px", fontSize: "13px" }}>
          {v.variantTitle ?? "Default"}
          {v.sku && <span style={{ color: "#616161", fontSize: "12px" }}> · {v.sku}</span>}
        </span>
      )}
      {canEdit ? (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder="Bin"
          aria-label={`Bin for ${v.title}${v.variantTitle ? ` – ${v.variantTitle}` : ""}`}
          style={{ font: "inherit", fontWeight: 600, padding: "6px 8px", border: "1px solid #c9c9c9", borderRadius: "8px", width: "120px" }}
        />
      ) : (
        <strong>{v.bin ?? <span style={{ color: "#616161", fontWeight: 400 }}>No bin</span>}</strong>
      )}
      {!many && v.sku && <span style={{ color: "#616161", fontSize: "12px" }}>{v.sku}</span>}
      {status && <span style={{ fontSize: "12px", color: status.color }}>{status.text}</span>}
    </div>
  );
}
