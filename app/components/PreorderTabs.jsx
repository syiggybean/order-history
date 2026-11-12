import { Link, useLocation } from "react-router";

// The two halves of Pre-orders: release dates and shipping (GT tags, profiles,
// templates) and countdowns. Hidden inside My Views, which has its own tabs.
const TABS = [
  { href: "/app/preorders", label: "Release dates and shipping" },
  { href: "/app/preorder-countdowns", label: "Countdowns" },
];

export function PreorderTabs() {
  const { pathname, search } = useLocation();
  if (pathname.startsWith("/app/my-views")) return null;
  // Keep the embedded app's query (host, shop) on the links
  const keep = new URLSearchParams(search);
  keep.delete("tab");
  const qs = keep.toString();
  return (
    <nav
      aria-label="Pre-orders"
      style={{ display: "flex", gap: "6px", marginBottom: "16px", padding: "4px", background: "#f1f1f1", borderRadius: "10px", width: "fit-content", flexWrap: "wrap" }}
    >
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            to={`${t.href}${qs ? `?${qs}` : ""}`}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "6px 14px",
              borderRadius: "8px",
              textDecoration: "none",
              fontWeight: 600,
              fontSize: "13px",
              color: active ? "#1a1a1a" : "#616161",
              background: active ? "#fff" : "transparent",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,.12)" : "none",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
