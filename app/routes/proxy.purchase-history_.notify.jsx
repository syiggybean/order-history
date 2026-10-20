import { authenticate } from "../shopify.server";
import { NotifyError, subscribe } from "../preorder-notify.server";

// Storefront sign-up form ("Email me when pre-orders open").
// Reached through the app proxy: POST /apps/purchase-history/notify
export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ ok: false, error: "This store isn't connected." }, { status: 400 });

  const url = new URL(request.url);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 400 });
  }
  // Bots fill in every field, people don't see this one
  if (body.website) return Response.json({ ok: true });

  const productId = /^\d+$/.test(String(body.productId ?? "")) ? `gid://shopify/Product/${body.productId}` : null;
  if (!productId) return Response.json({ ok: false, error: "Missing product." }, { status: 400 });

  try {
    const r = await subscribe(session.shop, {
      productId,
      email: body.email,
      customerId: url.searchParams.get("logged_in_customer_id") || null,
    });
    return Response.json({ ok: true, already: r.already });
  } catch (e) {
    if (e instanceof NotifyError) return Response.json({ ok: false, error: e.message }, { status: 400 });
    console.error("[preorder-notify] sign-up:", e?.message ?? e);
    return Response.json({ ok: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
};

export const loader = () => new Response("Not found", { status: 404 });
