import { code128Svg } from "./code128";
import { fmtDate, useParamSetter } from "./ui";

const SLIP_CSS = `
.sh-slip { border: 1px solid #e3e3e3; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; background: #fff; color: #111; }
.sh-slip h3 { margin: 0; font-size: 20px; }
.sh-slip table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
.sh-slip th, .sh-slip td { text-align: left; padding: 6px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
.sh-slip .qty { font-size: 16px; font-weight: 700; width: 48px; }
.sh-slip .bin { font-weight: 700; width: 70px; }
.sh-slip .note { border: 2px solid #111; border-radius: 6px; padding: 8px 10px; margin-top: 10px; white-space: pre-wrap; }
.sh-slip .warn { border: 2px dashed #111; border-radius: 6px; padding: 6px 10px; margin-top: 8px; font-weight: 700; }
@media print {
  .sh-noprint { display: none !important; }
  .sh-slip { border: 0; border-radius: 0; padding: 0; margin: 0; break-after: page; page-break-after: always; }
  .sh-slip:last-child { break-after: auto; page-break-after: auto; }
}
`;

export function Slips({ data }) {
  const go = useParamSetter();
  return (
    <s-section>
      <style>{SLIP_CSS}</style>
      <div className="sh-noprint" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
        <button
          type="button"
          onClick={() => go({ view: "pack", slips: null }, { replace: false })}
          style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" }}
        >
          ← Back to packing
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#616161" }}>
          {data.slips.length} packing slip{data.slips.length === 1 ? "" : "s"} · {data.batch.tag}
          {data.batch.name ? ` · ${data.batch.name}` : ""} · one per page when printed
        </span>
        <s-button variant="primary" onClick={() => window.print()}>
          Print
        </s-button>
      </div>
      {data.slips.map((s) => (
        <div key={s.id} className="sh-slip">
          <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "12px", letterSpacing: ".08em", textTransform: "uppercase", color: "#555" }}>Packing slip</div>
              <h3>
                {s.orderName}
                {s.part ? ` · part ${s.part}` : ""}
              </h3>
              <div style={{ fontSize: "13px", marginTop: "2px" }}>
                Ordered {fmtDate(s.orderCreatedAt)} · {data.batch.tag}
                {s.shippingMethod ? ` · ${s.shippingMethod}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div dangerouslySetInnerHTML={{ __html: code128Svg(s.barcode, { height: 46, module: 2 }) }} />
              <div style={{ fontSize: "12px", letterSpacing: ".1em" }}>{s.barcode}</div>
            </div>
          </div>
          <div style={{ marginTop: "10px", fontSize: "14px", lineHeight: 1.4 }}>
            <div style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: ".08em", color: "#555" }}>Ship to</div>
            {s.shipTo.map((l, i) => (
              <div key={i} style={i === 0 ? { fontWeight: 700 } : undefined}>
                {l}
              </div>
            ))}
          </div>
          {s.addressWarning && (
            <div className="warn">⚠ Shopify says this address {s.addressWarning === "ERROR" ? "is likely invalid" : "may be invalid"}. Check before shipping.</div>
          )}
          <table>
            <thead>
              <tr>
                <th>Qty</th>
                <th>Item</th>
                <th>SKU</th>
                <th>Bin</th>
                <th style={{ width: "28px" }}>✓</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l, i) => (
                <tr key={i}>
                  <td className="qty">{l.qty}</td>
                  <td>
                    {l.title}
                    {l.variantTitle ? ` – ${l.variantTitle}` : ""}
                  </td>
                  <td>{l.sku ?? ""}</td>
                  <td className="bin">{l.bin ?? ""}</td>
                  <td>
                    <span style={{ display: "inline-block", width: "16px", height: "16px", border: "1.5px solid #111", borderRadius: "3px" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.note && (
            <div className="note">
              <strong>Order note: </strong>
              {s.note}
            </div>
          )}
        </div>
      ))}
    </s-section>
  );
}
