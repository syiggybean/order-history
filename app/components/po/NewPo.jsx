import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { Err, box, cell, head, input, money, muted, num } from "./ui";

// New PO: drop a CSV, check the preview, pick the supplier, create (pending)
export function NewPo() {
  const { suppliers, locations, defaultLocationId } = useLoaderData();
  const [, setParams] = useSearchParams();
  const parser = useFetcher();
  const creator = useFetcher();
  const [file, setFile] = useState(null); // { name }
  const [drag, setDrag] = useState(false);
  const [readError, setReadError] = useState(null);
  const [supplierId, setSupplierId] = useState("");
  const [locationId, setLocationId] = useState(defaultLocationId ?? "");
  const [expectedAt, setExpectedAt] = useState("");
  const [note, setNote] = useState("");
  const inputRef = useRef(null);

  const parsed = parser.data?.intent === "parse" && parser.data.lines ? parser.data : null;
  const supplier = suppliers.find((s) => String(s.id) === String(supplierId));

  useEffect(() => {
    if (creator.state === "idle" && creator.data?.ok) setParams({ po: String(creator.data.id) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creator.state, creator.data]);

  const read = (f) => {
    setReadError(null);
    if (!f) return;
    if (!/\.(csv|txt|tsv)$/i.test(f.name) && !/csv|text/.test(f.type)) {
      setReadError("That isn't a CSV file. In Excel or Google Sheets, use File → Download / Save as → CSV.");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setReadError("That file is over 5 MB.");
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setFile({ name: f.name });
      parser.submit({ intent: "parse", csv: String(r.result) }, { method: "post" });
    };
    r.onerror = () => setReadError("The file couldn't be read.");
    r.readAsText(f);
  };

  const errors = parsed?.warnings?.filter((w) => w.level === "error") ?? [];
  const warnings = parsed?.warnings?.filter((w) => w.level !== "error") ?? [];

  return (
    <>
      <s-section heading="New purchase order">
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            read(e.dataTransfer.files?.[0]);
          }}
          style={{
            border: `2px dashed ${drag ? "#005bd3" : "#b5b5b5"}`,
            background: drag ? "#eef4ff" : "#fafafa",
            borderRadius: "12px",
            padding: "28px 16px",
            textAlign: "center",
            cursor: "pointer",
            transition: "background .15s,border-color .15s",
          }}
        >
          <div style={{ fontSize: "16px", fontWeight: 600 }}>{file ? `${file.name}` : "Drop a CSV file here"}</div>
          <div style={{ ...muted, marginTop: "4px" }}>
            {file ? "Drop another file to replace it, or click to choose." : "or click to choose one"} · Columns: SKU, Supplier Code, Supplier Barcode, Title,
            Quantity, Unit Cost, Tax Rate, Tax (Total is worked out)
          </div>
          {parser.state !== "idle" && <div style={{ marginTop: "8px" }}>Reading…</div>}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              read(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {readError && <div style={{ color: "#b42318", marginTop: "8px" }}>{readError}</div>}
        <Err data={parser.data} />
        <div style={{ ...muted, marginTop: "8px" }}>
          Tax rate can be written as 8.25, 8.25% or 0.0825. If the Tax column is empty it's worked out from the rate. A Total column in the file is checked and
          then recalculated as quantity × unit cost + tax.{" "}
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent("SKU,Supplier Code,Supplier Barcode,Title,Quantity,Unit Cost,Tax Rate,Tax\nLORE-V1,SS-1001,9781638581234,Lore Vol. 1,60,8.50,8.25%,\nMIST-V1,SS-1002,9781638585678,Mist Vol. 1,40,9.25,8.25%,\n")}`}
            download="po-template.csv"
            onClick={(e) => e.stopPropagation()}
          >
            Download a sample CSV
          </a>
        </div>
      </s-section>

      {parsed && (
        <s-section heading={`Preview: ${parsed.lines.length} line${parsed.lines.length === 1 ? "" : "s"}, ${parsed.totals.units.toLocaleString()} units`}>
          {errors.length > 0 && (
            <s-banner tone="critical" heading={`${errors.length} row${errors.length === 1 ? "" : "s"} couldn't be read and will be left out`}>
              {errors.slice(0, 20).map((w) => (
                <div key={w.row + w.text}>{w.text}</div>
              ))}
            </s-banner>
          )}
          {warnings.length > 0 && (
            <div style={{ margin: "8px 0" }}>
              <s-banner tone="warning" heading={`${warnings.length} thing${warnings.length === 1 ? "" : "s"} to check`}>
                {warnings.slice(0, 20).map((w) => (
                  <div key={w.row + w.text}>{w.text}</div>
                ))}
              </s-banner>
            </div>
          )}
          <div style={{ ...box, maxHeight: "420px", marginTop: "8px" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  {["SKU", "Supplier code", "Supplier barcode", "Title"].map((h) => (
                    <th key={h} style={head}>
                      {h}
                    </th>
                  ))}
                  {["Qty", "Unit cost", "Tax rate", "Tax", "Total"].map((h) => (
                    <th key={h} style={{ ...head, textAlign: "right" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={cell}>{l.sku ?? "—"}</td>
                    <td style={cell}>{l.supplierCode ?? "—"}</td>
                    <td style={cell}>{l.supplierBarcode ?? "—"}</td>
                    <td style={cell}>{l.title}</td>
                    <td style={num}>{l.quantity.toLocaleString()}</td>
                    <td style={num}>{money(l.unitCost)}</td>
                    <td style={num}>{l.taxRate}%</td>
                    <td style={num}>{money(l.tax)}</td>
                    <td style={{ ...num, fontWeight: 600 }}>{money(l.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...cell, fontWeight: 600 }} colSpan={4}>
                    Totals
                  </td>
                  <td style={{ ...num, fontWeight: 600 }}>{parsed.totals.units.toLocaleString()}</td>
                  <td style={num} colSpan={2}>
                    Subtotal {money(parsed.totals.subtotal)}
                  </td>
                  <td style={num}>{money(parsed.totals.taxTotal)}</td>
                  <td style={{ ...num, fontWeight: 700 }}>{money(parsed.totals.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </s-section>
      )}

      {parsed && (
        <s-section heading="Details">
          <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <label>
              <div style={muted}>Supplier</div>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={{ ...input, width: "100%" }}>
                <option value="">Choose a supplier…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {supplier && <div style={muted}>{supplier.emails ?? "No email saved"}</div>}
              <div style={muted}>
                Not listed?{" "}
                <a href="?view=suppliers" onClick={(e) => (e.preventDefault(), setParams({ view: "suppliers" }))}>
                  Add a supplier
                </a>{" "}
                (this file will need dropping again).
              </div>
            </label>
            <label>
              <div style={muted}>Receive at</div>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ ...input, width: "100%" }}>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <div style={muted}>Expected by (optional)</div>
              <input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} style={{ ...input, width: "100%" }} />
            </label>
          </div>
          <label style={{ display: "block", marginTop: "12px" }}>
            <div style={muted}>Note for the supplier (printed on the PO)</div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} style={{ ...input, width: "100%" }} />
          </label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "12px" }}>
            <s-button
              variant="primary"
              onClick={() =>
                creator.submit(
                  { intent: "create", lines: JSON.stringify(parsed.lines), supplierId, locationId, expectedAt, supplierNote: note, sourceFile: file?.name ?? "" },
                  { method: "post" },
                )
              }
              {...(creator.state !== "idle" ? { loading: true } : {})}
              {...(!supplierId ? { disabled: true } : {})}
            >
              Create purchase order
            </s-button>
            <span style={muted}>It starts as Pending. Emailing or exporting it opens it.</span>
          </div>
          <Err data={creator.data} />
        </s-section>
      )}
    </>
  );
}
