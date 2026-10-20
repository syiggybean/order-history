import { can, denied, getStaff } from "../permissions.server";
import { SINCE_OPTIONS, listChanges, whoForProduct } from "../inventory-history.server";
import { UndoError, previewUndo, undoChange } from "../inventory-undo.server";

// Data for the Inventory history card on product pages in Shopify admin.
// Shopify sends the signed-in staff member's identity with each request,
// so the same permission levels apply here as in the app.
//
//   GET ?productId=gid://shopify/Product/1&page=1&whoApp=&whoStaff=
//       &range=30d | range=custom&from=2026-01-01&to=2026-02-01   (store-time days)
//       &all=1                                 (everything in range, up to SHOW_ALL_LIMIT)
//   GET ?order=1234567890                      (order quick view)
//   GET ?check=1                               (should the menu item show?)
//   POST { intent: "preview" | "undo", key }   (undo a change; needs undo access)

const PAGE_SIZE = 10;
const SHOW_ALL_LIMIT = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const rangeOptions = Object.entries(SINCE_OPTIONS).map(([value, o]) => ({ value, label: o.label }));

export const loader = async ({ request }) => {
  const { session, admin, user, cors } = await getStaff(request);
  const respond = (data) => cors(Response.json(data));

  const url = new URL(request.url);

  // Show/hide check for the More actions menu item
  if (url.searchParams.has("check")) return respond({ display: can(user, "inventory", "view") });

  if (!can(user, "inventory", "view")) return respond({ hidden: true });
  const access = { undo: can(user, "inventory", "undo") };

  const shop = session.shop;

  // Order quick view
  const orderId = url.searchParams.get("order");
  if (orderId) return respond({ access, order: await orderDetails(admin, orderId) });

  const productId = url.searchParams.get("productId");
  if (!productId?.startsWith("gid://shopify/Product/")) return respond({ access, error: "Missing product." });

  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const hasWho = url.searchParams.has("whoApp") || url.searchParams.has("whoStaff");
  const who = hasWho
    ? { app: url.searchParams.get("whoApp") || null, staff: url.searchParams.get("whoStaff") || null }
    : null;

  const range = url.searchParams.get("range") ?? "all";
  const time = {};
  if (range === "custom") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (DAY.test(from ?? "")) time.from = from;
    if (DAY.test(to ?? "")) time.to = to;
    if (time.from && time.to && time.from > time.to) return respond({ access, error: "The start date is after the end date." });
  } else if (SINCE_OPTIONS[range]?.days) {
    time.since = range;
  }

  const all = url.searchParams.get("all") === "1";
  const paging = all ? { page: 1, pageSize: SHOW_ALL_LIMIT } : { page, pageSize: PAGE_SIZE };

  const [result, whoOptions] = await Promise.all([
    listChanges(shop, { productId, who, ...time }, paging),
    paging.page === 1 ? whoForProduct(shop, productId) : null,
  ]);

  return respond({
    access,
    page: paging.page,
    ...result,
    // Show all hit the limit: tell the person rather than offering more pages
    truncated: all && result.hasMore ? SHOW_ALL_LIMIT : null,
    hasMore: all ? false : result.hasMore,
    whoOptions,
    rangeOptions,
  });
};

export const action = async ({ request }) => {
  const { session, admin, user, cors } = await getStaff(request);
  const respond = (data, status = 200) => cors(Response.json(data, { status }));

  if (!can(user, "inventory", "undo")) return respond(denied("inventory", "undo"), 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Bad request." }, 400);
  }
  const key = String(body?.key ?? "");
  try {
    if (body?.intent === "preview") return respond({ preview: await previewUndo(session.shop, admin, key) });
    if (body?.intent === "undo") return respond({ undone: await undoChange(session.shop, admin, user, key) });
  } catch (e) {
    if (e instanceof UndoError) return respond({ error: e.message });
    console.error("Undo failed:", e);
    return respond({ error: "Something went wrong. Please try again." }, 500);
  }
  return respond({ error: "Unknown request." }, 400);
};

async function orderDetails(admin, orderId) {
  const id = `gid://shopify/Order/${String(orderId).replace(/\D/g, "")}`;
  const res = await admin.graphql(
    `#graphql
    query ($id: ID!) {
      order(id: $id) {
        legacyResourceId
        name
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 25) { nodes { title variantTitle quantity sku } }
      }
    }`,
    { variables: { id } },
  );
  const o = (await res.json()).data?.order;
  if (!o) return null;

  // Customer name needs extra customer-data permission; skip it if unavailable
  let customer = null;
  try {
    const r = await admin.graphql(`#graphql
      query ($id: ID!) { order(id: $id) { customer { displayName } } }`, { variables: { id } });
    customer = (await r.json()).data?.order?.customer?.displayName ?? null;
  } catch {
    customer = null;
  }

  const pretty = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : null);
  return {
    id: o.legacyResourceId,
    name: o.name,
    createdAt: o.createdAt,
    cancelled: Boolean(o.cancelledAt),
    payment: pretty(o.displayFinancialStatus),
    fulfillment: pretty(o.displayFulfillmentStatus),
    total: o.totalPriceSet?.shopMoney
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: o.totalPriceSet.shopMoney.currencyCode }).format(
          Number(o.totalPriceSet.shopMoney.amount),
        )
      : null,
    customer,
    items: o.lineItems.nodes.map((li) => ({
      title: li.title,
      variant: li.variantTitle && li.variantTitle !== "Default Title" ? li.variantTitle : null,
      quantity: li.quantity,
      sku: li.sku,
    })),
  };
}
