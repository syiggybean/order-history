import { redirect } from "react-router";

// The test page was replaced by Inventory history. Old links (and Shopify
// admin remembering the last page) are sent there by the server, keeping
// Shopify's sign-in details in the address.
export const loader = ({ request }) => {
  const url = new URL(request.url);
  return redirect(`/app/inventory${url.search}`);
};

export default function InventoryTestMoved() {
  return null;
}
