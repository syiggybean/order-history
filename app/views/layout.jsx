import { Link, Outlet, useFetcher, useLoaderData, useLocation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getStaff, saveViews } from "../permissions.server";
import { allows } from "../permissions";
import { viewById, viewForLocation, viewHref, viewTitle } from "../my-views";

// My Views: the pages and tabs this person starred, as tabs. Each tab shows the
// real page (its own route, mounted under /app/my-views/<page>).

const visibleViews = (user) =>
  (user?.views ?? [])
    .map(viewById)
    .filter(Boolean)
    .filter((v) => allows(user, v.need[0], v.need[1]));

export const loader = async ({ request }) => {
  const { user } = await getStaff(request);
  return { views: visibleViews(user).map((v) => ({ id: v.id, title: viewTitle(v), href: viewHref(v, { inMyViews: true }) })) };
};

// Star / unstar / reorder. Anyone can manage their own list; only views they can open are kept.
export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  if (!user) return { error: "Not signed in." };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  const v = viewById(id);
  if (!v) return { intent, error: "Unknown view." };
  let list = [...(user.views ?? [])].filter((x) => viewById(x));
  if (intent === "toggle") {
    if (list.includes(id)) list = list.filter((x) => x !== id);
    else {
      if (!allows(user, v.need[0], v.need[1])) return { intent, error: "You don't have access to that." };
      list.push(id);
    }
  } else if (intent === "remove") {
    list = list.filter((x) => x !== id);
  } else if (intent === "move") {
    const i = list.indexOf(id);
    const j = i + (form.get("dir") === "left" ? -1 : 1);
    if (i >= 0 && j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
  } else {
    return { intent, error: "Unknown action." };
  }
  const views = await saveViews(session.shop, user, list);
  return { intent, ok: true, views, starred: views.includes(id) };
};

const tabStyle = (active) => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "8px 12px",
  borderBottom: `3px solid ${active ? "#303030" : "transparent"}`,
  color: active ? "#1a1a1a" : "#4a4a4a",
  fontWeight: active ? 700 : 500,
  textDecoration: "none",
  whiteSpace: "nowrap",
});
const iconBtn = { appearance: "none", border: 0, background: "none", padding: "0 2px", font: "inherit", color: "#8a8a8a", cursor: "pointer", lineHeight: 1 };

export default function MyViewsLayout() {
  const { views } = useLoaderData();
  const location = useLocation();
  const fetcher = useFetcher();
  const current = viewForLocation(location.pathname, location.search);
  const send = (intent, id, extra = {}) => fetcher.submit({ intent, id, ...extra }, { method: "post", action: "/app/my-views" });
  return (
    <div>
      {/* Outside Shopify's page components, so set the admin's font here (otherwise the browser default serif shows) */}
      <div style={{ padding: "12px 16px 0", fontFamily: '-apple-system, BlinkMacSystemFont, "San Francisco", "Segoe UI", Roboto, "Helvetica Neue", sans-serif', fontSize: "14px", color: "#303030", lineHeight: 1.4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "6px" }}>
          <strong style={{ fontSize: "18px" }}>My Views</strong>
          <span style={{ color: "#616161", fontSize: "12px" }}>Star any page or tab (☆ at the top right) to add it here.</span>
        </div>
        {views.length > 0 && (
          <nav aria-label="My Views" style={{ display: "flex", gap: "2px", borderBottom: "1px solid #e3e3e3", overflowX: "auto" }}>
            {views.map((v, i) => {
              const active = current?.id === v.id;
              return (
                <span key={v.id} style={{ display: "inline-flex", alignItems: "center" }}>
                  <Link to={v.href} style={tabStyle(active)} aria-current={active ? "page" : undefined}>
                    {v.title}
                  </Link>
                  {active && (
                    <span style={{ display: "inline-flex", gap: "2px", marginLeft: "-4px", marginRight: "6px" }}>
                      {i > 0 && (
                        <button type="button" style={iconBtn} onClick={() => send("move", v.id, { dir: "left" })} aria-label={`Move ${v.title} left`} title="Move left">
                          ‹
                        </button>
                      )}
                      {i < views.length - 1 && (
                        <button type="button" style={iconBtn} onClick={() => send("move", v.id, { dir: "right" })} aria-label={`Move ${v.title} right`} title="Move right">
                          ›
                        </button>
                      )}
                      <button type="button" style={iconBtn} onClick={() => send("remove", v.id)} aria-label={`Remove ${v.title} from My Views`} title="Remove from My Views">
                        ×
                      </button>
                    </span>
                  )}
                </span>
              );
            })}
          </nav>
        )}
      </div>
      <Outlet />
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
