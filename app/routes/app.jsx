import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { getStaff, publicUser } from "../permissions.server";
import { allows } from "../permissions";

export const loader = async ({ request }) => {
  const { user } = await getStaff(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", user: publicUser(user) };
};

export default function App() {
  const { apiKey, user } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        {/* Home first, then the rest A–Z */}
        <s-link href="/app">Home</s-link>
        {allows(user, "analytics") && <s-link href="/app/analytics">Analytics</s-link>}
        {allows(user, "blocklist") && <s-link href="/app/blocked">Blocked customers</s-link>}
        {allows(user, "debug") && <s-link href="/app/debug">Debug</s-link>}
        {allows(user, "inventory") && <s-link href="/app/inventory">Inventory history</s-link>}
        {allows(user, "debug") && <s-link href="/app/rate-test">Label rate test</s-link>}
        {allows(user, "loyalty") && <s-link href="/app/loyalty">Loyalty</s-link>}
        {allows(user, "reconciliation") && <s-link href="/app/ordoro">Ordoro reconciliation</s-link>}
        {user?.isAdmin && <s-link href="/app/permissions">Permissions</s-link>}
        {allows(user, "preorders") && <s-link href="/app/preorder-countdowns">Pre-order countdowns</s-link>}
        {allows(user, "preorders") && <s-link href="/app/preorders">Pre-orders</s-link>}
        {allows(user, "purchaseOrders") && <s-link href="/app/purchase-orders">Purchase orders</s-link>}
        {allows(user, "receiving") && <s-link href="/app/receiving">Receiving</s-link>}
        {allows(user, "releaseReview") && <s-link href="/app/release-review">Release date review</s-link>}
        {allows(user, "shipping") && <s-link href="/app/shipping">Shipping</s-link>}
        {allows(user, "wishlist") && <s-link href="/app/wishlist">Wishlists</s-link>}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
