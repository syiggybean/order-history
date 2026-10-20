import { authenticate } from "../shopify.server";
import { errorMessage, syncProduct } from "../preorders.server";
import { recheckProduct } from "../preorder-windows.server";
import { productChanged } from "../shipping.server";
import { wishProductChanged } from "../wishlist.server";

// Shopify calls this when a product is created or edited.
// We answer right away and update the product in the background, because
// Shopify expects a reply within a few seconds.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  const productId = payload?.admin_graphql_api_id;

  if (productId) {
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
  }

  return new Response();
};
