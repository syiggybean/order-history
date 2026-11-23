import { can, getStaff } from "../permissions.server";
import { orderAudit } from "../order-audit.server";
import { appUrl } from "../print.server";
import { ReshipError, createReship, reshipInfo } from "../reship.server";

// MonkeyBean on Shopify's order page (admin extensions):
//   GET ?check=reship                    should "Reship items" show in More actions?
//   GET ?orderId=…                       Who handled it (the MonkeyBean card)
//   GET ?orderId=…&reshipInfo=1          what can be reshipped
//   POST { intent: "reship", orderId, items, reason, note, notify, takeStock }

const ORDER = /^gid:\/\/shopify\/Order\/\d+$/;

export const loader = async ({ request }) => {
  const { session, user, admin, cors } = await getStaff(request);
  const respond = (data) => cors(Response.json(data));
  const url = new URL(request.url);
  const canReship = can(user, "shipping", "reship");
  if (url.searchParams.get("check") === "reship") return respond({ display: canReship });
  const orderId = url.searchParams.get("orderId") ?? "";
  if (!ORDER.test(orderId)) return respond({ error: "Which order?" });
  try {
    if (url.searchParams.get("reshipInfo")) {
      if (!canReship) return respond({ error: "You don't have permission to reship. Ask an admin to turn on \"Create reship orders\" under Shipping." });
      return respond({ info: await reshipInfo(session.shop, admin, orderId) });
    }
    if (!can(user, "shipping", "view") && !can(user, "tickets", "view")) return respond({ hidden: true });
    const canVideo = can(user, "packingVideos", "view");
    return respond({ audit: await orderAudit(session.shop, { orderId }, { appOrigin: appUrl(request), canVideo, admin }), canReship, canVideo });
  } catch (e) {
    if (e instanceof ReshipError) return respond({ error: e.message });
    console.error("[order-tools]", e);
    return respond({ error: "Something went wrong. Please try again." });
  }
};

export const action = async ({ request }) => {
  const { session, user, admin, cors } = await getStaff(request);
  const respond = (data, status = 200) => cors(Response.json(data, { status }));
  if (!can(user, "shipping", "reship")) return respond({ error: "You don't have permission to reship. Ask an admin to turn on \"Create reship orders\" under Shipping." }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Bad request." }, 400);
  }
  if (body?.intent !== "reship") return respond({ error: "Unknown request." }, 400);
  try {
    const made = await createReship(
      session.shop,
      admin,
      {
        orderId: String(body.orderId ?? ""),
        items: Array.isArray(body.items) ? body.items : [],
        reason: body.reason,
        note: body.note,
        notify: body.notify !== false,
        takeStock: body.takeStock === true ? true : body.takeStock === false ? false : null,
      },
      user,
    );
    return respond({ made });
  } catch (e) {
    if (e instanceof ReshipError) return respond({ error: e.message });
    console.error("[order-tools] reship", e);
    return respond({ error: "Something went wrong. Please try again." }, 500);
  }
};
