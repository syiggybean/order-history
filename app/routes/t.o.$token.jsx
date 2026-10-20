import { recordOpen } from "../preorder-notify.server";

// Invisible image in notification emails: counts an open
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export const loader = async ({ params }) => {
  const token = String(params.token ?? "").replace(/\.gif$/, "");
  if (token) await recordOpen(token).catch(() => {});
  return new Response(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, max-age=0", "Content-Length": String(GIF.length) },
  });
};
