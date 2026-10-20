import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { PINK, ProductName, box, cell, fmtDate, head, muted, small, ProductThumb, useParamSetter, GreenButton } from "./ui";
import { StatusPill, batchTitle } from "./Batches";

const PRINT_CSS = `
@media print {
  .sh-noprint { display: none !important; }
  .sh-print-only { display: inline-block !important; }
  .sh-pick-box { max-height: none !important; overflow: visible !important; border: 0 !important; }
  .sh-pick-row { break-inside: avoid; }
  .sh-pick-row td { background: none !important; }
}
.sh-print-only { display: none; }
@keyframes shFlash { from { background: #fff1a8; } to { background: transparent; } }
.sh-flash td { animation: shFlash 1.2s ease-out; }
`;

// Short beeps so pickers can scan without looking at the screen
let audio;
function beep(ok) {
  try {
    audio = audio ?? new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    o.type = ok ? "sine" : "square";
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.3));
  } catch {
    /* no sound available */
  }
}

const label = (i) => `${i.title}${i.variantTitle ? ` – ${i.variantTitle}` : ""}`;

export function PickList({ data, canPick }) {
  const go = useParamSetter();
  const { batch } = data;
  const [items, setItems] = useState(data.items);
  const [code, setCode] = useState("");
  const [last, setLast] = useState(null); // { ok, text, key }
  const queue = useRef([]);
  const scanner = useFetcher();
  const adjust = useFetcher();
  const finish = useFetcher();
  const inputRef = useRef(null);
  const rowRefs = useRef({});
  const pickable = canPick && ["open", "picking"].includes(batch.status);

  useEffect(() => {
    setItems(data.items);
  }, [data.items]);

  const apply = (r) => {
    if (r?.key && r.picked != null) setItems((xs) => xs.map((i) => (i.key === r.key ? { ...i, picked: r.picked } : i)));
  };

  // Scans go one at a time, in order, so none are lost when they come in fast
  const pump = () => {
    if (scanner.state !== "idle" || !queue.current.length) return;
    const next = queue.current.shift();
    scanner.submit({ intent: "scan", id: String(batch.id), code: next }, { method: "post" });
  };
  useEffect(() => {
    const r = scanner.data;
    if (r?.intent === "scan") {
      if (r.ok) {
        apply(r);
        setLast({ ok: true, key: r.key, text: `${r.title}: ${r.picked} of ${r.qty}${r.bin ? ` · bin ${r.bin}` : ""}` });
        beep(true);
        rowRefs.current[r.key]?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      } else {
        setLast({ ok: false, key: r.key ?? null, text: r.error });
        beep(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanner.data]);
  useEffect(pump, [scanner.state]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => apply(adjust.data), [adjust.data]);

  const onScan = (e) => {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    queue.current.push(c);
    setCode("");
    pump();
  };
  const set = (i, n) => {
    setItems((xs) => xs.map((x) => (x.key === i.key ? { ...x, picked: n } : x)));
    adjust.submit({ intent: "setPicked", id: String(batch.id), key: i.key, qty: String(n) }, { method: "post" });
  };

  const units = items.reduce((n, i) => n + i.qty, 0);
  const picked = items.reduce((n, i) => n + i.picked, 0);
  const pct = units ? Math.round((picked / units) * 100) : 0;
  const short = finish.data?.intent === "finishPicking" && finish.data.short ? finish.data.short : null;

  return (
    <s-section>
      <style>{PRINT_CSS}</style>
      <div className="sh-noprint" style={{ marginBottom: "10px" }}>
        <button
          type="button"
          onClick={() => go({ view: null }, { replace: false })}
          style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" }}
        >
          ← Back to {batch.tag}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
        <h2 style={{ margin: 0, fontSize: "20px" }}>Pick list · {batchTitle(batch)}</h2>
        {batch.assignees?.length > 0 && <span style={small}>Assigned to {batch.assignees.map((a) => a.name).join(", ")}</span>}
        <StatusPill status={batch.status} />
      </div>
      <div style={{ ...small, margin: "6px 0 12px" }}>
        {batch.shipments} shipments · {units} units · {items.length} different items, sorted by bin · printed {fmtDate(new Date().toISOString(), true)}
        {batch.pickedAt ? ` · picked ${fmtDate(batch.pickedAt, true)}${batch.pickedBy ? ` by ${batch.pickedBy}` : ""}` : ""}
      </div>

      {/* Progress */}
      <div className="sh-noprint" style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div style={{ flex: 1, height: "10px", borderRadius: "5px", background: "#efefef", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#36a15a" : PINK, transition: "width .25s" }} />
        </div>
        <strong style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {picked} / {units} picked
        </strong>
      </div>

      {/* Picking done: on to packing */}
      {["picked", "packing"].includes(batch.status) && (
        <div
          className="sh-noprint sh-rise"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px", margin: "0 0 12px", padding: "12px 14px", borderRadius: "10px", background: "#e9f6ec", border: "1px solid #9fd3ad" }}
        >
          <strong style={{ color: "#1a5e20" }}>✓ Picking is finished.</strong>
          <span style={{ flex: 1 }} />
          <GreenButton onClick={() => go({ view: "pack" }, { replace: false })}>{batch.status === "packing" ? "Continue packing →" : "Pack this batch →"}</GreenButton>
        </div>
      )}

      {/* Scanner */}
      {pickable && (
        <form onSubmit={onScan} className="sh-noprint" style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "12px" }}>
          <input
            ref={inputRef}
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan a barcode or SKU"
            aria-label="Scan a barcode or SKU"
            autoFocus
            autoComplete="off"
            style={{ font: "inherit", fontSize: "16px", padding: "10px 12px", borderRadius: "10px", border: `2px solid ${PINK}`, minWidth: "280px", flex: "1 1 280px", maxWidth: "420px" }}
          />
          <div
            role="status"
            style={{
              flex: "2 1 260px",
              padding: "8px 12px",
              borderRadius: "10px",
              minHeight: "20px",
              background: !last ? "#f7f7f7" : last.ok ? "#e3f1df" : "#fde7e9",
              color: !last ? "#616161" : last.ok ? "#1a5e20" : "#8e1f0b",
              fontWeight: last ? 600 : 400,
            }}
          >
            {last ? last.text : "Scan each item as it goes in the tote. Wrong items are refused with a low beep."}
          </div>
        </form>
      )}

      {data.missingBins > 0 && (
        <div className="sh-noprint" style={{ ...small, marginBottom: "10px" }}>
          {data.missingBins} item{data.missingBins === 1 ? " has" : "s have"} no bin yet and {data.missingBins === 1 ? "is" : "are"} listed last. Set bins on the
          Bins tab.
        </div>
      )}

      <div className="sh-pick-box" style={{ ...box, maxHeight: "70vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "14px" }}>
          <thead>
            <tr>
              {["Bin", "Item", "Qty", "Picked"].map((h) => (
                <th key={h} style={head}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const done = i.picked >= i.qty;
              const flash = last?.key === i.key;
              return (
                <tr
                  key={i.key + (flash ? scanner.data?.picked : "")}
                  ref={(el) => (rowRefs.current[i.key] = el)}
                  className={`sh-pick-row${flash ? " sh-flash" : ""}`}
                  style={{ background: done ? "#f3faf1" : undefined }}
                >
                  <td style={{ ...cell, fontWeight: 700, fontSize: "16px", whiteSpace: "nowrap" }}>{i.bin ?? <span style={{ ...muted, fontWeight: 400 }}>—</span>}</td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                      <ProductThumb src={i.imageUrl} size={40} />
                      <div>
                        <div style={{ fontWeight: 600, textDecoration: done ? "line-through" : "none", textDecorationColor: "#9a9a9a" }}>
                          <ProductName id={i.productId}>{label(i)}</ProductName>
                        </div>
                        <div style={small}>
                          {[i.sku && `SKU ${i.sku}`, i.barcode && i.barcode !== i.sku && i.barcode].filter(Boolean).join(" · ")}
                          {i.orders > 1 ? ` · ${i.orders} orders` : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ ...cell, fontWeight: 700, fontSize: "18px", fontVariantNumeric: "tabular-nums" }}>{i.qty}</td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    <span className="sh-print-only" style={{ width: "22px", height: "22px", border: "2px solid #303030", borderRadius: "4px" }} />
                    <span className="sh-noprint" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      {pickable && (
                        <button type="button" aria-label={`One fewer ${label(i)}`} style={stepBtn} disabled={i.picked <= 0} onClick={() => set(i, i.picked - 1)}>
                          −
                        </button>
                      )}
                      <span style={{ minWidth: "52px", textAlign: "center", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: done ? "#1a7f37" : "#303030" }}>
                        {done ? "✓ " : ""}
                        {i.picked}/{i.qty}
                      </span>
                      {pickable && (
                        <button type="button" aria-label={`One more ${label(i)}`} style={stepBtn} disabled={done} onClick={() => set(i, i.picked + 1)}>
                          +
                        </button>
                      )}
                      {pickable && !done && i.qty > 1 && (
                        <button type="button" style={{ ...stepBtn, width: "auto", padding: "0 8px" }} onClick={() => set(i, i.qty)}>
                          All
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="sh-noprint" style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "12px" }}>
        <s-button onClick={() => window.print()}>Print</s-button>
        {pickable && (
          <s-button
            variant="primary"
            onClick={() => finish.submit({ intent: "finishPicking", id: String(batch.id) }, { method: "post" })}
            {...(finish.state !== "idle" ? { loading: true } : {})}
          >
            Finish picking
          </s-button>
        )}
        {canPick && batch.status === "picked" && (
          <s-button variant="tertiary" onClick={() => finish.submit({ intent: "reopenPicking", id: String(batch.id) }, { method: "post" })}>
            Go back to picking
          </s-button>
        )}
        {finish.data?.error && <span style={{ color: "#b42318" }}>{finish.data.error}</span>}
      </div>
      {short && (
        <div className="sh-noprint sh-rise" style={{ marginTop: "12px" }}>
          <s-banner
            tone="warning"
            heading={`${short.reduce((n, s) => n + s.missing, 0)} unit${short.reduce((n, s) => n + s.missing, 0) === 1 ? "" : "s"} not picked yet`}
          >
            <s-paragraph>
              {short.map((s) => `${s.missing} × ${s.title}${s.bin ? ` (bin ${s.bin})` : ""}`).join(", ")}
            </s-paragraph>
            <s-button
              tone="critical"
              onClick={() => finish.submit({ intent: "finishPicking", id: String(batch.id), force: "1" }, { method: "post" })}
            >
              Finish anyway
            </s-button>
          </s-banner>
        </div>
      )}
    </s-section>
  );
}

const stepBtn = {
  appearance: "none",
  width: "30px",
  height: "30px",
  borderRadius: "8px",
  border: "1px solid #c9c9c9",
  background: "#fff",
  font: "inherit",
  fontSize: "16px",
  cursor: "pointer",
};
