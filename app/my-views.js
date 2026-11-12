// My Views: the pages and tabs anyone can star. Shared by the route config,
// the server and the browser (no server-only code here).
//
// page:  the route under /app (and under /app/my-views when opened from My Views)
// param: the search param that picks the tab on that page, and its value
// need:  [feature, level or switch] needed to see it (see permissions.js)

export const VIEWS = [
  { id: "shipping-ready", page: "shipping", param: ["tab", "ready"], label: "Ready to ship", group: "Shipping", need: ["shipping", "view"], isDefault: true },
  { id: "shipping-waiting", page: "shipping", param: ["tab", "waiting"], label: "Waiting", group: "Shipping", need: ["shipping", "view"] },
  { id: "shipping-batches", page: "shipping", param: ["tab", "batches"], label: "Batches", group: "Shipping", need: ["shipping", "view"] },
  { id: "shipping-review", page: "shipping", param: ["tab", "review"], label: "Review", group: "Shipping", need: ["shipping", "view"] },
  { id: "shipping-merge", page: "shipping", param: ["tab", "merge"], label: "Order Merge", group: "Shipping", need: ["shipping", "merge"] },
  { id: "shipping-stock", page: "shipping", param: ["tab", "stock"], label: "Stock vs orders", group: "Shipping", need: ["shipping", "view"] },
  { id: "shipping-settings", page: "shipping", param: ["tab", "settings"], label: "Settings and activity", group: "Shipping", need: ["shipping", "view"] },
  { id: "stock", page: "stock", label: "Stock", group: null, need: ["stock", "view"] },
  { id: "reporting-dashboard", page: "reporting", param: ["tab", "dashboard"], label: "Dashboard", group: "Reporting", need: ["analytics", "view"], isDefault: true },
  { id: "reporting-reports", page: "reporting", param: ["tab", "reports"], label: "Reports", group: "Reporting", need: ["analytics", "view"] },
  { id: "preorders", page: "preorders", label: "Pre-orders", group: null, need: ["preorders", "view"] },
  { id: "countdowns-open", page: "preorder-countdowns", param: ["tab", "open"], label: "Open and upcoming", group: "Pre-order countdowns", need: ["preorders", "view"], isDefault: true },
  { id: "countdowns-history", page: "preorder-countdowns", param: ["tab", "history"], label: "History", group: "Pre-order countdowns", need: ["preorders", "view"] },
  { id: "countdowns-emails", page: "preorder-countdowns", param: ["tab", "emails"], label: "Emails and settings", group: "Pre-order countdowns", need: ["preorders", "view"] },
  { id: "countdowns-auto", page: "preorder-countdowns", param: ["tab", "auto"], label: "Automatic", group: "Pre-order countdowns", need: ["preorders", "view"] },
  { id: "po-list", page: "purchase-orders", param: ["view", "list"], label: "Purchase orders", group: "Purchase orders", need: ["purchaseOrders", "view"], isDefault: true },
  { id: "po-suppliers", page: "purchase-orders", param: ["view", "suppliers"], label: "Suppliers", group: "Purchase orders", need: ["purchaseOrders", "view"] },
  { id: "po-template", page: "purchase-orders", param: ["view", "template"], label: "PO template", group: "Purchase orders", need: ["purchaseOrders", "view"] },
  { id: "po-import", page: "purchase-orders", param: ["view", "import"], label: "Linnworks import", group: "Purchase orders", need: ["purchaseOrders", "importLinnworks"] },
  { id: "receiving", page: "receiving", label: "Receiving", group: null, need: ["receiving", "view"] },
  { id: "release-review", page: "release-review", label: "Release date review", group: null, need: ["releaseReview", "view"] },
  { id: "inventory", page: "inventory", label: "Inventory history", group: null, need: ["inventory", "view"] },
  { id: "wishlist", page: "wishlist", label: "Wishlists", group: null, need: ["wishlist", "view"] },
  { id: "loyalty-members", page: "loyalty", param: ["tab", "members"], label: "Members", group: "Loyalty", need: ["loyalty", "view"], isDefault: true },
  { id: "loyalty-activity", page: "loyalty", param: ["tab", "activity"], label: "Activity", group: "Loyalty", need: ["loyalty", "view"] },
  { id: "loyalty-settings", page: "loyalty", param: ["tab", "settings"], label: "Settings", group: "Loyalty", need: ["loyalty", "view"] },
  { id: "blocked", page: "blocked", label: "Blocked customers", group: null, need: ["blocklist", "view"] },
  { id: "ordoro", page: "ordoro", label: "Ordoro reconciliation", group: null, need: ["reconciliation", "view"] },
  { id: "debug", page: "debug", label: "Debug", group: null, need: ["debug", "view"] },
  { id: "rate-test", page: "rate-test", label: "Label rate test", group: null, need: ["debug", "view"] },
];

export const VIEW_PAGES = [...new Set(VIEWS.map((v) => v.page))];
export const viewById = (id) => VIEWS.find((v) => v.id === id) ?? null;
export const viewTitle = (v) => (v.group && v.group !== v.label ? `${v.group} › ${v.label}` : v.label);

// Where a view opens: inside My Views, or on its own page
export function viewHref(v, { inMyViews = false } = {}) {
  const base = inMyViews ? `/app/my-views/${v.page}` : `/app/${v.page}`;
  return v.param ? `${base}?${v.param[0]}=${encodeURIComponent(v.param[1])}` : base;
}

// The view a URL shows (for the star): /app/<page> or /app/my-views/<page>, plus its tab
export function viewForLocation(pathname, search) {
  const m = String(pathname).match(/^\/app\/(?:my-views\/)?([a-z-]+)\/?$/);
  if (!m) return null;
  const page = m[1];
  const candidates = VIEWS.filter((v) => v.page === page);
  if (!candidates.length) return null;
  const params = new URLSearchParams(search ?? "");
  if (page === "purchase-orders" && params.get("po")) return null; // one PO, not a list
  const withParam = candidates.filter((v) => v.param);
  if (!withParam.length) return candidates[0];
  const [key] = withParam[0].param;
  const value = params.get(key);
  return withParam.find((v) => v.param[1] === value) ?? (value ? null : withParam.find((v) => v.isDefault) ?? null);
}
