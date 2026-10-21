import { redirect } from "react-router";
import db from "../../db.server";

// The app's front door. Shopify normally opens it with ?shop=…, which goes
// straight to the app. Without it (a bookmark, a reload that lost the
// address), go to the app for the store it's installed on instead of
// showing a login page.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  const sessions = await db.session.findMany({ select: { shop: true }, distinct: ["shop"], take: 2 });
  if (sessions.length === 1) {
    const shop = sessions[0].shop;
    const host = Buffer.from(`admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}`).toString("base64").replace(/=+$/, "");
    throw redirect(`/app?${new URLSearchParams({ shop, host, embedded: "1" })}`);
  }
  return null;
};

export default function Index() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "80vh", padding: "24px", textAlign: "center" }}>
      <div>
        <h1 style={{ margin: "0 0 8px", fontSize: "24px" }}>MonkeyBean</h1>
        <p style={{ margin: 0, color: "#616161" }}>Open MonkeyBean from Apps in your Shopify admin.</p>
      </div>
    </div>
  );
}
