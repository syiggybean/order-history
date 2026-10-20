import { authenticate } from "../shopify.server";
import { errorMessage } from "../preorders.server";
import {
  WishlistError,
  customerKey,
  listItems,
  setEmails,
  setSharing,
  setWished,
  sharedList,
} from "../wishlist.server";
import { liquid, renderWishlistPage } from "../wishlist-page.server";

// Wishlist requests from the storefront, through the app proxy:
//   GET  /apps/purchase-history/wishlist/items      the customer's saved products (for the hearts)
//   GET  /apps/purchase-history/wishlist/s/<token>  a shared wishlist (anyone with the link)
//   POST /apps/purchase-history/wishlist/toggle     { productId | handle, on }
//   POST /apps/purchase-history/wishlist/share      { on }
//   POST /apps/purchase-history/wishlist/emails     { on }
// The customer comes from logged_in_customer_id, which Shopify adds and signs.

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const loader = async ({ request, params }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false, error: "This store isn't connected." }, 400);
  const shop = session.shop;
  const url = new URL(request.url);
  const path = String(params["*"] ?? "").replace(/\/+$/, "");
  const customerId = customerKey(url.searchParams.get("logged_in_customer_id"));

  if (path === "items") {
    if (!customerId) return json({ ok: true, loggedIn: false, count: 0, items: [] });
    const items = await listItems(shop, customerId);
    return json({ ok: true, loggedIn: true, count: items.length, items: items.map((i) => ({ id: i.id, handle: i.handle })) });
  }

  const shared = path.match(/^s\/([A-Za-z0-9_-]+)$/);
  if (shared) {
    const list = await sharedList(shop, shared[1], { admin, countView: true });
    if (!list) return liquid(renderWishlistPage({ mode: "notfound" }));
    return liquid(renderWishlistPage({ mode: "shared", items: list.items, firstName: list.firstName, page: url.searchParams.get("page") }));
  }
  return new Response("Not found", { status: 404 });
};

export const action = async ({ request, params }) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ ok: false, error: "This store isn't connected." }, 400);
  // JSON only: a plain form on another site can't send this, so it can't
  // change someone's wishlist behind their back
  if (!/application\/json/i.test(request.headers.get("content-type") ?? "")) return json({ ok: false, error: "Bad request." }, 415);
  const shop = session.shop;
  const url = new URL(request.url);
  const customerId = customerKey(url.searchParams.get("logged_in_customer_id"));
  if (!customerId) return json({ ok: false, loggedIn: false, error: "Log in to use your wishlist." }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  const path = String(params["*"] ?? "").replace(/\/+$/, "");
  try {
    if (path === "toggle") {
      const r = await setWished(shop, admin, customerId, { productId: body.productId, handle: body.handle, on: body.on !== false });
      return json({ ok: true, on: r.on, id: r.id, count: r.count });
    }
    if (path === "share") return json({ ok: true, ...(await setSharing(shop, admin, customerId, body.on !== false)) });
    if (path === "emails") return json({ ok: true, ...(await setEmails(shop, admin, customerId, body.on !== false)) });
  } catch (e) {
    if (e instanceof WishlistError) return json({ ok: false, error: e.message }, 400);
    console.error(`[wishlist] ${path}:`, errorMessage(e));
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
  return json({ ok: false, error: "Not found." }, 404);
};
