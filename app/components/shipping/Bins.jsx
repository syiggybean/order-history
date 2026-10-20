import { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigation } from "react-router";
import { ProductName, box, cell, head, input, muted, small, ProductThumb, useParamSetter } from "./ui";

function BinCell({ item, canEdit }) {
  const fetcher = useFetcher();
  const [value, setValue] = useState(item.bin ?? "");
  const [saved, setSaved] = useState(item.bin ?? "");
  useEffect(() => {
    setValue(item.bin ?? "");
    setSaved(item.bin ?? "");
  }, [item.bin]);
  useEffect(() => {
    if (fetcher.data?.intent === "setBin" && fetcher.data.ok) setSaved(fetcher.data.bin ?? "");
  }, [fetcher.data]);
  if (!canEdit) return <strong>{item.bin ?? <span style={muted}>—</span>}</strong>;
  const save = () => {
    if (value.trim() === saved) return;
    fetcher.submit({ intent: "setBin", item: JSON.stringify(item), bin: value.trim() }, { method: "post" });
  };
  const state = fetcher.state !== "idle" ? "saving" : fetcher.data?.error ? "error" : value.trim() === saved && fetcher.data?.ok ? "saved" : null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
            // Next row's bin box, for fast entry down the list
            const all = [...document.querySelectorAll("input[data-bin]")];
            all[all.indexOf(e.currentTarget) + 1]?.focus();
          }
        }}
        data-bin="1"
        placeholder="Bin"
        aria-label={`Bin for ${item.title}`}
        style={{ ...input, width: "110px", fontWeight: 600 }}
      />
      <span style={{ ...small, width: "52px", color: state === "error" ? "#b42318" : state === "saved" ? "#1a7f37" : "#616161" }}>
        {state === "saving" ? "Saving…" : state === "saved" ? "✓ Saved" : state === "error" ? "Not saved" : ""}
      </span>
    </span>
  );
}

function Import() {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const r = fetcher.data?.intent === "importBins" ? fetcher.data : null;
  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
  };
  if (!open)
    return (
      <s-button variant="secondary" onClick={() => setOpen(true)}>
        Import bins
      </s-button>
    );
  return (
    <div className="sh-rise" style={{ ...box, padding: "14px", marginTop: "10px", width: "100%" }}>
      <s-paragraph>
        One item per line: <strong>SKU or barcode</strong>, then <strong>bin</strong>, separated by a comma or tab. Paste from a spreadsheet or choose a
        CSV file. Items that aren't on any order yet are looked up in Shopify.
      </s-paragraph>
      <input type="file" accept=".csv,.txt,.tsv,text/csv" onChange={onFile} style={{ margin: "6px 0" }} aria-label="CSV file" />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={"9781234567890, A-01\nLORE-01, A-02"}
        aria-label="Bins to import"
        style={{ ...input, width: "100%", fontFamily: "ui-monospace, Menlo, monospace", boxSizing: "border-box" }}
      />
      <div style={{ display: "flex", gap: "8px", marginTop: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <s-button variant="primary" onClick={() => fetcher.submit({ intent: "importBins", text }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
          Import
        </s-button>
        <s-button variant="tertiary" onClick={() => setOpen(false)}>
          Close
        </s-button>
        {r?.error && <span style={{ color: "#b42318" }}>{r.error}</span>}
        {r?.ok && (
          <span style={{ color: "#1a7f37" }}>
            {r.updated} bin{r.updated === 1 ? "" : "s"} set.
            {r.notFoundCount ? (
              <span style={{ color: "#b42318" }}>
                {" "}
                {r.notFoundCount} not found: {r.notFound.join(", ")}
                {r.notFoundCount > r.notFound.length ? "…" : ""}
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}

function Export() {
  const fetcher = useFetcher();
  useEffect(() => {
    const csv = fetcher.data?.intent === "exportBins" ? fetcher.data.csv : null;
    if (!csv) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `bins-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [fetcher.data]);
  return (
    <s-button variant="tertiary" onClick={() => fetcher.submit({ intent: "exportBins" }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})}>
      Export CSV
    </s-button>
  );
}

export function BinsTab({ items, q, missing, canEdit }) {
  const go = useParamSetter();
  const navigation = useNavigation();
  const [query, setQuery] = useState(q);
  const timer = useRef(null);
  const without = items.filter((i) => !i.bin).length;
  return (
    <s-section heading="Bins">
      <s-paragraph>
        <span style={muted}>
          Where each item lives on the shelves. Pick lists are sorted by bin. Items on open orders are listed first, most units to ship at the top.
          {canEdit ? " Type a bin and press Enter to jump to the next row." : ""}
        </span>
      </s-paragraph>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", margin: "10px 0" }}>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = setTimeout(() => go({ q: v.trim() }), 300);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              clearTimeout(timer.current);
              go({ q: query.trim() });
            }
          }}
          placeholder="Search or scan an item"
          aria-label="Search items"
          style={{ ...input, minWidth: "240px", flexGrow: 1, maxWidth: "360px" }}
        />
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
          <input type="checkbox" checked={missing} onChange={(e) => go({ missing: e.target.checked ? "1" : null })} />
          Only items without a bin
        </label>
        {navigation.state === "loading" && <span style={muted}>Loading…</span>}
        <span style={{ flex: 1 }} />
        {canEdit && <Import />}
        <Export />
      </div>
      {!missing && without > 0 && <div style={{ ...small, marginBottom: "8px" }}>{without} of these have no bin yet.</div>}
      {!items.length ? (
        <s-paragraph>{q || missing ? "No items match." : "No items yet. Items appear here once they're on an open order."}</s-paragraph>
      ) : (
        <div style={{ ...box, maxHeight: "680px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Item", "SKU / barcode", "Units to ship", "Bin"].map((h) => (
                  <th key={h} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.variantId}>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <ProductThumb src={i.imageUrl} />
                      <span>
                        <ProductName id={i.productId}>{i.title}</ProductName>
                        {i.variantTitle && <span style={muted}> – {i.variantTitle}</span>}
                      </span>
                    </div>
                  </td>
                  <td style={{ ...cell, ...small }}>{[i.sku, i.barcode && i.barcode !== i.sku ? i.barcode : null].filter(Boolean).join(" · ") || "—"}</td>
                  <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{i.units || <span style={muted}>—</span>}</td>
                  <td style={cell}>
                    <BinCell item={i} canEdit={canEdit} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}
