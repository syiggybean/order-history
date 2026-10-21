import { authenticate } from "../shopify.server";
import { productDeleted } from "../catalog.server";

// Shopify calls this when a product is deleted. Recorded for the inventory
// history before replying; if that fails, Shopify sends it again.
export const action = async ({ request }) => {
  const { shop, payload } = await authenticate.webhook(request);
  try {
    await productDeleted(shop, payload);
  } catch (e) {
    console.error("[catalog] product deleted:", e?.message ?? e);
    return new Response(null, { status: 500 });
  }
  return new Response();
};
