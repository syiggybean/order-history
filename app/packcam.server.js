import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import db from "./db.server";
import { CameraError, cameraScan, cameraState, cameraUploadDone, cameraUploadProgress, cameraUploadStart } from "./camera.server";
import { driveFileInfo, driveSetupProblem, startDriveUpload } from "./drive.server";
import { mailConfigured, mailFrom, sendNow } from "./mailer.server";
import { logEvent } from "./shipping.server";

// ---------------------------------------------------------------------------
// Pack Cam: the Packing Station Mac app, as MonkeyBean's pack camera.
//
// It works exactly like the browser camera window (/pack-camera): it follows
// the box open on the pack bench, sends scans, records, and uploads the video
// straight to Google Drive. Instead of a window link it signs in with its own
// key, made when the Mac is connected to a packing computer (Shipping →
// Settings → Packing computers, or the bench's "Connect this Mac").
//
// Pack Cam also cuts customer clips: staff choose part of a packing video, a
// packing Mac picks the job up (the one that recorded it first, since it still
// has the video that day), cuts a 720p H.264 clip and uploads it to Drive. The
// customer sees it in their account until it expires or is revoked.
//
// No Cloudflare, no separate server: Pack Cam talks only to MonkeyBean and
// Google Drive, and MonkeyBean keeps the Drive key.
// ---------------------------------------------------------------------------

export class PackCamError extends Error {}

const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const PAIR_MS = 15 * 60 * 1000;
const SEEN_MS = 15_000; // "running" = asked for the open box this recently (it asks about once a second)
const MAX_CLIP_SECONDS = 600;
const CLIP_STALE_MS = 20 * 60 * 1000; // a Mac that took a clip and went quiet: offer it to another
const CLIP_ATTEMPTS = 3;
const OTHERS_AFTER_MS = 90_000; // other Macs wait this long for the one that recorded it
const MAX_RELEASE_BYTES = 300 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Signed links (installer download, video preview, customer clip, clip source)
// ---------------------------------------------------------------------------

function secret() {
  const s = process.env.SHOPIFY_API_SECRET || process.env.PACKCAM_LINK_SECRET;
  if (!s) throw new Error("SHOPIFY_API_SECRET isn't set.");
  return s;
}

export function signLink(payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(`packcam-link\n${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function readLink(token, kind) {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret()).update(`packcam-link\n${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p;
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (p?.k !== kind || !(p.exp > Date.now())) return null;
  return p;
}

// ---------------------------------------------------------------------------
// Connecting a Mac
// ---------------------------------------------------------------------------

// A one-time code for a packing computer; Pack Cam exchanges it for its key.
// url: opens Pack Cam straight to connecting (packcam:// link), when it's installed.
export async function packCamPairCode(shop, stationId, appOrigin) {
  const st = await db.printStation.findFirst({ where: { id: Number(stationId), shop } });
  if (!st) throw new PackCamError("That packing computer isn't set up.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + PAIR_MS);
  await db.printStation.update({ where: { id: st.id }, data: { packCamPairHash: hash(`${shop}\n${code}`), packCamPairExpiresAt: expiresAt } });
  const server = String(appOrigin).replace(/\/+$/, "");
  return { code, expiresAt: expiresAt.toISOString(), station: st.name, url: `packcam://connect?server=${encodeURIComponent(server)}&shop=${encodeURIComponent(shop)}&code=${code}` };
}

// Pack Cam: { shop, code, host, version } → its key (shown only this once)
export async function packCamPair({ shop, code, host = null, version = null }) {
  const c = String(code ?? "").replace(/\D/g, "");
  if (c.length !== 6 || !shop) throw new PackCamError("Enter the 6-digit code from MonkeyBean.");
  const st = await db.printStation.findUnique({ where: { packCamPairHash: hash(`${shop}\n${c}`) } });
  if (!st || st.shop !== shop || !st.packCamPairExpiresAt || st.packCamPairExpiresAt < new Date()) {
    throw new PackCamError("That code has expired or isn't right. Get a new one from MonkeyBean.");
  }
  const key = `pc_${randomBytes(32).toString("base64url")}`;
  // Single use: a second Mac with the same code gets nothing
  const r = await db.printStation.updateMany({
    where: { id: st.id, packCamPairHash: st.packCamPairHash },
    data: {
      packCamKeyHash: hash(key),
      packCamPairHash: null,
      packCamPairExpiresAt: null,
      packCamPairedAt: new Date(),
      packCamHost: host ? String(host).slice(0, 120) : null,
      packCamVersion: version ? String(version).slice(0, 40) : null,
      packCamSeenAt: new Date(),
    },
  });
  if (r.count !== 1) throw new PackCamError("That code has already been used. Get a new one from MonkeyBean.");
  // A camera link from an earlier connection of this computer is no longer its camera
  await db.cameraLink.updateMany({ where: { stationId: st.id, revokedAt: null }, data: { revokedAt: new Date() } });
  return { key, station: { id: st.id, name: st.name } };
}

export async function packCamForget(shop, stationId) {
  const st = await db.printStation.findFirst({ where: { id: Number(stationId), shop } });
  if (!st) throw new PackCamError("That packing computer isn't set up.");
  await db.printStation.update({ where: { id: st.id }, data: { packCamKeyHash: null, packCamPairHash: null, packCamPairExpiresAt: null } });
  await db.cameraLink.updateMany({ where: { stationId: st.id, revokedAt: null }, data: { revokedAt: new Date() } });
  return { ok: true };
}

// Pack Cam's requests: "Authorization: Bearer <key>"
export async function packCamStation(request) {
  const m = /^Bearer\s+(pc_[A-Za-z0-9_-]{30,})$/.exec(request.headers.get("authorization") ?? "");
  const st = m ? await db.printStation.findUnique({ where: { packCamKeyHash: hash(m[1]) } }) : null;
  if (!st) throw new PackCamError("This Mac isn't connected to MonkeyBean. Connect it again from the pack bench.");
  return st;
}

async function seen(st, { version = null, info = null, host = null } = {}) {
  await db.printStation.update({
    where: { id: st.id },
    data: {
      packCamSeenAt: new Date(),
      ...(version ? { packCamVersion: String(version).slice(0, 40) } : {}),
      ...(info ? { packCamInfo: String(info).slice(0, 120) } : {}),
      ...(host ? { packCamHost: String(host).slice(0, 120) } : {}),
    },
  });
}

const stationLink = (st) => db.cameraLink.findFirst({ where: { stationId: st.id, kind: "pack", revokedAt: null }, orderBy: { id: "desc" } });

async function linkOrThrow(st) {
  const link = await stationLink(st);
  if (!link) throw new PackCamError("No pack bench is using this computer right now.");
  return link;
}

// ---- The camera protocol, signed in with the computer's key ----------------

// The box open at the bench using this computer (box: null when none, or idle
// when no bench has chosen this computer yet). Also: is there a clip to cut?
export async function packCamState(st, { info = null, version = null, host = null } = {}) {
  await seen(st, { version, info, host });
  const release = await currentRelease(st.shop);
  const update = release && isOlder(version ?? st.packCamVersion, release.version) ? { version: release.version } : null;
  const clipWaiting = (await db.packClip.count({ where: { shop: st.shop, status: "queued" } })) > 0;
  const station = { id: st.id, name: st.name };
  const link = await stationLink(st);
  if (!link) return { ok: true, idle: true, station, box: null, batch: null, update, clipWaiting, recording: !driveSetupProblem(), driveProblem: driveSetupProblem() };
  return { ...(await cameraState(link, { info })), station, idle: false, update, clipWaiting };
}

export async function packCamScan(st, body) {
  await seen(st);
  return cameraScan(await linkOrThrow(st), body);
}

// Pack Cam uploads from the Mac, not a web page, so no browser origin is passed to Google
export async function packCamUploadStart(st, body) {
  await seen(st);
  return cameraUploadStart(await linkOrThrow(st), body, null);
}

// Progress and finishing go by the video, which belongs to the shop (the bench may have moved on)
async function videoLink(st, videoId) {
  const v = await db.packVideo.findFirst({ where: { id: Number(videoId), shop: st.shop, stationId: st.id } });
  if (!v) throw new CameraError("Unknown video.");
  const link = await stationLink(st);
  // The shipment's work shop: the current link's, or the shop itself
  return link ?? { id: -1, shop: st.shop, workShop: st.shop, userName: v.userName };
}

export async function packCamUploadProgress(st, body) {
  await seen(st);
  return cameraUploadProgress(await videoLink(st, body.videoId), body);
}

export async function packCamUploadDone(st, body) {
  await seen(st);
  let check = null;
  if (body.driveFileId && !body.error && Number(body.sizeBytes) > 0) {
    // Google's copy must be the whole file before the Mac may clear its own
    const info = await driveFileInfo(String(body.driveFileId)).catch(() => null);
    if (!info || info.size !== Number(body.sizeBytes)) {
      return { ok: false, verified: false, error: "Google Drive's copy isn't the full video yet. Keep the local copy and try again." };
    }
    if (body.md5 && info.md5 && String(body.md5).toLowerCase() !== info.md5.toLowerCase()) {
      return { ok: false, verified: false, error: "Google Drive's copy doesn't match the recording. Keep the local copy and upload again." };
    }
    check = info;
  }
  const r = await cameraUploadDone(await videoLink(st, body.videoId), body);
  return { ...r, verified: Boolean(check), driveMd5: check?.md5 ?? null };
}

// ---------------------------------------------------------------------------
// The bench: is Pack Cam there? (drives Install / Update / Try again / built-in camera)
// ---------------------------------------------------------------------------

// state: none (no computer chosen) | notInstalled | outdated | notRunning | ready
export async function packCamStatus(shop, stationId) {
  const release = await currentRelease(shop);
  const latest = release ? { version: release.version, fileName: release.fileName, sizeBytes: release.sizeBytes } : null;
  if (!stationId) return { state: "none", latest };
  const st = await db.printStation.findFirst({ where: { id: Number(stationId), shop } });
  if (!st) return { state: "none", latest };
  const running = Boolean(st.packCamKeyHash && st.packCamSeenAt && Date.now() - st.packCamSeenAt.getTime() < SEEN_MS);
  const outdated = Boolean(latest && st.packCamVersion && isOlder(st.packCamVersion, latest.version));
  const state = !st.packCamKeyHash ? "notInstalled" : !running ? "notRunning" : outdated ? "outdated" : "ready";
  return {
    state,
    station: { id: st.id, name: st.name },
    version: st.packCamVersion,
    host: st.packCamHost,
    camera: st.packCamInfo,
    seenAt: st.packCamSeenAt?.toISOString() ?? null,
    latest,
    // packcam:// opens (or relaunches) the app when it's installed; the browser ignores it otherwise
    launchUrl: st.packCamKeyHash ? "packcam://open" : null,
  };
}

// "1.10.0" vs "1.9.2" (numbers compared part by part; anything else as text)
export function isOlder(have, want) {
  if (!have || !want) return false;
  const a = String(have).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const b = String(want).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y;
    return String(x) < String(y);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Installers
// ---------------------------------------------------------------------------

export async function currentRelease(shop) {
  return db.packCamRelease.findFirst({
    where: { shop },
    orderBy: { id: "desc" },
    select: { id: true, version: true, fileName: true, sizeBytes: true, sha256: true, uploadedBy: true, createdAt: true },
  });
}

export async function listReleases(shop) {
  return db.packCamRelease.findMany({
    where: { shop },
    orderBy: { id: "desc" },
    take: 5,
    select: { id: true, version: true, fileName: true, sizeBytes: true, sha256: true, uploadedBy: true, createdAt: true },
  });
}

// An admin uploads the signed installer; it becomes the version every bench expects
export async function saveRelease(shop, user, { version, fileName, bytes }) {
  const v = String(version ?? "").trim();
  if (!/^\d+(\.\d+){1,3}([-+][A-Za-z0-9.]+)?$/.test(v)) throw new PackCamError("Enter the version, like 1.0.0.");
  const name = String(fileName ?? "").trim();
  if (!/\.pkg$/i.test(name)) throw new PackCamError("Upload the signed Pack Cam installer (.pkg).");
  const buf = Buffer.from(bytes ?? []);
  if (buf.length < 1024) throw new PackCamError("That file is empty.");
  if (buf.length > MAX_RELEASE_BYTES) throw new PackCamError("That file is too big (over 300 MB).");
  // A flat .pkg is a xar archive
  if (buf.subarray(0, 4).toString("latin1") !== "xar!") throw new PackCamError("That isn't a macOS installer package.");
  const latest = await currentRelease(shop);
  if (latest && !isOlder(latest.version, v)) throw new PackCamError(`Version ${v} isn't newer than ${latest.version}, the one already offered.`);
  const r = await db.packCamRelease.create({
    data: { shop, version: v, fileName: name.replace(/[^A-Za-z0-9._ -]+/g, "-").slice(0, 120), sizeBytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf, uploadedBy: user?.name ?? null },
    select: { id: true, version: true, fileName: true, sizeBytes: true, sha256: true, uploadedBy: true, createdAt: true },
  });
  // Keep the newest three
  const old = await db.packCamRelease.findMany({ where: { shop }, orderBy: { id: "desc" }, skip: 3, select: { id: true } });
  if (old.length) await db.packCamRelease.deleteMany({ where: { id: { in: old.map((x) => x.id) } } });
  return r;
}

// A download link for the current installer (opened in a new tab; valid 30 minutes)
export async function releaseDownloadUrl(shop, appOrigin) {
  const r = await currentRelease(shop);
  if (!r) throw new PackCamError("No Pack Cam installer has been uploaded yet. An admin can add it in Shipping → Settings → Packing computers.");
  return { url: `${String(appOrigin).replace(/\/+$/, "")}/packcam/download?t=${signLink({ k: "pkg", id: r.id, shop }, 30 * 60_000)}`, version: r.version, fileName: r.fileName };
}

export async function releaseFile(token) {
  const p = readLink(token, "pkg");
  if (!p) return null;
  return db.packCamRelease.findFirst({ where: { id: p.id, shop: p.shop } });
}

// ---------------------------------------------------------------------------
// Recordings and customer clips (staff)
// ---------------------------------------------------------------------------

const clipView = (c, appOrigin) => ({
  id: c.id,
  status: liveStatus(c),
  startSeconds: c.startSeconds,
  endSeconds: c.endSeconds,
  availabilityDays: c.availabilityDays,
  notifyCustomer: c.notifyCustomer,
  error: c.error,
  createdAt: c.createdAt.toISOString(),
  createdBy: c.createdBy,
  publishedAt: c.publishedAt?.toISOString() ?? null,
  expiresAt: c.expiresAt?.toISOString() ?? null,
  revokedAt: c.revokedAt?.toISOString() ?? null,
  notifiedAt: c.notifiedAt?.toISOString() ?? null,
  watchUrl: liveStatus(c) === "published" && appOrigin ? watchUrl(c, appOrigin) : null,
});

// Expired is worked out, not stored
function liveStatus(c) {
  if (c.status === "published" && c.expiresAt && c.expiresAt <= new Date()) return "expired";
  return c.status;
}

const watchUrl = (c, appOrigin) =>
  `${String(appOrigin).replace(/\/+$/, "")}/packcam/media?t=${signLink({ k: "clip", id: c.id, shop: c.shop }, Math.max(60_000, (c.expiresAt?.getTime() ?? Date.now()) - Date.now()))}`;

// Finished packing videos, newest first; q: order number, customer name
export async function listRecordings(shop, { q = "", appOrigin = null, take = 30 } = {}) {
  const t = String(q ?? "").trim().replace(/^#/, "");
  const where = { shop, status: "done", driveFileId: { not: null } };
  if (t) {
    const ships = await db.shipment.findMany({
      where: { shop, OR: [{ orderName: { contains: t, mode: "insensitive" } }, { customerName: { contains: t, mode: "insensitive" } }] },
      select: { id: true },
      take: 200,
    });
    where.shipmentId = { in: ships.map((s) => s.id) };
  }
  const videos = await db.packVideo.findMany({ where, orderBy: { id: "desc" }, take });
  const ships = new Map((await db.shipment.findMany({ where: { id: { in: videos.map((v) => v.shipmentId) } }, select: { id: true, customerName: true, customerId: true, orderId: true } })).map((s) => [s.id, s]));
  const stations = new Map((await db.printStation.findMany({ where: { shop }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const clips = await db.packClip.findMany({ where: { packVideoId: { in: videos.map((v) => v.id) } }, orderBy: { id: "desc" } });
  return videos.map((v) => {
    const s = ships.get(v.shipmentId);
    return {
      id: v.id,
      shipmentId: v.shipmentId,
      orderName: v.orderName,
      customerName: s?.customerName ?? null,
      hasCustomer: Boolean(s?.customerId),
      packedBy: v.userName,
      camera: v.stationId ? `Pack Cam · ${stations.get(v.stationId) ?? "packing computer"}` : "Built-in camera",
      seconds: v.seconds,
      at: (v.doneAt ?? v.createdAt).toISOString(),
      fileName: v.fileName,
      previewUrl: appOrigin ? `${String(appOrigin).replace(/\/+$/, "")}/packcam/media?t=${signLink({ k: "rec", id: v.id, shop }, 2 * 60 * 60_000)}` : null,
      clips: clips.filter((c) => c.packVideoId === v.id).slice(0, 5).map((c) => clipView(c, appOrigin)),
    };
  });
}

const ORDER_CUSTOMER = `#graphql
  query PackCamClipCustomer($id: ID!) {
    order(id: $id) { id name customer { id displayName defaultEmailAddress { emailAddress } } }
  }`;

// Staff: queue a clip of a recording for a packing Mac to cut
export async function createClip(shop, admin, user, { videoId, startSeconds, endSeconds, availabilityDays = 30, notifyCustomer = false }) {
  const v = await db.packVideo.findFirst({ where: { id: Number(videoId), shop, status: "done", driveFileId: { not: null } } });
  if (!v) throw new PackCamError("That packing video isn't available.");
  const s = await db.shipment.findFirst({ where: { id: v.shipmentId }, select: { id: true, orderId: true, orderName: true } });
  if (!s) throw new PackCamError("That order isn't in the app anymore.");
  const start = Math.round(Number(startSeconds) * 10) / 10;
  const end = Math.round(Number(endSeconds) * 10) / 10;
  const length = v.seconds ?? Infinity;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > length + 1) {
    throw new PackCamError(`Choose a start and end within the video${Number.isFinite(length) ? ` (0 to ${length} seconds)` : ""}.`);
  }
  if (end - start > MAX_CLIP_SECONDS) throw new PackCamError("A clip can be at most 10 minutes long.");
  const days = Math.round(Number(availabilityDays));
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new PackCamError("Choose how long it's available: 1 to 365 days.");
  if (await db.packClip.findFirst({ where: { packVideoId: v.id, status: { in: ["queued", "cutting"] } } })) {
    throw new PackCamError("A clip of this video is already being made.");
  }
  // The customer it's for (their account shows it); none: it can't be shown to anyone
  const gid = String(s.orderId).startsWith("gid://") ? s.orderId : `gid://shopify/Order/${s.orderId}`;
  const res = await admin.graphql(ORDER_CUSTOMER, { variables: { id: gid } });
  const order = (await res.json())?.data?.order;
  if (!order) throw new PackCamError("Shopify couldn't find that order.");
  if (!order.customer?.id) throw new PackCamError("This order has no customer account in Shopify, so there's nowhere to show the clip.");
  const clip = await db.packClip.create({
    data: {
      shop,
      packVideoId: v.id,
      shipmentId: s.id,
      orderId: order.id,
      orderName: order.name ?? s.orderName,
      customerId: order.customer.id,
      customerName: order.customer.displayName ?? null,
      customerEmail: order.customer.defaultEmailAddress?.emailAddress ?? null,
      startSeconds: start,
      endSeconds: end,
      availabilityDays: days,
      notifyCustomer: Boolean(notifyCustomer),
      createdBy: user?.name ?? null,
    },
  });
  await logEvent(shop, { shipmentId: s.id, orderName: clip.orderName, type: "pack_clip", detail: `Customer clip queued (${fmtTime(start)}–${fmtTime(end)}, ${days} days)`, user });
  return clipView(clip);
}

export async function revokeClip(shop, user, clipId) {
  const c = await db.packClip.findFirst({ where: { id: Number(clipId), shop } });
  if (!c) throw new PackCamError("That clip isn't there.");
  if (c.status === "revoked") return clipView(c);
  const r = await db.packClip.update({ where: { id: c.id }, data: { status: "revoked", revokedAt: new Date(), revokedBy: user?.name ?? null } });
  await logEvent(shop, { shipmentId: c.shipmentId, orderName: c.orderName, type: "pack_clip", detail: "Customer clip revoked", user });
  return clipView(r);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Clip jobs (Pack Cam)
// ---------------------------------------------------------------------------

// The next clip for this Mac to cut, or null. The Mac that recorded a video gets
// first go (it still has the file that day); others after 90 seconds, or at once
// if that Mac isn't running.
export async function claimClip(st, appOrigin) {
  await seen(st);
  const now = Date.now();
  // Taken by a Mac that went quiet: back in the queue (or failed after 3 tries)
  const stale = await db.packClip.findMany({ where: { shop: st.shop, status: "cutting", claimedAt: { lt: new Date(now - CLIP_STALE_MS) } } });
  for (const c of stale) {
    await db.packClip.updateMany({
      where: { id: c.id, status: "cutting" },
      data: c.attempts >= CLIP_ATTEMPTS ? { status: "failed", error: "Pack Cam didn't finish cutting it." } : { status: "queued", stationId: null, claimedAt: null },
    });
  }
  const queued = await db.packClip.findMany({ where: { shop: st.shop, status: "queued" }, orderBy: { id: "asc" }, take: 20 });
  if (!queued.length) return null;
  const videos = new Map((await db.packVideo.findMany({ where: { id: { in: queued.map((c) => c.packVideoId) } } })).map((v) => [v.id, v]));
  const recorders = new Map(
    (await db.printStation.findMany({ where: { id: { in: [...videos.values()].map((v) => v.stationId).filter(Boolean) } }, select: { id: true, packCamSeenAt: true } })).map((s) => [s.id, s]),
  );
  for (const c of queued) {
    const v = videos.get(c.packVideoId);
    if (!v?.driveFileId) {
      await db.packClip.update({ where: { id: c.id }, data: { status: "failed", error: "The packing video is no longer in Google Drive." } });
      continue;
    }
    const mine = v.stationId === st.id;
    const recorder = v.stationId ? recorders.get(v.stationId) : null;
    const recorderAway = !recorder?.packCamSeenAt || now - recorder.packCamSeenAt.getTime() > SEEN_MS;
    if (!mine && v.stationId && !recorderAway && now - c.createdAt.getTime() < OTHERS_AFTER_MS) continue;
    const r = await db.packClip.updateMany({ where: { id: c.id, status: "queued" }, data: { status: "cutting", stationId: st.id, claimedAt: new Date(), attempts: { increment: 1 }, error: null } });
    if (r.count !== 1) continue; // another Mac took it
    return {
      clipId: c.id,
      videoId: v.id,
      orderName: c.orderName,
      // The Mac that recorded it may still have the file (it keeps it until the day ends)
      recordedHere: mine,
      sourceUrl: `${String(appOrigin).replace(/\/+$/, "")}/packcam/media?t=${signLink({ k: "src", id: v.id, shop: st.shop, st: st.id }, 60 * 60_000)}`,
      sourceMimeType: v.mimeType,
      sourceBytes: v.sizeBytes,
      startSeconds: c.startSeconds,
      endSeconds: c.endSeconds,
      // What to make: plays on any phone or browser
      output: { mimeType: "video/mp4", codec: "h264", maxHeight: 720, fileName: clipFileName(c) },
    };
  }
  return null;
}

const clipFileName = (c) => `${String(c.orderName).replace(/[^A-Za-z0-9]+/g, "") || `order${c.shipmentId}`}-customer-clip-${c.id}.mp4`;

async function myClip(st, clipId) {
  const c = await db.packClip.findFirst({ where: { id: Number(clipId), shop: st.shop } });
  if (!c || c.status !== "cutting" || c.stationId !== st.id) throw new PackCamError("This Mac isn't cutting that clip (anymore).");
  return c;
}

// The cut clip is ready: a Drive upload address for it
export async function clipUploadStart(st, { clipId }) {
  await seen(st);
  const c = await myClip(st, clipId);
  const uploadUrl = await startDriveUpload({
    name: clipFileName(c),
    mimeType: "video/mp4",
    description: `Customer clip of ${c.orderName}'s packing video (${fmtTime(c.startSeconds)}–${fmtTime(c.endSeconds)}).`,
    origin: null,
  });
  await db.packClip.update({ where: { id: c.id }, data: { claimedAt: new Date() } });
  return { ok: true, uploadUrl };
}

// Done (driveFileId, sizeBytes) or failed (error): published clips show in the customer's account
export async function clipDone(st, { clipId, driveFileId = null, sizeBytes = null, error = null }, appOrigin) {
  await seen(st);
  const c = await myClip(st, clipId);
  if (error || !driveFileId) {
    const last = c.attempts >= CLIP_ATTEMPTS;
    await db.packClip.update({
      where: { id: c.id },
      data: last ? { status: "failed", error: String(error ?? "Pack Cam couldn't cut it.").slice(0, 300) } : { status: "queued", stationId: null, claimedAt: null, error: String(error ?? "").slice(0, 300) || null },
    });
    return { ok: true, retry: !last };
  }
  const info = await driveFileInfo(String(driveFileId)).catch(() => null);
  if (!info || (Number(sizeBytes) > 0 && info.size !== Number(sizeBytes))) {
    return { ok: false, error: "Google Drive's copy of the clip isn't complete. Upload it again." };
  }
  const now = new Date();
  const published = await db.packClip.update({
    where: { id: c.id },
    data: { status: "published", driveFileId: String(driveFileId).slice(0, 120), sizeBytes: info.size, publishedAt: now, expiresAt: new Date(now.getTime() + c.availabilityDays * 86_400_000), error: null },
  });
  await logEvent(st.shop, { shipmentId: c.shipmentId, orderName: c.orderName, type: "pack_clip", detail: `Customer clip ready, available until ${published.expiresAt.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })}`, user: { name: null } });
  if (c.notifyCustomer) await notifyCustomer(published, appOrigin).catch((e) => console.error("[packcam] clip email:", e?.message ?? e));
  return { ok: true };
}

async function notifyCustomer(c, appOrigin) {
  if (!c.customerEmail || !mailConfigured() || c.notifiedAt) return;
  const url = watchUrl(c, appOrigin);
  const until = c.expiresAt.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "long" });
  const hi = c.customerName ? `Hi ${c.customerName.split(" ")[0]},` : "Hi,";
  const text = `${hi}\n\nHere's a short video of your order ${c.orderName} being packed:\n${url}\n\nIt's available until ${until}, and you can also find it on your order in your account.\n\nThank you for shopping with Yiggybean Books + Gifts!`;
  await sendNow({
    from: mailFrom(),
    to: c.customerEmail,
    subject: `Watch your order ${c.orderName} being packed`,
    text,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a"><p>${esc(hi)}</p><p>Here's a short video of your order ${esc(c.orderName)} being packed.</p><p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fff;border-radius:8px;text-decoration:none">Watch the video</a></p><p style="color:#555">It's available until ${esc(until)}, and you can also find it on your order in your account.</p><p>Thank you for shopping with Yiggybean Books + Gifts!</p></div>`,
  });
  await db.packClip.update({ where: { id: c.id }, data: { notifiedAt: new Date() } });
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// ---------------------------------------------------------------------------
// The customer's account (the "Your packing video" block on an order)
// ---------------------------------------------------------------------------

function b64urlJson(part) {
  try {
    return JSON.parse(Buffer.from(String(part), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Customer account extensions send a session token signed with the app's secret
export function verifyCustomerToken(token, { apiKey = process.env.SHOPIFY_API_KEY, apiSecret = process.env.SHOPIFY_API_SECRET, now = Date.now() } = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || !apiSecret) return null;
  const header = b64urlJson(parts[0]);
  const p = b64urlJson(parts[1]);
  if (header?.alg !== "HS256" || !p) return null;
  const want = createHmac("sha256", apiSecret).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2], "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  const sec = Math.floor(now / 1000);
  if (!aud.includes(apiKey) || !(p.exp >= sec) || (Number.isFinite(p.nbf) && p.nbf > sec + 5)) return null;
  if (!/^gid:\/\/shopify\/Customer\/\d+$/.test(String(p.sub ?? ""))) return null;
  const dest = String(p.dest ?? "").replace(/^https:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(dest)) return null;
  return { customerId: p.sub, shop: dest };
}

// The published clip of this customer's order, or null
export async function customerClip({ customerId, shop }, orderId, appOrigin) {
  const gid = /^\d+$/.test(String(orderId)) ? `gid://shopify/Order/${orderId}` : String(orderId ?? "");
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(gid)) return null;
  const c = await db.packClip.findFirst({
    where: { shop, orderId: gid, customerId, status: "published", revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { id: "desc" },
  });
  if (!c) return null;
  return { id: c.id, orderName: c.orderName, expiresAt: c.expiresAt.toISOString(), watchUrl: watchUrl(c, appOrigin) };
}

// ---------------------------------------------------------------------------
// What a signed media link points at (streamed from Drive by /packcam/media)
// ---------------------------------------------------------------------------

export async function mediaFor(token) {
  for (const kind of ["clip", "rec", "src"]) {
    const p = readLink(token, kind);
    if (!p) continue;
    if (kind === "clip") {
      const c = await db.packClip.findFirst({ where: { id: p.id, shop: p.shop } });
      if (!c || liveStatus(c) !== "published" || !c.driveFileId) return { gone: true };
      return { driveFileId: c.driveFileId, mimeType: "video/mp4", fileName: clipFileName(c) };
    }
    const v = await db.packVideo.findFirst({ where: { id: p.id, shop: p.shop } });
    if (!v?.driveFileId) return { gone: true };
    // A clip source is only for the Mac that took the job
    if (kind === "src") {
      const st = await db.printStation.findFirst({ where: { id: p.st, shop: p.shop, packCamKeyHash: { not: null } } });
      if (!st) return { gone: true };
    }
    return { driveFileId: v.driveFileId, mimeType: v.mimeType ?? (/\.mov$/i.test(v.fileName) ? "video/quicktime" : /\.mp4$/i.test(v.fileName) ? "video/mp4" : "video/webm"), fileName: v.fileName };
  }
  return null;
}
