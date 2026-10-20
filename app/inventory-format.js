// Turns Shopify's raw inventory history rows into readable changes.
// Used by the test page now and by the product page card later.
//
// Shopify records each change as several rows sharing a group ID, e.g.
//   manual change: available -1  +  system +1   (system is a balancing entry)
//   order:         available -1  +  committed +1
// These are merged into one change, and "system" rows are dropped.

const REASONS = {
  manual_adjustment: "Manual adjustment",
  correction: "Correction",
  cycle_count_available: "Stock count",
  damaged: "Damaged",
  movement_created: "Transfer created",
  movement_updated: "Transfer updated",
  movement_received: "Transfer received",
  movement_canceled: "Transfer canceled",
  other: "Other",
  promotion: "Promotion",
  quality_control: "Quality control",
  received: "Received",
  reservation_created: "Reserved",
  reservation_deleted: "Reservation released",
  reservation_updated: "Reservation updated",
  restock: "Restock",
  safety_stock: "Safety stock",
  shrinkage: "Shrinkage",
  purchase: "Order",
  order_edit: "Order edit",
  fulfillment: "Fulfillment",
  return: "Return",
  cancellation: "Order canceled",
};

const STATES = {
  available: "available",
  on_hand: "on hand",
  committed: "committed",
  reserved: "reserved",
  incoming: "incoming",
  damaged: "damaged",
  quality_control: "quality control",
  safety_stock: "safety stock",
};

const clean = (v) => (v === null || v === undefined || v === "" || v === "—" ? null : String(v));

export function reasonLabel(reason) {
  const r = clean(reason);
  if (!r) return null;
  return REASONS[r] ?? r.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function whoLabel(staff, app) {
  const s = clean(staff);
  const a = clean(app);
  if (s && a) return `${s} · ${a}`;
  return s ?? a ?? "Unknown";
}

// Shopify numeric ID from a "gid://shopify/Order/123" or plain "123"
export const numericId = (v) => clean(v)?.match(/(\d+)$/)?.[1] ?? null;

// rows: raw ShopifyQL rows. Returns changes, newest first:
// { key, at, parts: [{ state, label, change }], mainChange, who, app, staff,
//   reason, reasonLabel, location, sku, order: { id } | null, referenceUri }
export function groupChanges(rows) {
  const groups = new Map();

  for (const r of rows) {
    const key = clean(r.inventory_adjustment_group_id) ?? `${r.second}|${r.product_variant_sku ?? ""}`;
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(r);
  }

  const changes = [];
  for (const g of groups.values()) {
    const first = g.rows[0];
    const parts = g.rows
      .filter((r) => clean(r.inventory_state) && r.inventory_state !== "system")
      .map((r) => ({
        state: r.inventory_state,
        label: STATES[r.inventory_state] ?? String(r.inventory_state).replace(/_/g, " "),
        change: Number(r.inventory_adjustment_change ?? 0),
      }))
      .filter((p) => p.change !== 0);

    // Show "available" first; it's the number people care about most
    parts.sort((a, b) => (a.state === "available" ? -1 : b.state === "available" ? 1 : 0));

    const refType = clean(g.rows.map((r) => r.reference_document_type).find(clean));
    const refId = clean(g.rows.map((r) => r.reference_document_id).find(clean));
    const refUri = clean(g.rows.map((r) => r.reference_document_uri).find(clean));
    const orderId = refType === "Order" ? refId ?? numericId(refUri) : null;

    const staff = clean(g.rows.map((r) => r.staff_member_name).find(clean));
    const app = clean(g.rows.map((r) => r.inventory_app_name).find(clean));

    changes.push({
      key: g.key,
      at: first.second ?? first.minute ?? null,
      parts,
      mainChange: parts.find((p) => p.state === "available")?.change ?? parts[0]?.change ?? 0,
      staff,
      app,
      who: whoLabel(staff, app),
      reason: clean(first.inventory_change_reason),
      reasonLabel: reasonLabel(first.inventory_change_reason),
      location: clean(g.rows.map((r) => r.inventory_location_name).find(clean)),
      sku: clean(first.product_variant_sku),
      order: orderId ? { id: orderId } : null,
      referenceUri: refUri,
    });
  }

  return changes.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export const signed = (n) => (n > 0 ? `+${n}` : String(n));
