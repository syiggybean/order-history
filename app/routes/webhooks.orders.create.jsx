import { authenticate } from "../shopify.server";
import { recordOrder } from "../preorder-notify.server";
import { orderChanged } from "../shipping.server";
import { recordWishlistOrder } from "../wishlist.server";
import { syncLoyaltyOrder } from "../loyalty.server";

// Shopify calls this for every new order. Used for pre-order countdowns:
// units sold per product, and orders that came from a notification email.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  // Shipping hub: pick up the new order's shipments
  orderChanged(shop, payload?.admin_graphql_api_id);
  try {
    await recordOrder(shop, payload);
    // Wishlists: customers buying what they saved
    await recordWishlistOrder(shop, payload);
    // Loyalty: points for members
    await syncLoyaltyOrder(shop, payload);
  } catch (e) {
    console.error("[preorder-notify] order:", e?.message ?? e);
    return new Response(null, { status: 500 }); // Shopify will retry
  }
  return new Response();
};
