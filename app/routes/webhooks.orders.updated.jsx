import { recordLimitSales } from "../preorder-windows.server";
import { authenticate } from "../shopify.server";
import { orderChanged } from "../shipping.server";
import { syncLoyaltyOrder } from "../loyalty.server";

// Shopify calls this when an order changes: edited, paid, fulfilled, cancelled.
// The shipping hub re-reads that order's shipments a few seconds later.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  orderChanged(shop, payload?.admin_graphql_api_id);
  // Pre-order sales limits: a cancelled order or removed item frees its units
  try {
    await recordLimitSales(shop, payload);
  } catch (e) {
    console.error("[preorder-windows] order update:", e?.message ?? e);
    return new Response(null, { status: 500 }); // Shopify will retry
  }
  // Loyalty: shipped (points become available), refunded, edited or cancelled
  try {
    await syncLoyaltyOrder(shop, payload);
  } catch (e) {
    console.error("[loyalty] order update:", e?.message ?? e);
    return new Response(null, { status: 500 }); // Shopify will retry
  }
  return new Response();
};
