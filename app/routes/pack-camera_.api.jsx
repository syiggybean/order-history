import { CameraError, cameraScan, cameraState, cameraUploadDone, cameraUploadProgress, cameraUploadStart } from "../camera.server";
import { appUrl } from "../print.server";

// The pack camera window's requests (POST, JSON). Every request carries the
// window's secret link key ("k"); there's no Shopify sign-in in that window.
//   { k, intent: "state", info }              the open box (polled about once a second)
//   { k, intent: "scan", code, via }           a barcode, or "line:<key>" matched by photo
//   { k, intent: "uploadStart", shipmentId, mimeType, seconds, startedAt, videoId? }
//   { k, intent: "uploadProgress", videoId, sentBytes }
//   { k, intent: "uploadDone", videoId, driveFileId, sizeBytes, error? }

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
  const k = String(body?.k ?? "");
  try {
    if (body.intent === "state") return json(await cameraState(k, { info: body.info }));
    if (body.intent === "scan") return json(await cameraScan(k, { code: body.code, via: body.via }));
    if (body.intent === "uploadStart") return json(await cameraUploadStart(k, body, appUrl(request)));
    if (body.intent === "uploadProgress") return json(await cameraUploadProgress(k, body));
    if (body.intent === "uploadDone") return json(await cameraUploadDone(k, body));
    return json({ ok: false, error: "Unknown request." }, 400);
  } catch (e) {
    if (e instanceof CameraError) return json({ ok: false, error: e.message, expired: /expired|isn't valid/.test(e.message) }, 400);
    console.error("[pack-camera]", e);
    return json({ ok: false, error: "Something went wrong. Try again." }, 500);
  }
};
