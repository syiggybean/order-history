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

// size: a larger link (e.g. the open box's heading on the pack bench)
export function OrderLink({ orderId, orderNumber, name, size = null }) {
  const open = useContext(OrderViewContext);
  if (!open || !orderId)
    return orderNumber ? (
      <a href={`shopify:admin/orders/${orderNumber}`} target="_top" style={{ color: "#005bd3", fontWeight: 600, ...(size ? { fontSize: size } : {}) }}>
        {name}
      </a>
    ) : (
      <>{name}</>
    );
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "6px" }}>
      <button
        type="button"
        style={{ ...linkBtn, ...(size ? { fontSize: size, fontWeight: 700 } : {}) }}
        onClick={(e) => {
          // Inside clickable rows (e.g. the pack queue): just the quick view
          e.stopPropagation();
          open(orderId);
        }}
        title="Order quick view"
      >
        {name}
      </button>
      <a href={`shopify:admin/orders/${orderNumber}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} aria-label={`Open ${name} in Shopify (new tab)`} title="Open in Shopify" style={{ color: "#8a8a8a", textDecoration: "none", fontSize: "12px" }}>
        ↗
      </a>
    </span>
  );
}

