import { authenticate } from "../shopify.server";
import { recordInventoryChange } from "../inventory.server";
import { requestLiveSync } from "../inventory-sync.server";
import { stockChanged } from "../preorder-windows.server";
import { stockMoved } from "../shipping.server";
import { wishStockMoved } from "../wishlist.server";

// Shopify calls this the moment an inventory level changes.
// The change is written to the log before replying, so it's never lost;
// if writing fails, Shopify sees an error and sends the notification again.
// Then the history sync is asked to fetch who made the change and why.
export const action = async ({ request }) => {
  const { shop, payload, webhookId } = await authenticate.webhook(request);

  try {
    await recordInventoryChange(shop, webhookId, payload);
  } catch (e) {
    console.error("[inventory] failed to record change:", e?.message ?? e);
    return new Response(null, { status: 500 });
  }

  requestLiveSync(shop).catch((e) => console.error("[inventory-sync] request failed:", e?.message ?? e));
  // Pre-order countdowns with a sales limit: sold out / restocked
  stockChanged(shop, payload).catch((e) => console.error("[preorder-windows] stock change:", e?.message ?? e));
  // Shipping hub: stock arriving can make waiting shipments ready
  stockMoved(shop);
  // Wishlists: back-in-stock emails
  wishStockMoved(shop, payload?.inventory_item_id);
  return new Response();
};
