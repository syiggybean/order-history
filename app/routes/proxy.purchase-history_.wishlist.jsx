import { authenticate } from "../shopify.server";
import { customerKey, ensureCustomer, getCustomer, listItems } from "../wishlist.server";
import { liquid, renderWishlistPage } from "../wishlist-page.server";

// The customer's wishlist page: /apps/purchase-history/wishlist
// Returned as Liquid so it's shown inside the store's theme.

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return new Response("This store isn't connected.", { status: 400 });
  const shop = session.shop;
  const url = new URL(request.url);
  const customerId = customerKey(url.searchParams.get("logged_in_customer_id"));
  if (!customerId) return liquid(renderWishlistPage({ mode: "login" }));

  const [items, customer] = await Promise.all([listItems(shop, customerId, { admin }), getCustomer(shop, customerId)]);
  // Keeps the email address current for wishlist emails
  if (admin) ensureCustomer(shop, admin, customerId).catch(() => {});
  return liquid(
    renderWishlistPage({
      mode: "own",
      items,
      page: url.searchParams.get("page"),
      emailsOn: customer?.emailsOn ?? true,
      shared: Boolean(customer?.shareToken),
    }),
  );
};
