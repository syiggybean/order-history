import { createHash, randomBytes } from "node:crypto";
import db from "./db.server";
import { getBox } from "./pack.server";
import { ShippingError, isSandboxShop, logEvent, staffKeyOf } from "./shipping.server";
import { driveFileUrl, driveSetupProblem, startDriveUpload } from "./drive.server";

// ---------------------------------------------------------------------------
// Pack camera
//
// Shopify's admin doesn't give embedded apps the camera, so the camera runs in
// its own window (/pack-camera), linked to a person's pack bench:
//
//   bench → server: what box is open (the camera shows it and records it)
//   camera → server: scans (barcodes, or items matched by photo)
//   bench ← server: those scans, applied exactly like a handheld scanner's
//
// The camera window holds a secret link (only its hash is stored). It can do
// nothing but read the open box, send scans and upload that box's video.
// Links stop working after 12 hours unused, or when "Unlink" is pressed.
// ---------------------------------------------------------------------------

const IDLE_MS = 12 * 60 * 60 * 1000;
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");

const activeWhere = (since = Date.now() - IDLE_MS) => ({
  revokedAt: null,
  OR: [{ cameraSeenAt: { gte: new Date(since) } }, { createdAt: { gte: new Date(since) } }],
});

// ---- The bench (signed in to the app) --------------------------------------

// context: the batch and box open at the bench right now, so the new camera starts there
export async function benchLink(shop, workShop, user, appOrigin, { batchId = null, shipmentId = null } = {}) {
  const secret = randomBytes(24).toString("base64url");
  await db.cameraLink.create({
    data: {
      shop,
      workShop,
      staffKey: staffKeyOf(user),
      userName: user?.name ?? null,
      secretHash: hash(secret),
      batchId: batchId ? Number(batchId) : null,
      shipmentId: shipmentId ? Number(shipmentId) : null,
      contextAt: batchId ? new Date() : null,
    },
  });
  return { url: `${appOrigin}/pack-camera?k=${secret}` };
}

// The box open at the bench (null: none), for every camera linked to this person
export async function benchContext(shop, workShop, user, { batchId = null, shipmentId = null } = {}) {
  await db.cameraLink.updateMany({
    where: { shop, workShop, staffKey: staffKeyOf(user), ...activeWhere() },
    data: { batchId: batchId ? Number(batchId) : null, shipmentId: shipmentId ? Number(shipmentId) : null, contextAt: new Date() },
  });
}

// Scans waiting for this person's bench (oldest first), and which cameras are connected
export async function benchTakeScans(shop, workShop, user) {
  const links = await db.cameraLink.findMany({ where: { shop, workShop, staffKey: staffKeyOf(user), ...activeWhere() }, orderBy: { id: "asc" } });
  if (!links.length) return { scans: [], cameras: [] };
  const ids = links.map((l) => l.id);
  const scans = await db.cameraScan.findMany({ where: { linkId: { in: ids }, takenAt: null }, orderBy: { id: "asc" }, take: 50 });
  if (scans.length) await db.cameraScan.updateMany({ where: { id: { in: scans.map((x) => x.id) }, takenAt: null }, data: { takenAt: new Date() } });
  const now = Date.now();
  return {
    scans: scans.map((x) => ({ id: x.id, code: x.code, via: x.via })),
    cameras: links.map((l) => ({ id: l.id, connected: Boolean(l.cameraSeenAt && now - l.cameraSeenAt.getTime() < 15_000), info: l.cameraInfo })),
  };
}

export async function benchUnlink(shop, workShop, user) {
  const r = await db.cameraLink.updateMany({ where: { shop, workShop, staffKey: staffKeyOf(user), revokedAt: null }, data: { revokedAt: new Date() } });
  return { unlinked: r.count };
}

// Videos for a box (shown on the bench)
export async function videosFor(shop, shipmentId) {
  const rows = await db.packVideo.findMany({ where: { shop, shipmentId: Number(shipmentId), status: { in: ["uploading", "done", "failed"] } }, orderBy: { id: "desc" }, take: 5 });
  return rows.map((v) => ({
    id: v.id,
    status: v.status,
    fileName: v.fileName,
    url: driveFileUrl(v.driveFileId),
    at: v.createdAt.toISOString(),
    error: v.error,
    pct: v.status === "done" ? 100 : v.sizeBytes ? Math.min(99, Math.round(((v.sentBytes ?? 0) / v.sizeBytes) * 100)) : null,
  }));
}

// ---- The camera window (holds the secret link) -----------------------------

export class CameraError extends Error {}

async function linkFor(secret) {
  if (!secret || String(secret).length < 20) throw new CameraError("This camera link isn't valid. Open the camera again from the pack bench.");
  const link = await db.cameraLink.findUnique({ where: { secretHash: hash(secret) } });
  const last = link ? Math.max(link.createdAt.getTime(), link.cameraSeenAt?.getTime() ?? 0) : 0;
  if (!link || link.revokedAt || Date.now() - last > IDLE_MS) throw new CameraError("This camera link has expired. Open the camera again from the pack bench.");
  return link;
}

// The batch open at the bench: its name and boxes, so the camera can show where
// packing is and open the next box
async function batchSummary(workShop, batchId) {
  const b = await db.batch.findFirst({ where: { id: Number(batchId), shop: workShop } });
  if (!b) return null;
  const rows = await db.shipment.findMany({
    where: { batchId: b.id, shop: workShop, state: { in: ["batched", "packed", "labeling", "shipped"] } },
    orderBy: [{ orderCreatedAt: "asc" }, { partIndex: "asc" }],
    select: { id: true, orderName: true, partIndex: true, partCount: true, state: true, units: true },
    take: 300,
  });
  const boxes = rows.map((r) => ({
    id: r.id,
    orderName: r.orderName,
    part: r.partCount > 1 ? `${r.partIndex} of ${r.partCount}` : null,
    // What to scan to open it (the packing slip's barcode says the same)
    code: r.partCount > 1 ? `${r.orderName}-${r.partIndex}` : r.orderName,
    units: r.units,
    packed: r.state !== "batched",
  }));
  return { id: b.id, title: b.name ? `${b.tag} · ${b.name}` : b.tag, status: b.status, total: boxes.length, packed: boxes.filter((x) => x.packed).length, boxes };
}

// What to show: the open box (or none). info: the camera in use, for the bench to show
export async function cameraState(secret, { info = null } = {}) {
  const link = await linkFor(secret);
  await db.cameraLink.update({ where: { id: link.id }, data: { cameraSeenAt: new Date(), ...(info ? { cameraInfo: String(info).slice(0, 120) } : {}) } });
  let box = null;
  if (link.batchId && link.shipmentId) {
    try {
      const b = await getBox(link.workShop, link.batchId, link.shipmentId);
      box = {
        id: b.id,
        batchId: link.batchId,
        orderName: b.orderName,
        part: b.part,
        state: b.state,
        units: b.units,
        scanned: b.scanned,
        lines: b.lines.map((l) => ({ key: l.key, title: l.title, variantTitle: l.variantTitle, sku: l.sku, barcode: l.barcode, imageUrl: l.imageUrl, qty: l.qty, scanned: l.scanned })),
      };
    } catch {
      box = null;
    }
  }
  const sandbox = isSandboxShop(link.workShop);
  const batch = link.batchId ? await batchSummary(link.workShop, link.batchId) : null;
  return { ok: true, userName: link.userName, box, batch, contextAt: link.contextAt?.toISOString() ?? null, sandbox, recording: !sandbox && !driveSetupProblem(), driveProblem: sandbox ? null : driveSetupProblem() };
}

export async function cameraScan(secret, { code, via = "barcode" }) {
  const link = await linkFor(secret);
  const c = String(code ?? "").trim().slice(0, 200);
  if (!c) throw new CameraError("Nothing scanned.");
  await db.cameraScan.create({ data: { linkId: link.id, code: c, via: via === "visual" ? "visual" : "barcode" } });
  await db.cameraLink.update({ where: { id: link.id }, data: { cameraSeenAt: new Date() } });
  return { ok: true };
}

const extOf = (mime) => (/mp4/i.test(mime) ? "mp4" : "webm");

// A box's video is ready: start its upload to Google Drive
// videoId: an earlier try for the same video (its upload address expired): start again under it
// Only the recording during which the box was packed is uploaded: one that ended
// before the box was packed (an abandoned attempt), or a box that was unpacked
// since, is skipped ({ skip: true }). Times come from the camera's clock;
// clientNow lets the app allow for that clock being off.
const PACK_GRACE_MS = 15_000;
export function packedDuring(packedAt, { startedAt, endedAt, seconds, capped, clientNow }, now = Date.now()) {
  if (!packedAt) return false;
  const skew = Number.isFinite(Number(clientNow)) && clientNow !== null ? now - Number(clientNow) : 0;
  const start = Number(startedAt) + skew;
  if (!Number.isFinite(start)) return false;
  const end = (Number(endedAt) || Number(startedAt) + (Number(seconds) || 0) * 1000) + skew;
  const at = packedAt.getTime();
  return at >= start - 5000 && (capped || at <= end + PACK_GRACE_MS);
}

// "#35968" → "35968.mp4"; a split order "35968-part1of2.mp4" (letters and
// numbers only, nothing special in the name)
function videoFileName(s, mime) {
  const base = String(s.orderName ?? "").replace(/[^A-Za-z0-9]+/g, "") || `order${s.id}`;
  const part = s.partCount > 1 ? `-part${s.partIndex}of${s.partCount}` : "";
  return `${base}${part}.${extOf(mime)}`;
}

export async function cameraUploadStart(secret, { shipmentId, mimeType, seconds, startedAt, endedAt = null, capped = false, clientNow = null, videoId = null, sizeBytes = null }, origin) {
  const link = await linkFor(secret);
  if (isSandboxShop(link.workShop)) throw new CameraError("Sandbox: videos aren't uploaded.");
  const s = await db.shipment.findFirst({ where: { shop: link.workShop, id: Number(shipmentId) } });
  if (!s) throw new CameraError("That order isn't in the app anymore.");
  const mime = /^video\/(webm|mp4)/.test(String(mimeType)) ? String(mimeType).split(";")[0] : "video/webm";
  const part = s.partCount > 1 ? ` (${s.partIndex} of ${s.partCount})` : "";
  const earlier = videoId ? await db.packVideo.findFirst({ where: { id: Number(videoId), shop: link.shop, shipmentId: s.id, status: { not: "done" } } }) : null;
  // Only the recording of the box's last packing (it's packed, and was packed during
  // this recording). Abandoned attempts, and packings undone since, aren't uploaded.
  if (!packedDuring(s.packedAt, { startedAt, endedAt, seconds, capped, clientNow })) {
    if (earlier) await db.packVideo.update({ where: { id: earlier.id }, data: { status: "skipped", error: "Box repacked or unpacked since" } });
    return { ok: false, skip: true, error: "Not the box's last packing, so it isn't uploaded." };
  }
  // One file per box: repacking replaces the video in the same Drive file
  const saved = await db.packVideo.findFirst({ where: { shop: link.shop, shipmentId: s.id, status: "done", driveFileId: { not: null } }, orderBy: { id: "desc" } });
  const fileName = videoFileName(s, mime);
  const when = s.packedAt ?? new Date();
  const description = `Packing video for ${s.orderName}${part}. Packed by ${link.userName ?? "staff"} on ${when.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" })} (Pacific).`;
  const video = earlier
    ? await db.packVideo.update({ where: { id: earlier.id }, data: { status: "uploading", error: null } })
    : await db.packVideo.create({
        data: {
          shop: link.shop,
          shipmentId: s.id,
          orderName: s.orderName,
          fileName,
          userName: link.userName,
          seconds: Number.isFinite(Number(seconds)) ? Math.round(Number(seconds)) : null,
          sizeBytes: Number(sizeBytes) > 0 ? Math.round(Number(sizeBytes)) : null,
          sentBytes: 0,
        },
      });
  try {
    const uploadUrl = await startDriveUpload({ name: fileName, mimeType: mime, description, origin, replaceId: saved?.driveFileId ?? null });
    return { ok: true, videoId: video.id, uploadUrl, fileName };
  } catch (e) {
    await db.packVideo.update({ where: { id: video.id }, data: { status: "failed", error: String(e.message).slice(0, 300) } });
    throw new CameraError(e.message);
  }
}

// How far the upload has got (the pack bench shows a progress bar)
export async function cameraUploadProgress(secret, { videoId, sentBytes }) {
  const link = await linkFor(secret);
  await db.packVideo.updateMany({ where: { id: Number(videoId), shop: link.shop, status: "uploading" }, data: { sentBytes: Math.max(0, Math.round(Number(sentBytes) || 0)) } });
  return { ok: true };
}

export async function cameraUploadDone(secret, { videoId, driveFileId, sizeBytes, error }) {
  const link = await linkFor(secret);
  const v = await db.packVideo.findFirst({ where: { id: Number(videoId), shop: link.shop } });
  if (!v) throw new CameraError("Unknown video.");
  const ok = Boolean(driveFileId) && !error;
  await db.packVideo.update({
    where: { id: v.id },
    data: ok
      ? { status: "done", driveFileId: String(driveFileId).slice(0, 120), sizeBytes: Number(sizeBytes) || null, doneAt: new Date(), error: null }
      : { status: "failed", error: String(error ?? "Upload didn't finish").slice(0, 300) },
  });
  // Earlier videos of this box were replaced by this one (same Drive file, or a new one)
  if (ok) await db.packVideo.updateMany({ where: { shop: link.shop, shipmentId: v.shipmentId, status: "done", id: { not: v.id } }, data: { status: "replaced" } });
  if (ok)
    await logEvent(link.workShop, { shipmentId: v.shipmentId, orderName: v.orderName, type: "pack_video", detail: `Packing video saved to Google Drive: ${v.fileName} ${driveFileUrl(driveFileId)}`, user: { name: link.userName } });
  return { ok: true };
}

export { ShippingError };
