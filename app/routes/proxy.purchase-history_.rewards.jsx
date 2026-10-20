import { authenticate } from "../shopify.server";
import { customerKey, ensureCurrency, getProgram, memberView } from "../loyalty.server";
import { renderRewardsPage } from "../loyalty-page.server";
import { liquid } from "../wishlist-page.server";

// The customer's Rewards page: /apps/purchase-history/rewards (members only)
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return new Response("This store isn't connected.", { status: 400 });
  const shop = session.shop;
  const customerId = customerKey(new URL(request.url).searchParams.get("logged_in_customer_id"));
  if (!customerId) return liquid(renderRewardsPage({ mode: "login" }));
  const program = await getProgram(shop);
  if (!program.enabled) return liquid(renderRewardsPage({ mode: "closed" }));
  await ensureCurrency(shop, admin);
  const view = await memberView(shop, customerId);
  if (!view) return liquid(renderRewardsPage({ mode: "closed" }));
  return liquid(renderRewardsPage({ mode: "member", view }));
};
