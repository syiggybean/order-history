import { StampsError, authorizeUrl, stampsPage as page } from "../stamps.server";

// Opened in its own tab from the Label rate test page: on to Stamps.com's sign-in
export const loader = async ({ request }) => {
  try {
    return Response.redirect(await authorizeUrl(new URL(request.url).searchParams.get("state"), request), 302);
  } catch (e) {
    return page(e instanceof StampsError ? e.message : "Something went wrong starting the Stamps.com sign-in.", false);
  }
};
