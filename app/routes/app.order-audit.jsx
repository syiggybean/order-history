import { can, denied, getStaff } from "../permissions.server";
import { orderAudit } from "../order-audit.server";
import { appUrl } from "../print.server";
import { ReshipError, createReship, reshipInfo } from "../reship.server";

// Order flyouts on any page:
//   { orderId } or { orderName }      the order's MonkeyBean history (who picked,
//                                     packed and shipped, batch, scan overrides, videos)
//   { intent: "reshipInfo", orderId } what can be reshipped
//   { intent: "reship", orderId, items, reason, note, notify }  make the $0 reship order
export const action = async ({ request }) => {
  const { session, user, admin } = await getStaff(request);
  if (!can(user, "shipping", "view") && !can(user, "tickets", "view")) return { error: "You don't have access to order history.", denied: true };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "audit");
  const orderId = String(form.get("orderId") ?? "").trim();
  const canReship = can(user, "shipping", "reship");
  try {
    if (intent === "reshipInfo" || intent === "reship") {
      if (!canReship) return { intent, ...denied("shipping", "reship") };
      if (intent === "reshipInfo") return { intent, info: await reshipInfo(session.shop, admin, orderId) };
      let items = [];
      try {
        items = JSON.parse(String(form.get("items") ?? "[]"));
      } catch {
        return { intent, error: "Something was wrong with the form. Reload and try again." };
      }
      const made = await createReship(
        session.shop,
        admin,
        {
          orderId,
          items,
          reason: form.get("reason"),
          note: form.get("note"),
          notify: form.get("notify") === "1",
          takeStock: form.get("takeStock") === "1" ? true : form.get("takeStock") === "0" ? false : null,
        },
        user,
      );
      return { intent, ok: true, made };
    }
    const orderName = String(form.get("orderName") ?? "").trim();
    if (!/^gid:\/\/shopify\/Order\/\d+$/.test(orderId) && !/^#?[\w-]{1,40}$/.test(orderName)) return { intent, error: "Which order?" };
    const audit = await orderAudit(
      session.shop,
      orderId ? { orderId } : { orderName: orderName.startsWith("#") ? orderName : `#${orderName}` },
      { appOrigin: appUrl(request), canVideo: can(user, "packingVideos", "view") },
    );
    return { intent, audit, canVideo: can(user, "packingVideos", "view"), canReship };
  } catch (e) {
    if (e instanceof ReshipError) return { intent, error: e.message };
    console.error("[order-audit]", intent, e);
    return { intent, error: `Something went wrong: ${e?.message ?? e}` };
  }
};
