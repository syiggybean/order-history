// Shows "Reship items" in the order page's More actions menu only to staff
// with the "Create reship orders" permission. Hidden if the app can't be reached.
export default async () => {
  try {
    const res = await fetch("/api/order-tools?check=reship");
    if (!res.ok) return { display: false };
    const data = await res.json();
    return { display: data.display === true };
  } catch {
    return { display: false };
  }
};
