import { CameraError } from "../camera.server";
import { appUrl } from "../print.server";
import {
  PackCamError,
  claimClip,
  clipDone,
  clipUploadStart,
  packCamPair,
  packCamScan,
  packCamStation,
  packCamState,
  packCamStopRecording,
  packCamUploadDone,
  packCamUploadProgress,
  packCamUploadStart,
} from "../packcam.server";

// Pack Cam (the Packing Station Mac app). POST, JSON, { intent, ... }.
// Every request but "pair" carries "Authorization: Bearer <the Mac's key>".
//   pair            { shop, code, host, version }       → { key, station }
//   state           { info, version, host }             → the open box (polled about once a second)
//   scan            { code, via }
//   stopRecording   { shipmentId }                      → that box's recording is thrown away and not restarted
//   uploadStart     { shipmentId, mimeType, seconds, startedAt, endedAt, clientNow, sizeBytes, videoId? } → { videoId, uploadUrl }
//   uploadProgress  { videoId, sentBytes }
//   uploadDone      { videoId, driveFileId, sizeBytes, md5, error? } → { verified }: only then may the Mac clear its copy
//   clipNext        {}                                    → { clip: null | job }
//   clipUploadStart { clipId }                            → { uploadUrl }
//   clipDone        { clipId, driveFileId, sizeBytes } or { clipId, error }

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const loader = () => json({ ok: false, error: "Not found." }, 404);

export const action = async ({ request }) => {
  if (!/application\/json/i.test(request.headers.get("content-type") ?? "")) return json({ ok: false, error: "Bad request." }, 415);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  const intent = String(body?.intent ?? "");
  try {
    if (intent === "pair") return json({ ok: true, ...(await packCamPair(body)) });
    const st = await packCamStation(request);
    const origin = appUrl(request);
    if (intent === "state") return json(await packCamState(st, body));
    if (intent === "scan") return json(await packCamScan(st, body));
    if (intent === "stopRecording") return json(await packCamStopRecording(st, body));
    if (intent === "uploadStart") return json(await packCamUploadStart(st, body));
    if (intent === "uploadProgress") return json(await packCamUploadProgress(st, body));
    if (intent === "uploadDone") return json(await packCamUploadDone(st, body));
    if (intent === "clipNext") return json({ ok: true, clip: await claimClip(st, origin) });
    if (intent === "clipUploadStart") return json(await clipUploadStart(st, body));
    if (intent === "clipDone") return json(await clipDone(st, body, origin));
    return json({ ok: false, error: "Unknown request." }, 400);
  } catch (e) {
    if (e instanceof PackCamError || e instanceof CameraError) {
      const signedOut = /isn't connected to MonkeyBean/.test(e.message);
      return json({ ok: false, error: e.message, signedOut }, signedOut ? 401 : 400);
    }
    console.error("[packcam]", intent, e);
    return json({ ok: false, error: "Something went wrong. Try again." }, 500);
  }
};
