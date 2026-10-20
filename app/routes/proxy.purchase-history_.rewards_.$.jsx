import { authenticate } from "../shopify.server";
import { errorMessage } from "../preorders.server";
import {
  LoyaltyError,
  claimSocial,
  customerKey,
  ensureCurrency,
  getProgram,
  joinWithInvite,
  memberBadge,
  memberView,
  redeem,
  setBirthday,
} from "../loyalty.server";
import { renderRewardsPage } from "../loyalty-page.server";
import { liquid } from "../wishlist-page.server";

// Rewards requests from the storefront, through the app proxy:
//   GET  /apps/purchase-history/rewards/me            points for the header badge (members only)
//   GET  /apps/purchase-history/rewards/join/<token>  private join link
//   POST /apps/purchase-history/rewards/redeem        { rewardId }
//   POST /apps/purchase-history/rewards/birthday      { date: "MM-DD" }
//   POST /apps/purchase-history/rewards/social        { id }
// The customer comes from logged_in_customer_id, which Shopify adds and signs.

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const loader = async ({ request, params }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false }, 400);
  const shop = session.shop;
  const url = new URL(request.url);
  const path = String(params["*"] ?? "").replace(/\/+$/, "");
  const customerId = customerKey(url.searchParams.get("logged_in_customer_id"));

  if (path === "me") return json(customerId ? await memberBadge(shop, customerId) : { member: false });

  const join = path.match(/^join\/([A-Za-z0-9_-]{6,40})$/);
  if (join) {
    const here = `/apps/purchase-history/rewards/join/${join[1]}`;
    if (!customerId) return liquid(renderRewardsPage({ mode: "login", path: here }));
    const program = await getProgram(shop);
    if (!program.enabled) return liquid(renderRewardsPage({ mode: "closed" }));
    try {
      const r = await joinWithInvite(shop, admin, join[1], customerId);
      if (!r.ok) return liquid(renderRewardsPage({ mode: "closed", joinError: r.reason }));
      await ensureCurrency(shop, admin);
      return liquid(renderRewardsPage({ mode: "member", view: await memberView(shop, customerId), joined: !r.already }));
    } catch (e) {
      console.error("[loyalty] join:", errorMessage(e));
      return liquid(renderRewardsPage({ mode: "closed", joinError: "invalid" }));
    }
  }
  return new Response("Not found", { status: 404 });
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false, error: "This store isn't connected." }, 400);
  if (!/application\/json/i.test(request.headers.get("content-type") ?? "")) return json({ ok: false, error: "Bad request." }, 415);
  const shop = session.shop;
  const customerId = customerKey(new URL(request.url).searchParams.get("logged_in_customer_id"));
  if (!customerId) return json({ ok: false, error: "Log in first." }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  const path = String(params["*"] ?? "").replace(/\/+$/, "");
  try {
    if (path === "redeem") return json({ ok: true, ...(await redeem(shop, admin, customerId, body.rewardId)) });
    if (path === "birthday") {
      await setBirthday(shop, customerId, body.date);
      return json({ ok: true });
    }
    if (path === "social") return json({ ok: true, ...(await claimSocial(shop, customerId, body.id)) });
  } catch (e) {
    if (e instanceof LoyaltyError) return json({ ok: false, error: e.message }, 400);
    console.error(`[loyalty] ${path}:`, errorMessage(e));
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
  return json({ ok: false, error: "Not found." }, 404);
};
