import { flatRoutes } from "@react-router/fs-routes";
import { index, route } from "@react-router/dev/routes";
import { VIEW_PAGES } from "./my-views.js";

// Every file in app/routes, plus My Views: /app/my-views/<page> shows that
// page's own route (same loader, actions and screen) under the My Views tabs.
export default flatRoutes().then((routes) => {
  const app = routes.find((r) => r.file === "routes/app.jsx");
  if (!app) return routes;
  app.children = [
    ...(app.children ?? []),
    route("my-views", "views/layout.jsx", { id: "my-views" }, [
      index("views/index.jsx", { id: "my-views-index" }),
      ...VIEW_PAGES.map((page) => route(page, `routes/app.${page}.jsx`, { id: `my-views-${page}` })),
    ]),
  ];
  return routes;
});
