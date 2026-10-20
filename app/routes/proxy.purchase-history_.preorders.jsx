import { authenticate } from "../shopify.server";

const TIME_ZONE = "America/Los_Angeles";

// Optional: still shown on the card if a product has one of these tags
const WINDOWS = [
  ["GT30Days", "Over 30 Days"],
  ["GT60Days", "Over 60 Days"],
  ["GT90Days", "Over 90 Days"],
  ["GT120Days", "Over 120 Days"],
  ["GT180Days", "Over 180 Days"],
];

const QUERY = `#graphql
  query ($customerId: ID!, $after: String) {
    customer(id: $customerId) {
      orders(first: 25, after: $after, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          name
          processedAt
          statusPageUrl
          lineItems(first: 50) {
            nodes {
              title
              quantity
              unfulfilledQuantity
              image { url(transform: { maxWidth: 240 }) }
              product {
                tags
                publicationDate: metafield(namespace: "app-ibp-book", key: "publication_date") { value }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// Turns a metafield value into "YYYY-MM-DD", or null if it isn't a date
function toDay(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  return isNaN(d) ? null : dayFormatter.format(d);
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");

  if (!admin || !customerId) {
    return Response.json({ items: [] });
  }

  const today = dayFormatter.format(new Date());
  const items = [];
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
        for (const li of order.lineItems.nodes) {
          const publicationDate = toDay(li.product?.publicationDate?.value);
          if (!publicationDate || publicationDate <= today) continue;

          const tags = li.product?.tags ?? [];
          const windowMatch = WINDOWS.find(([tag]) => tags.includes(tag));

          items.push({
            title: li.title,
            image: li.image?.url ?? null,
            orderName: order.name,
            orderUrl: order.statusPageUrl,
            date: order.processedAt,
            quantity: li.quantity,
            publicationDate,
            window: windowMatch ? windowMatch[1] : null,
            status: li.unfulfilledQuantity === 0 ? "Shipped" : "Awaiting Production / Shipment",
          });
        }
      }
      after = orders.pageInfo.hasNextPage ? orders.pageInfo.endCursor : null;
    } while (after);
  } catch (e) {
    console.error("[preorders] query failed:", JSON.stringify(e?.body?.errors ?? e?.message ?? e));
    return Response.json({ items: [], error: true }, { status: 500 });
  }

  items.sort((a, b) => a.title.localeCompare(b.title));
  return Response.json({ items });
};