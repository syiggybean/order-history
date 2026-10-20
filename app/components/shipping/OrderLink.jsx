import { createContext, useContext } from "react";

// Order numbers open the order quick view when the page provides one
export const OrderViewContext = createContext(null);

const linkBtn = {
  appearance: "none",
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "#005bd3",
  fontWeight: 600,
  cursor: "pointer",
  textAlign: "left",
};

export function OrderLink({ orderId, orderNumber, name }) {
  const open = useContext(OrderViewContext);
  if (!open)
    return (
      <a href={`shopify:admin/orders/${orderNumber}`} target="_top" style={{ color: "#005bd3", fontWeight: 600 }}>
        {name}
      </a>
    );
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "6px" }}>
      <button type="button" style={linkBtn} onClick={() => open(orderId)} title="Quick view">
        {name}
      </button>
      <a href={`shopify:admin/orders/${orderNumber}`} target="_blank" rel="noreferrer" aria-label={`Open ${name} in Shopify (new tab)`} title="Open in Shopify" style={{ color: "#8a8a8a", textDecoration: "none", fontSize: "12px" }}>
        ↗
      </a>
    </span>
  );
}

