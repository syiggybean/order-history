import { releaseFile } from "../packcam.server";

// The Pack Cam installer, by a signed link from the pack bench or settings (?t=, 30 minutes)
export const loader = async ({ request }) => {
  const r = await releaseFile(new URL(request.url).searchParams.get("t"));
  if (!r) return new Response("This download link has expired. Get a new one from MonkeyBean.", { status: 403, headers: { "Cache-Control": "no-store" } });
  return new Response(r.data, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(r.sizeBytes),
      "Content-Disposition": `attachment; filename="${r.fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
