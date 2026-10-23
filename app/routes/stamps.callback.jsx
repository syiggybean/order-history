import { StampsError, finishConnect, stampsPage as page } from "../stamps.server";

// Stamps.com sends the person back here after signing in
export const loader = async ({ request }) => {
  const p = new URL(request.url).searchParams;
  if (p.get("error")) return page(`Stamps.com said: ${p.get("error_description") || p.get("error")}`, false);
  try {
    await finishConnect(p.get("code"), p.get("state"), request);
    return page("You can close this tab and go back to the Label rate test page in Shopify.", true);
  } catch (e) {
    if (!(e instanceof StampsError)) console.error("[stamps] connect:", e);
    return page(e instanceof StampsError ? e.message : "Something went wrong finishing the Stamps.com sign-in.", false);
  }
};
