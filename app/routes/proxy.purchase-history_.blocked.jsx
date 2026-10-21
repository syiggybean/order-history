import { authenticate } from "../shopify.server";
import { liquid } from "../wishlist-page.server";

// Where blocked customers land if they try the cart or checkout:
// /apps/purchase-history/blocked. The red banner from the "Blocked customers"
// app embed is on this page too. Anyone not blocked just gets a way back.
export const loader = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("This store isn't connected.", { status: 400 });
  return liquid(`{%- assign ohbl_email = 'help@yiggybean.com' -%}
<div style="max-width:560px;margin:56px auto 80px;padding:0 20px;text-align:center">
{%- if customer and customer.tags contains 'Blocked from shopping' -%}
  <h1 style="margin:0 0 12px">You can't shop with this account</h1>
  <p>Your account has been blocked from shopping, so the cart and checkout aren't available.</p>
  <p>If you believe you're seeing this in error, contact <a id="ohbl-mail" href="mailto:{{ ohbl_email }}">{{ ohbl_email }}</a>.</p>
  <script>(function(){var b=document.querySelector('#ohbl-banner a[href^="mailto:"]'),m=document.getElementById('ohbl-mail');if(b&&m){m.href=b.href;m.textContent=b.textContent}})();</script>
{%- else -%}
  <h1 style="margin:0 0 12px">Nothing to see here</h1>
  <p><a href="{{ routes.root_url }}">Back to the shop</a></p>
{%- endif -%}
</div>`);
};
