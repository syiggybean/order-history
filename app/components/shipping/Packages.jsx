import { useContext as useCtx, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ShopAdminContext } from "./Notice";
import { GreenButton, input, muted, small } from "./ui";
import { IN_APP_LABELS } from "./features";

// ---------------------------------------------------------------------------
// Box and weight for a packed shipment, and the settings behind them.
// Shopify doesn't let apps fill in its label page, so what's entered here is
// shown next to the label button to copy over.
// ---------------------------------------------------------------------------

const trim = (n) => String(Math.round(Number(n) * 100) / 100);
export function packageText(p) {
  if (!p) return "";
  const dims = p.l != null ? `${trim(p.l)} × ${trim(p.w)} × ${trim(p.h)} ${p.dimUnit}` : null;
  return [p.box, dims, p.weight != null ? `${trim(p.weight)} ${p.weightUnit}` : null].filter(Boolean).join(" · ");
}

// What to type into Shopify, with copy buttons
export function PackageForShopify({ pkg }) {
  const [copied, setCopied] = useState(null);
  if (!pkg) return null;
  const copy = (what, text) => {
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard blocked: the value is on screen anyway */
    }
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };
  const chip = (what, labelText, value) => (
    <button
      type="button"
      onClick={() => copy(what, value)}
      title="Copy"
      style={{ appearance: "none", border: "1px solid #b9cdf0", background: "#fff", borderRadius: "8px", padding: "4px 10px", font: "inherit", cursor: "pointer", display: "inline-flex", gap: "6px", alignItems: "baseline" }}
    >
      <span style={small}>{labelText}</span>
      <strong style={{ fontSize: "16px", fontVariantNumeric: "tabular-nums" }}>{value}</strong>
      <span style={{ ...small, color: copied === what ? "#1a5e20" : "#616161" }}>{copied === what ? "Copied" : "Copy"}</span>
    </button>
  );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "8px" }}>
      <span style={{ fontSize: "13px" }}>Enter in Shopify:</span>
      {pkg.box && chip("box", "Package", pkg.box)}
      {pkg.l != null && chip("dims", "Size", `${trim(pkg.l)} × ${trim(pkg.w)} × ${trim(pkg.h)} ${pkg.dimUnit}`)}
      {pkg.weight != null && chip("weight", "Weight", `${trim(pkg.weight)} ${pkg.weightUnit}`)}
    </div>
  );
}

// Looks like a packing slip scan rather than a weight ("43712", "43712-2")
const looksLikeScan = (v) => /^#?\d+\s*[-/]\s*\d+$/.test(v.trim()) || (/^#?\d+$/.test(v.trim()) && Number(v.replace("#", "")) >= 10000);

export function PackagePanel({ box: b, batchId, cfg, autoFocus, onSaved, onScan, canPack }) {
  const fetcher = useFetcher();
  const p = b.pkg;
  const [editing, setEditing] = useState(!p);
  const [boxId, setBoxId] = useState(() => cfg.boxes.find((x) => x.name === p?.box)?.id ?? (p?.l != null ? "custom" : cfg.boxes[0]?.id ?? "custom"));
  const [weight, setWeight] = useState(p?.weight != null ? String(p.weight) : "");
  const [dims, setDims] = useState({ l: p?.l ?? "", w: p?.w ?? "", h: p?.h ?? "", name: p && !cfg.boxes.some((x) => x.name === p.box) ? p.box ?? "" : "" });
  const weightRef = useRef(null);

  useEffect(() => {
    setEditing(!b.pkg);
    setWeight(b.pkg?.weight != null ? String(b.pkg.weight) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.id]);
  useEffect(() => {
    if (editing && autoFocus) weightRef.current?.focus?.();
  }, [editing, autoFocus, b.id]);
  useEffect(() => {
    const r = fetcher.data;
    if (r?.intent !== "savePackage" || fetcher.state !== "idle") return;
    if (r.ok) {
      setEditing(false);
      onSaved?.(r.pkg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  if (cfg.step === "off") return null;
  const shipped = b.state === "shipped";

  if (!editing && p)
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "10px", fontSize: "14px" }}>
        <span aria-hidden="true">📦</span>
        <strong>{packageText(p)}</strong>
        {p.by && <span style={small}>by {p.by}</span>}
        {!shipped && canPack && (
          <s-button variant="tertiary" onClick={() => setEditing(true)}>
            Change
          </s-button>
        )}
      </div>
    );
  if (shipped || !canPack) return null;

  const save = (e) => {
    e?.preventDefault?.();
    // A packing slip scanned into the weight box: treat it as a scan
    if (looksLikeScan(weight)) {
      const code = weight;
      setWeight("");
      onScan?.(code);
      return;
    }
    const custom = boxId === "custom";
    fetcher.submit(
      {
        intent: "savePackage",
        id: String(batchId),
        shipmentId: String(b.id),
        weight,
        boxId: custom ? "" : boxId,
        boxName: custom ? dims.name : "",
        l: custom ? String(dims.l) : "",
        w: custom ? String(dims.w) : "",
        h: custom ? String(dims.h) : "",
      },
      { method: "post" },
    );
  };
  const err = fetcher.data?.intent === "savePackage" && fetcher.state === "idle" ? fetcher.data.error : null;
  const dimInput = (k) => (
    <input
      type="text"
      inputMode="decimal"
      value={dims[k]}
      onChange={(e) => setDims((d) => ({ ...d, [k]: e.target.value }))}
      aria-label={{ l: "Length", w: "Width", h: "Height" }[k]}
      placeholder={k.toUpperCase()}
      style={{ ...input, width: "56px" }}
    />
  );
  return (
    <form
      onSubmit={save}
      className="sh-rise"
      style={{ marginTop: "12px", padding: "12px", borderRadius: "10px", background: "#fafafa", border: "2px solid #d4d4d4" }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
        <strong>📦 Package</strong>
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          <span style={small}>Box</span>
          <select value={boxId} onChange={(e) => setBoxId(e.target.value)} style={input} aria-label="Box">
            {cfg.boxes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({trim(x.l)} × {trim(x.w)} × {trim(x.h)} {cfg.dimUnit})
              </option>
            ))}
            <option value="custom">{cfg.boxes.length ? "Other size…" : "Enter size…"}</option>
          </select>
        </label>
        {boxId === "custom" && (
          <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
            {dimInput("l")}×{dimInput("w")}×{dimInput("h")}
            <span style={small}>{cfg.dimUnit}</span>
          </span>
        )}
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          <span style={small}>Weight</span>
          <input
            ref={weightRef}
            type="text"
            inputMode="decimal"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder={cfg.weightUnit === "lb" ? "1.4" : cfg.weightUnit === "kg" ? "0.6" : "22"}
            aria-label={`Weight in ${cfg.weightUnit}`}
            autoComplete="off"
            style={{ ...input, width: "80px", fontSize: "16px", fontWeight: 700 }}
          />
          <span style={{ fontWeight: 600 }}>{cfg.weightUnit}</span>
        </label>
        <s-button variant="primary" type="submit" onClick={save} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
          Save
        </s-button>
        {p && (
          <s-button variant="tertiary" onClick={() => setEditing(false)}>
            Cancel
          </s-button>
        )}
      </div>
      <div style={{ ...small, marginTop: "6px" }}>
        {cfg.step === "required" ? "Needed before the label. " : ""}Type the weight and press Enter.
      </div>
      {err && <div style={{ fontSize: "13px", marginTop: "6px", color: "#b42318" }}>{err}</div>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

const STEPS = [
  { value: "ask", label: "Ask after packing", help: "The box and weight form appears as soon as a box is packed. Packers can skip it." },
  { value: "required", label: "Required before the label", help: "The label button stays off until a weight is entered." },
  { value: "off", label: "Off", help: "No box or weight at the pack station." },
];

const parseBoxes = (s) => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export function PackageSettings({ st, canSettings }) {
  const fetcher = useFetcher();
  const initial = () => ({
    step: st.packageStep ?? "ask",
    weightUnit: st.weightUnit ?? "lb",
    dimUnit: st.dimUnit ?? "in",
    packedTag: st.packedTag !== false,
    labelBoxId: st.labelBoxId ?? "",
    labelNotify: st.labelNotify !== false,
    boxes: parseBoxes(st.boxes).map((b) => ({ ...b, l: String(b.l), w: String(b.w), h: String(b.h), wt: b.wt != null ? String(b.wt) : "" })),
  });
  const [f, setF] = useState(initial);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setF(initial());
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.packageStep, st.weightUnit, st.dimUnit, st.boxes, st.packedTag, st.labelBoxId, st.labelNotify]);
  const set = (patch) => {
    setF((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  const setBox = (i, patch) => set({ boxes: f.boxes.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const dis = !canSettings;
  const saved = fetcher.state === "idle" && fetcher.data?.intent === "packageSettings";
  useEffect(() => {
    if (saved && fetcher.data.ok) setDirty(false);
  }, [saved, fetcher.data]);

  return (
    <s-section heading="Packages and labels">
      <s-paragraph>
        <span style={muted}>
          {IN_APP_LABELS
            ? "Box and weight are entered at the pack station and used when the label is bought in the app. Labels are bought through Shopify Shipping and charged to your Shopify bill as usual."
            : "Box and weight are entered at the pack station and shown at the label step, ready to enter on Shopify's label page."}
        </span>
      </s-paragraph>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
        {STEPS.map((m) => (
          <label key={m.value} style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
            <input type="radio" name="packageStep" checked={f.step === m.value} disabled={dis} onChange={() => set({ step: m.value })} style={{ marginTop: "3px" }} />
            <span>
              <strong>{m.label}</strong>
              <div style={small}>{m.help}</div>
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginTop: "12px", alignItems: "center" }}>
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          Weight in
          <select value={f.weightUnit} disabled={dis} onChange={(e) => set({ weightUnit: e.target.value })} style={input}>
            {["lb", "oz", "kg", "g"].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          Sizes in
          <select value={f.dimUnit} disabled={dis} onChange={(e) => set({ dimUnit: e.target.value })} style={input}>
            {["in", "cm"].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ marginTop: "14px" }}>
        <div style={{ fontWeight: 600, marginBottom: "6px" }}>Your boxes</div>
        {f.boxes.length === 0 && <div style={{ ...small, marginBottom: "6px" }}>None yet. Packers can still type a size for each box.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {f.boxes.map((b, i) => (
            <div key={b.id ?? i} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <input value={b.name} disabled={dis} onChange={(e) => setBox(i, { name: e.target.value })} placeholder="Name, e.g. Medium mailer" aria-label="Box name" style={{ ...input, width: "200px" }} />
              {["l", "w", "h"].map((k, n) => (
                <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  {n > 0 && "×"}
                  <input value={b[k]} disabled={dis} inputMode="decimal" onChange={(e) => setBox(i, { [k]: e.target.value })} placeholder={k.toUpperCase()} aria-label={{ l: "Length", w: "Width", h: "Height" }[k]} style={{ ...input, width: "56px" }} />
                </span>
              ))}
              <span style={small}>{f.dimUnit}</span>
              {IN_APP_LABELS && (
                <>
                  <input
                    value={b.wt}
                    disabled={dis}
                    inputMode="decimal"
                    onChange={(e) => setBox(i, { wt: e.target.value })}
                    placeholder="Empty wt"
                    title="Weight of the empty box (used when no weight is entered)"
                    aria-label="Empty weight"
                    style={{ ...input, width: "72px" }}
                  />
                  <span style={small}>{f.weightUnit}</span>
                </>
              )}
              {!dis && (
                <s-button variant="tertiary" tone="critical" onClick={() => set({ boxes: f.boxes.filter((_, j) => j !== i) })}>
                  Remove
                </s-button>
              )}
            </div>
          ))}
        </div>
        {!dis && (
          <div style={{ marginTop: "8px" }}>
            <s-button variant="tertiary" onClick={() => set({ boxes: [...f.boxes, { id: `n${Date.now().toString(36)}`, name: "", l: "", w: "", h: "", wt: "" }] })}>
              + Add a box
            </s-button>
          </div>
        )}
      </div>

      {IN_APP_LABELS && (
      <>
      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginTop: "14px", alignItems: "center" }}>
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          Box for labels when none was entered
          <select value={f.labelBoxId} disabled={dis} onChange={(e) => set({ labelBoxId: e.target.value })} style={input}>
            <option value="">None (ask for one)</option>
            {f.boxes
              .filter((b) => b.name)
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginTop: "10px" }}>
        <input type="checkbox" checked={f.labelNotify} disabled={dis} onChange={(e) => set({ labelNotify: e.target.checked })} style={{ marginTop: "3px" }} />
        <span>
          <strong>Email the customer when their label is bought</strong>
          <div style={small}>Shopify's shipping confirmation, with tracking.</div>
        </span>
      </label>
      </>
      )}

      <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginTop: "14px" }}>
        <input type="checkbox" checked={f.packedTag} disabled={dis} onChange={(e) => set({ packedTag: e.target.checked })} style={{ marginTop: "3px" }} />
        <span>
          <strong>Tag packed orders "Packed"</strong>
          <div style={small}>
            For buying labels on Shopify's own bulk page: opens Shopify's order list with just a batch's packed, unshipped orders. The
            tag comes off once the order ships.
          </div>
        </span>
      </label>

      {canSettings && (
        <div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
          <s-button
            variant="primary"
            onClick={() =>
              fetcher.submit(
                {
                  intent: "packageSettings",
                  step: f.step,
                  weightUnit: f.weightUnit,
                  dimUnit: f.dimUnit,
                  packedTag: f.packedTag ? "1" : "",
                  boxes: JSON.stringify(f.boxes),
                  labelBoxId: f.labelBoxId,
                  labelNotify: f.labelNotify ? "1" : "0",
                },
                { method: "post" },
              )
            }
            {...(fetcher.state !== "idle" ? { loading: true } : {})}
            {...(!dirty ? { disabled: true } : {})}
          >
            Save
          </s-button>
          {saved && fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
          {saved && fetcher.data?.ok && !dirty && <span style={{ color: "#1a5e20" }}>Saved</span>}
        </div>
      )}
    </s-section>
  );
}

// "Buy labels in bulk": Shopify's order list filtered to this batch's packed,
// unshipped orders. Select all there, then "Create shipping labels".
export function BulkLabelsButton({ bulk }) {
  const admin = useCtx(ShopAdminContext);
  if (!bulk?.tagging || !admin) return null;
  const n = bulk.ready;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
      {n > 0 ? (
        <GreenButton href={`${admin}/orders?query=${encodeURIComponent(bulk.query)}`} target="_blank">
          Buy labels in bulk ({n}) ↗
        </GreenButton>
      ) : null}
      {bulk.pending > 0 && <span style={small}>{n ? `${bulk.pending} more being tagged…` : `Getting ${bulk.pending} order${bulk.pending === 1 ? "" : "s"} ready in Shopify…`}</span>}
    </span>
  );
}
