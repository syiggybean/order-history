import { can, getStaff } from "../permissions.server";
import { orderAudit } from "../order-audit.server";
import { appUrl } from "../print.server";

// An order's MonkeyBean history (who picked, packed and shipped, batch, scan
// overrides, packing videos, every logged event), for the order flyouts on any
// page. POST { orderId } or { orderName }.
export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  if (!can(user, "shipping", "view") && !can(user, "tickets", "view")) return { error: "You don't have access to order history.", denied: true };
  const form = await request.formData();
  const orderId = String(form.get("orderId") ?? "").trim();
  const orderName = String(form.get("orderName") ?? "").trim();
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId) && !/^#?[\w-]{1,40}$/.test(orderName)) return { error: "Which order?" };
  try {
    const audit = await orderAudit(
      session.shop,
      orderId ? { orderId } : { orderName: orderName.startsWith("#") ? orderName : `#${orderName}` },
      { appOrigin: appUrl(request), canVideo: can(user, "packingVideos", "view") },
    );
    return { audit, canVideo: can(user, "packingVideos", "view") };
  } catch (e) {
    console.error("[order-audit]", e);
    return { error: `Couldn't load the history: ${e?.message ?? e}` };
  }
};
