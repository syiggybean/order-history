// Shows "Block customer" in More actions only to staff with Blocked customers access.
export default async () => {
  try {
    const res = await fetch("/api/blocklist?check=1");
    if (!res.ok) return { display: false };
    const data = await res.json();
    return { display: data.display === true };
  } catch {
    return { display: false };
  }
};
