// Shared look for the Purchase orders pages
export const cell = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
export const head = { ...cell, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 1 };
export const num = { ...cell, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
export const muted = { color: "#616161", fontSize: "12px" };
export const input = { padding: "5px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit", boxSizing: "border-box" };
export const box = { border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto" };
export const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" });

export const STATUS = {
  pending: ["Pending", "#f1f1f1", "#4a4a4a"],
  open: ["Open", "#e0ecff", "#1c4a9c"],
  partial: ["Partially received", "#fff4d6", "#7a4f01"],
  received: ["Received", "#e3f1df", "#1a5e20"],
  closed: ["Closed", "#ececec", "#303030"],
};
export function StatusPill({ status }) {
  const [label, bg, fg] = STATUS[status] ?? [status, "#f1f1f1", "#4a4a4a"];
  return <span style={pill(bg, fg)}>{label}</span>;
}

export const money = (n, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(n) || 0);
export const fmtDate = (s, time = false) =>
  s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", ...(time ? { hour: "numeric", minute: "2-digit" } : {}) }) : "—";
// A plain date (no time), stored as midnight UTC
export const fmtDay = (s) => (s ? new Date(s).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
export const dayValue = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

export function Err({ data }) {
  if (!data?.error) return null;
  return <div style={{ color: "#b42318", fontSize: "13px", marginTop: "6px" }}>{data.error}</div>;
}
