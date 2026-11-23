import { can, denied, getStaff } from "../permissions.server";
import { orderAudit } from "../order-audit.server";
import { orderPanel } from "../order-panel.server";
import { appUrl } from "../print.server";
import { ReshipError, createReship, reshipInfo } from "../reship.server";
import { ReturnsError, markHandled, approveReturn, declineReturn, listReturns, returnableItems, startReturn, syncNow, verifyReturn } from "../returns.server";

// The order flyout on any page, and returns:
//   { intent: "panel", orderId }                  everything the order flyout shows
//   { orderId } or { orderName }                  the order's MonkeyBean history only
//   { intent: "reshipInfo" | "reship", … }        Reship (needs "Create reship orders")
//   { intent: "returnable" | "startReturn" | "approveReturn" | "declineReturn" | "verifyReturn" | "syncReturns", … }
//                                                 Returns (needs "Process returns")
const ORDER = /^gid:\/\/shopify\/Order\/\d+$/;
const RETURN_INTENTS = ["returnable", "startReturn", "approveReturn", "declineReturn", "verifyReturn", "syncReturns", "handleReturns"];

const parse = (v, fallback) => {
  try {
    return JSON.parse(String(v ?? ""));
  } catch {
    return fallback;
  }
};

export const action = async ({ request }) => {
  const { session, user, admin } = await getStaff(request);
  if (!can(user, "shipping", "view") && !can(user, "tickets", "view")) return { error: "You don't have access to order history.", denied: true };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "audit");
  const orderId = String(form.get("orderId") ?? "").trim();
  const shop = session.shop;
  const canVideo = can(user, "packingVideos", "view");
  const canReship = can(user, "shipping", "reship");
  const canReturns = can(user, "shipping", "returns");
  try {
    if (intent === "panel") {
      if (!ORDER.test(orderId)) return { intent, error: "Which order?" };
      const panel = await orderPanel(shop, admin, orderId, { appOrigin: appUrl(request), canVideo });
      if (!panel) return { intent, error: "That order isn't in Shopify." };
      return { intent, ...panel, can: { reship: canReship, returns: canReturns, video: canVideo } };
    }

    if (intent === "reshipInfo" || intent === "reship") {
      if (!canReship) return { intent, ...denied("shipping", "reship") };
      if (intent === "reshipInfo") return { intent, info: await reshipInfo(shop, admin, orderId) };
      const made = await createReship(
        shop,
        admin,
        {
          orderId,
          items: parse(form.get("items"), []),
          reason: form.get("reason"),
          note: form.get("note"),
          notify: form.get("notify") === "1",
          takeStock: form.get("takeStock") === "1" ? true : form.get("takeStock") === "0" ? false : null,
        },
        user,
      );
      return { intent, ok: true, made };
    }

    if (RETURN_INTENTS.includes(intent)) {
      if (!canReturns) return { intent, ...denied("shipping", "returns") };
      const id = form.get("returnId");
      if (intent === "returnable") return { intent, info: await returnableItems(shop, admin, orderId) };
      if (intent === "startReturn")
        return {
          intent,
          ok: true,
          made: await startReturn(shop, admin, { orderId, items: parse(form.get("items"), []), reason: form.get("reason"), note: form.get("note"), notifyCustomer: form.get("notify") === "1" }, user),
        };
      if (intent === "approveReturn") return { intent, ok: true, ret: await approveReturn(shop, admin, id, user, { notifyCustomer: form.get("notify") !== "0" }) };
      if (intent === "declineReturn")
        return { intent, ok: true, ret: await declineReturn(shop, admin, id, user, { reason: form.get("reason"), note: form.get("note"), notifyCustomer: form.get("notify") !== "0" }) };
      if (intent === "verifyReturn") return { intent, ok: true, ret: await verifyReturn(shop, admin, id, { found: parse(form.get("found"), []), note: form.get("note") }, user) };
      if (intent === "handleReturns")
        return { intent, ok: true, ...(await markHandled(shop, admin, parse(form.get("ids"), []), { note: form.get("note"), close: form.get("close") === "1" }, user)) };
      if (intent === "syncReturns") {
        await syncNow(shop, admin);
        return { intent, ok: true, returns: await listReturns(shop, {}) };
      }
    }

    // The history only (older callers)
    const orderName = String(form.get("orderName") ?? "").trim();
    if (!ORDER.test(orderId) && !/^#?[\w-]{1,40}$/.test(orderName)) return { intent, error: "Which order?" };
    const audit = await orderAudit(shop, orderId ? { orderId } : { orderName: orderName.startsWith("#") ? orderName : `#${orderName}` }, { appOrigin: appUrl(request), canVideo, admin });
    return { intent, audit, canVideo, canReship };
  } catch (e) {
    if (e instanceof ReshipError || e instanceof ReturnsError) return { intent, error: e.message };
    console.error("[order-audit]", intent, e);
    return { intent, error: `Something went wrong: ${e?.message ?? e}` };
  }
};
