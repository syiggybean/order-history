import { useRef, useState } from "react";
import { useLoaderData, useNavigation, useSearchParams } from "react-router";
import { StatusPill, box, cell, fmtDate, fmtDay, head, input, money, muted, num, pill } from "./ui";

const FILTERS = [
  ["active", "Active"],
  ["pending", "Pending"],
  ["open", "Open"],
  ["partial", "Partially received"],
  ["received", "Received"],
  ["closed", "Closed"],
  ["all", "All"],
];

export function PoList() {
  const { pos, counts, status, caps } = useLoaderData();
  const [params, setParams] = useSearchParams();
  const nav = useNavigation();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef(null);
  const set = (k, v) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (v) n.set(k, v);
      else n.delete(k);
      return n;
    });
  const countFor = (k) => (k === "active" ? (counts.pending ?? 0) + (counts.open ?? 0) + (counts.partial ?? 0) : k === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[k] ?? 0);
  return (
    <s-section>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" }}>
        {FILTERS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => set("status", k === "active" ? "" : k)}
            style={{ ...pill(status === k ? "#303030" : "#fff", status === k ? "#fff" : "#303030"), border: "1px solid #c9c9c9", padding: "4px 12px", cursor: "pointer", font: "inherit", fontSize: "13px" }}
          >
            {label} {countFor(k) ? `(${countFor(k)})` : ""}
          </button>
        ))}
        <input
          type="search"
          value={q}
          placeholder="PO number or supplier"
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => set("q", v.trim()), 300);
          }}
          style={{ ...input, minWidth: "200px" }}
        />
        <span style={{ flex: 1 }} />
        {nav.state === "loading" && <span style={muted}>Loading…</span>}
        {caps.generate && (
          <s-button variant="primary" onClick={() => setParams({ view: "new" })}>
            New purchase order
          </s-button>
        )}
      </div>
      {pos.length === 0 ? (
        <s-paragraph>{status === "active" && !q ? "No active purchase orders." : "Nothing matches."}</s-paragraph>
      ) : (
        <div style={{ ...box, maxHeight: "70vh" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={head}>PO</th>
                <th style={head}>Supplier</th>
                <th style={head}>Status</th>
                <th style={{ ...head, textAlign: "right" }}>Units</th>
                <th style={{ ...head, textAlign: "right" }}>Received</th>
                <th style={{ ...head, textAlign: "right" }}>Total</th>
                <th style={head}>Created</th>
                <th style={head}>Expected</th>
              </tr>
            </thead>
            <tbody>
              {pos.map((p) => (
                <tr key={p.id} onClick={() => setParams({ po: String(p.id) })} style={{ cursor: "pointer" }}>
                  <td style={{ ...cell, fontWeight: 700, color: "#005bd3" }}>{p.poNumber}</td>
                  <td style={cell}>{p.supplierName ?? <span style={muted}>No supplier</span>}</td>
                  <td style={cell}>
                    <StatusPill status={p.status} />
                  </td>
                  <td style={num}>
                    {p.units.toLocaleString()} <span style={muted}>· {p.lineCount} lines</span>
                  </td>
                  <td style={num}>{p.received ? `${p.received.toLocaleString()} (${Math.round((p.received / Math.max(1, p.units)) * 100)}%)` : "—"}</td>
                  <td style={num}>{money(p.total, p.currency)}</td>
                  <td style={cell}>
                    {fmtDate(p.createdAt)}
                    {p.createdBy && <div style={muted}>{p.createdBy}</div>}
                  </td>
                  <td style={cell}>{p.expectedAt ? fmtDay(p.expectedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}
