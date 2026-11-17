import { driveMedia } from "../drive.server";
import { mediaFor } from "../packcam.server";

// A packing video or customer clip, streamed from Google Drive by a signed,
// expiring link (?t=). Range requests pass through so the video can seek.
// Nothing is stored here; Drive stays private.

const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const m = await mediaFor(url.searchParams.get("t"));
  if (!m) return new Response("This link isn't valid or has expired.", { status: 403, headers: { "Cache-Control": "no-store" } });
  if (m.gone) return new Response("This video is no longer available.", { status: 410, headers: { "Cache-Control": "no-store" } });
  const res = await driveMedia(m.driveFileId, request.headers.get("range"));
  if (!res.ok && res.status !== 206) {
    if (res.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": res.headers.get("content-range") ?? "" } });
    console.error("[packcam] media: Drive", res.status);
    return new Response("The video couldn't be loaded. Try again.", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Accept-Ranges": "bytes" });
  for (const h of PASS) if (res.headers.get(h)) headers.set(h, res.headers.get(h));
  headers.set("Content-Type", m.mimeType);
  headers.set("Content-Disposition", `inline; filename="${m.fileName.replace(/"/g, "")}"`);
  return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers });
};
