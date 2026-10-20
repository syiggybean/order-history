// Decides whether "Inventory history" appears in the product page's
// More actions menu. Asks the app whether the signed-in staff member has
// access; if the app can't be reached, the item stays hidden.
export default async () => {
  try {
    const res = await fetch("/api/inventory-history?check=1");
    if (!res.ok) return { display: false };
    const data = await res.json();
    return { display: data.display === true };
  } catch {
    return { display: false };
  }
};
