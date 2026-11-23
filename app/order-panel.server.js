// Everything the order flyout shows, in one call: the order from Shopify,
// where each part is (Shipping's answer), who handled it, and its returns.
import { lookupOrderById, orderDetails } from "./shipping.server";
import { orderAudit } from "./order-audit.server";
import { listReturns, syncOrderReturns } from "./returns.server";

export async function orderPanel(shop, admin, orderId, { appOrigin = null, canVideo = false } = {}) {
  const [order, where, audit, returns] = await Promise.all([
    orderDetails(shop, admin, orderId),
    lookupOrderById(shop, admin, orderId).catch((e) => {
      console.error("[order-panel] where:", e?.message ?? e);
      return null;
    }),
    orderAudit(shop, { orderId }, { appOrigin, canVideo, admin }),
    // Read fresh from Shopify; if returns access isn't there, what's saved
    syncOrderReturns(shop, admin, orderId).catch(() => listReturns(shop, { orderId })),
  ]);
  if (!order) return null;
  return { order, where: where?.found ? where : null, audit, returns };
}
