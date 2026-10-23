import { authenticate } from "../shopify.server";
import { errorMessage, syncProduct } from "../preorders.server";
import { recheckProduct } from "../preorder-windows.server";
import { productChanged } from "../shipping.server";
import { wishProductChanged } from "../wishlist.server";
import { productNotified } from "../catalog.server";
import { pullProductBins } from "../bins-sync.server";

// Shopify calls this when a product is created or edited.
// We answer right away and update the product in the background, because
// Shopify expects a reply within a few seconds.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const productId = payload?.admin_graphql_api_id;

  if (productId) {
    // Inventory history: product created, variants added or removed.
    // Recorded before replying, so a failure makes Shopify send it again.
    try {
      await productNotified(shop, topic, payload);
    } catch (e) {
      console.error(`[catalog] product ${productId}:`, errorMessage(e));
      return new Response(null, { status: 500 });
    }
    syncProduct(shop, productId).catch((e) =>
      console.error(`[preorders] product edit ${productId}:`, errorMessage(e)),
    );
    // Products in the countdown group: keep "Continue selling" matching the window
    recheckProduct(shop, productId).catch((e) =>
      console.error(`[preorder-windows] product edit ${productId}:`, errorMessage(e)),
    );
    // Shipping hub: tags or release date may have changed what's ready
    productChanged(shop, productId).catch((e) =>
      console.error(`[shipping] product edit ${productId}:`, errorMessage(e)),
    );
    // Wishlists: keep the product's details current, and spot "back in stock"
    wishProductChanged(shop, productId).catch((e) =>
      console.error(`[wishlist] product edit ${productId}:`, errorMessage(e)),
    );
    // Bin location edited on a variant in Shopify admin: update Shipping → Bins
    if (topic !== "PRODUCTS_CREATE" && topic !== "products/create")
      pullProductBins(shop, productId).catch((e) => console.error(`[bins] product edit ${productId}:`, errorMessage(e)));
  }

  return new Response();
};
