import { authenticate } from "../shopify.server";

const QUERY = `#graphql
  query ($customerId: ID!, $after: String) {
    customer(id: $customerId) {
      orders(first: 50, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          name
          processedAt
          statusPageUrl
          lineItems(first: 100) { nodes { quantity product { id } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const productId = url.searchParams.get("product_id");

  if (!admin || !customerId || !productId) {
    return Response.json({ purchased: false });
  }

  const productGid = `gid://shopify/Product/${productId}`;
  let count = 0;
  let last = null;
  let after = null;

  try {
    do {
      const res = await admin.graphql(QUERY, {
        variables: { customerId: `gid://shopify/Customer/${customerId}`, after },
      });
      const { data } = await res.json();
      const orders = data?.customer?.orders;
      if (!orders) break;

      for (const order of orders.nodes) {
        const qty = order.lineItems.nodes
          .filter((li) => li.product?.id === productGid)
          .reduce((sum, li) => sum + li.quantity, 0);

        if (qty > 0) {
          count++;
          if (!last) {
            last = {
              date: order.processedAt,
              orderNumber: order.name.replace("#", ""),
              orderUrl: order.statusPageUrl,
              quantity: qty,
            };
          }
        }
      }
      after = orders.pageInfo.hasNextPage ? orders.pageInfo.endCursor : null;
    } while (after);
  } catch (e) {
    console.error("[purchase-history] query failed:", JSON.stringify(e?.body?.errors ?? e?.message ?? e));
    return Response.json({ purchased: false, error: true });
  }

  if (!last) return Response.json({ purchased: false });
  return Response.json({ purchased: true, count, ...last });
};