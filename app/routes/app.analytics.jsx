import { redirect } from "react-router";

// Analytics was renamed Reporting: send old links and bookmarks there
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  return redirect(`/app/reporting${url.search}`);
};

export default function AnalyticsMoved() {
  return null;
}
