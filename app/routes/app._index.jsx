import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { can, getStaff, publicUser } from "../permissions.server";
import { allows } from "../permissions";
import { getDailyState } from "../preorders.server";

export const loader = async ({ request }) => {
  const { session, user } = await getStaff(request);
  const seesPreorders = can(user, "preorders", "view");
  const seesReview = can(user, "releaseReview", "view");

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [daily, changesToday, toReview] = await Promise.all([
    seesPreorders ? getDailyState(session.shop) : null,
    seesPreorders ? db.preorderLog.count({ where: { shop: session.shop, createdAt: { gte: since } } }) : null,
    seesReview ? db.releaseSuggestion.count({ where: { shop: session.shop, status: "pending" } }) : null,
  ]);

  return {
    user: publicUser(user),
    daily: daily?.lastDailyAt
      ? { at: daily.lastDailyAt.toISOString(), summary: daily.lastDailySummary ?? "" }
      : null,
    changesToday,
    toReview,
  };
};

// Add new tools here as they're built
const TOOLS = [
  {
    title: "Pre-orders",
    feature: "preorders",
    description:
      "GT tags and shipping profiles, kept in sync with each product's release date. Runs every morning and whenever a product is edited.",
    href: "/app/preorders",
    action: "Open pre-orders",
    status: "live",
  },
  {
    title: "Pre-order countdowns",
    feature: "preorders",
    description:
      "Pick products and set when pre-orders open and close. The product page shows a flip-clock countdown, and buying is blocked outside the window.",
    href: "/app/preorder-countdowns",
    action: "Open countdowns",
    status: "live",
  },
  {
    title: "Release date review",
    feature: "releaseReview",
    description:
      "Checks Google Books for release date changes on pre-order items and lists them for your approval.",
    href: "/app/release-review",
    action: "Review dates",
    status: "live",
  },
  {
    title: "Inventory history",
    feature: "inventory",
    description:
      "Every stock change with who made it and why, recorded as it happens, with drill-down by app and staff.",
    href: "/app/inventory",
    action: "View history",
    status: "live",
  },
  {
    title: "Shipping",
    feature: "shipping",
    description:
      "Every open shipment, split the way Shopify splits them by shipping profile. Shows what's ready to ship (oldest orders get stock first) and what's still waiting, and why.",
    href: "/app/shipping",
    action: "Open shipping",
    status: "live",
  },
  {
    title: "Wishlists",
    feature: "wishlist",
    description:
      "What customers are saving most, with stock status, plus the back-in-stock and pre-order emails sent to wishlisters.",
    href: "/app/wishlist",
    action: "Open wishlists",
    status: "live",
  },
  {
    title: "Loyalty",
    feature: "loyalty",
    description:
      "Invite-only Yiggybeans: 5 per $1 spent plus bonuses, spent on discount codes that never expire. VIP tiers unlock exclusive sales. Runs alongside Smile.io while you test it.",
    href: "/app/loyalty",
    action: "Open loyalty",
    status: "live",
  },
  {
    title: "Customer notifications",
    feature: "releaseReview",
    description: "Emails customers about approved release date changes on items they've pre-ordered.",
    status: "soon",
  },
];

const STOREFRONT = [
  {
    title: "Previously ordered banner",
    description: "Shows on product pages when a logged-in customer has bought the item before, across their full order history.",
  },
  {
    title: "Pre-order countdown",
    description: "A flip-clock countdown on product pages until pre-orders open, then a Pre-Order button, and Pre-Orders Closed once they end.",
  },
  {
    title: "Customer pre-orders page",
    description: "Lists a customer's upcoming pre-orders, sortable by title, release date, or order.",
  },
  {
    title: "Wishlist",
    description: "A heart after product names and a wishlist icon in the header. Logged-in customers save products, share their list, and get back-in-stock emails.",
  },
];

const card = {
  border: "1px solid #e3e3e3",
  borderRadius: "12px",
  padding: "16px",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  background: "#fff",
};

const grid = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: "12px",
};

const badge = (live) => ({
  alignSelf: "flex-start",
  fontSize: "12px",
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: "999px",
  background: live ? "#e3f1df" : "#f1f1f1",
  color: live ? "#1a5e20" : "#616161",
});

export default function Index() {
  const { daily, changesToday, toReview, user } = useLoaderData();
  const tools = TOOLS.filter((t) => allows(user, t.feature));
  const seesPreorders = allows(user, "preorders");
  const seesReview = allows(user, "releaseReview");

  return (
    <s-page heading="MonkeyBean">
      {tools.length === 0 && !user?.isAdmin && (
        <s-section>
          <s-paragraph>
            You don't have access to any tools in this app yet. Ask an admin of this app to give you access on the
            Permissions page.
          </s-paragraph>
        </s-section>
      )}

      {(seesPreorders || seesReview) && (
        <s-section>
          {seesPreorders && (
            <>
              <s-paragraph>
                <strong>Last daily run:</strong>{" "}
                {daily ? `${new Date(daily.at).toLocaleString()} · ${daily.summary}` : "Not run yet"}
              </s-paragraph>
              <s-paragraph>
                <strong>Pre-order changes in the last 24 hours:</strong> {(changesToday ?? 0).toLocaleString()}
              </s-paragraph>
            </>
          )}
          {seesReview && (
            <s-paragraph>
              <strong>Release dates waiting for review:</strong> {(toReview ?? 0).toLocaleString()}
            </s-paragraph>
          )}
        </s-section>
      )}

      {(tools.length > 0 || user?.isAdmin) && (
      <s-section heading="Admin tools">
        <div style={grid}>
          {user?.isAdmin && (
            <div style={card}>
              <span style={badge(true)}>Admins</span>
              <strong style={{ fontSize: "15px" }}>Permissions</strong>
              <span style={{ color: "#4a4a4a", flexGrow: 1 }}>Choose who can see and use each tool in this app.</span>
              <div>
                <s-button variant="primary" href="/app/permissions">
                  Manage permissions
                </s-button>
              </div>
            </div>
          )}
          {tools.map((t) => (
            <div key={t.title} style={{ ...card, opacity: t.status === "live" ? 1 : 0.7 }}>
              <span style={badge(t.status === "live")}>{t.status === "live" ? "Active" : "Coming soon"}</span>
              <strong style={{ fontSize: "15px" }}>{t.title}</strong>
              <span style={{ color: "#4a4a4a", flexGrow: 1 }}>{t.description}</span>
              {t.href && (
                <div>
                  <s-button variant="primary" href={t.href}>
                    {t.action}
                  </s-button>
                </div>
              )}
            </div>
          ))}
        </div>
      </s-section>
      )}

      {tools.length > 0 && (
      <s-section heading="Storefront features">
        <s-paragraph>These run on your theme and are powered by this app. There's nothing to manage here.</s-paragraph>
        <div style={{ ...grid, marginTop: "8px" }}>
          {STOREFRONT.map((t) => (
            <div key={t.title} style={card}>
              <span style={badge(true)}>Active</span>
              <strong style={{ fontSize: "15px" }}>{t.title}</strong>
              <span style={{ color: "#4a4a4a" }}>{t.description}</span>
            </div>
          ))}
        </div>
      </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
