import { Outlet, useFetcher, useLoaderData, useLocation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { getStaff, publicUser } from "../permissions.server";
import { allows } from "../permissions";
import { viewForLocation, viewTitle } from "../my-views";

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
        <s-link href="/app/my-views">My Views</s-link>
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
        {allows(user, "analytics") && <s-link href="/app/reporting">Reporting</s-link>}
        {allows(user, "shipping") && <s-link href="/app/shipping">Shipping</s-link>}
        {allows(user, "stock") && <s-link href="/app/stock">Stock</s-link>}
        {allows(user, "wishlist") && <s-link href="/app/wishlist">Wishlists</s-link>}
      </s-app-nav>
      <StarView user={user} />
      <Outlet />
    </AppProvider>
  );
}

// ☆ Add to My Views: on every page and tab that can be starred
function StarView({ user }) {
  const location = useLocation();
  const fetcher = useFetcher();
  const view = viewForLocation(location.pathname, location.search);
  if (!view || !user || !allows(user, view.need[0], view.need[1])) return null;
  // Show the change straight away, before the page data refreshes
  const pending = fetcher.formData?.get("id") === view.id;
  const saved = (user.views ?? []).includes(view.id);
  const starred = pending ? !saved : saved;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", padding: "8px 16px 0", marginBottom: "-6px", fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif', fontSize: "14px", color: "#303030", lineHeight: 1.4 }}>
      <button
        type="button"
        onClick={() => fetcher.submit({ intent: "toggle", id: view.id }, { method: "post", action: "/app/my-views" })}
        aria-pressed={starred}
        title={starred ? `Remove ${viewTitle(view)} from My Views` : `Add ${viewTitle(view)} to My Views`}
        style={{
          appearance: "none",
          border: `1px solid ${starred ? "#e3b400" : "#d0d0d0"}`,
          background: starred ? "#fff8db" : "#fff",
          borderRadius: "999px",
          padding: "3px 10px",
          font: "inherit",
          fontSize: "12px",
          color: "#303030",
          cursor: "pointer",
        }}
      >
        <span aria-hidden="true" style={{ color: starred ? "#c99700" : "#8a8a8a", marginRight: "4px" }}>
          {starred ? "★" : "☆"}
        </span>
        {starred ? "In My Views" : "Add to My Views"}
      </button>
    </div>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
