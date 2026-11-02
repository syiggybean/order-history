import { redirect, useLoaderData } from "react-router";
import { getStaff } from "../permissions.server";
import { allows } from "../permissions";
import { VIEWS, viewById, viewHref, viewTitle } from "../my-views";

// /app/my-views: open the first starred view, or explain how to add some
export const loader = async ({ request }) => {
  const { user } = await getStaff(request);
  const first = (user?.views ?? []).map(viewById).find((v) => v && allows(user, v.need[0], v.need[1]));
  if (first) {
    const url = new URL(request.url);
    const target = new URL(viewHref(first, { inMyViews: true }), url.origin);
    // Keep Shopify's embedded-app params
    for (const k of ["shop", "host", "embedded", "id_token", "locale"]) if (url.searchParams.get(k)) target.searchParams.set(k, url.searchParams.get(k));
    throw redirect(`${target.pathname}${target.search}`);
  }
  const available = VIEWS.filter((v) => allows(user, v.need[0], v.need[1])).map((v) => ({ id: v.id, title: viewTitle(v), href: viewHref(v) }));
  return { available };
};

export default function MyViewsEmpty() {
  const { available } = useLoaderData();
  return (
    <s-page heading="My Views">
      <s-section>
        <s-paragraph>
          Nothing here yet. Open any page or tab you use often and click <strong>☆ Add to My Views</strong> at the top right. It shows up here as a tab, so you can
          switch between the things you use without going through the menu.
        </s-paragraph>
        {available.length > 0 && (
          <>
            <s-paragraph>Pages and tabs you can add:</s-paragraph>
            <ul style={{ margin: "4px 0 0", paddingLeft: "18px", lineHeight: 1.8 }}>
              {available.map((v) => (
                <li key={v.id}>
                  <s-link href={v.href}>{v.title}</s-link>
                </li>
              ))}
            </ul>
          </>
        )}
      </s-section>
    </s-page>
  );
}
