// Pack camera: browser-only helpers (no React). Barcode reading, photo matching,
// recording and the Google Drive upload queue.

// ---------------------------------------------------------------------------
// Scripts loaded only when needed (barcode fallback, photo matcher)
// ---------------------------------------------------------------------------

const ZXING_URL = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
const TF_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const MOBILENET_URL = "https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js";

const loaded = new Map();
export function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(s);
  });
  loaded.set(src, p);
  p.catch(() => loaded.delete(src));
  return p;
}

// ---------------------------------------------------------------------------
// Cameras: the chosen one is remembered on this computer (by id, and by name in
// case the browser gives it a new id)
// ---------------------------------------------------------------------------

const CAM_KEY = "mb-pack-camera";
export function savedCamera() {
  try {
    return JSON.parse(localStorage.getItem(CAM_KEY) || "null");
  } catch {
    return null;
  }
}
export function saveCamera(device) {
  try {
    localStorage.setItem(CAM_KEY, JSON.stringify({ deviceId: device.deviceId, label: device.label }));
  } catch {
    // storage blocked: just not remembered
  }
}
export function pickCamera(devices, saved) {
  if (!devices.length) return null;
  if (saved) {
    const byId = devices.find((d) => d.deviceId === saved.deviceId);
    if (byId) return byId;
    const byLabel = saved.label && devices.find((d) => d.label === saved.label);
    if (byLabel) return byLabel;
  }
  // Phones and tablets: the main back camera (not the selfie camera, nor the
  // ultra wide or zoom lenses), which is the one that suits barcodes
  const back = devices.filter((d) => /back|rear|environment/i.test(d.label));
  return back.find((d) => !/ultra|tele|dual|triple|wide|macro|depth/i.test(d.label)) ?? back[0] ?? devices[0];
}

// ---------------------------------------------------------------------------
// Barcodes: the browser's own reader where there is one (Chrome on Mac and
// Android), else ZXing C++ (WebAssembly), else ZXing JS. ZXing JS misreads
// slightly blurry EAN/UPC codes (a 7 read as a 1, an 8 as a 2), so it's only
// a last resort if the WebAssembly reader can't load.
// ---------------------------------------------------------------------------

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "qr_code", "data_matrix"];
const WASM_URL = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.5/dist/iife/reader/index.js";
const WASM_BIN = "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.5/dist/reader/zxing_reader.wasm";
const WASM_FORMATS = ["EAN13", "EAN8", "UPCA", "UPCE", "Code128", "Code39", "Code93", "ITF", "QRCode", "DataMatrix"];

// The camera frame, at full size (up to 1920 wide)
function frameCanvas(video, canvas) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, 1920 / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function wasmReader() {
  await loadScript(WASM_URL);
  const Z = window.ZXingWASM;
  await Z.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? WASM_BIN : prefix + path) },
    fireImmediately: true,
  });
  const canvas = document.createElement("canvas");
  const options = { formats: WASM_FORMATS, tryHarder: true, tryRotate: true, tryInvert: false, maxNumberOfSymbols: 4 };
  return {
    kind: "zxing-wasm",
    read: async (video) => {
      const c = frameCanvas(video, canvas);
      if (!c) return [];
      const image = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
      const found = await Z.readBarcodes(image, options);
      return found.filter((r) => r.isValid && r.text).map((r) => r.text);
    },
  };
}

async function jsReader() {
  await loadScript(ZXING_URL);
  const Z = window.ZXing;
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.EAN_13,
    Z.BarcodeFormat.EAN_8,
    Z.BarcodeFormat.UPC_A,
    Z.BarcodeFormat.UPC_E,
    Z.BarcodeFormat.CODE_128,
    Z.BarcodeFormat.CODE_39,
    Z.BarcodeFormat.ITF,
    Z.BarcodeFormat.QR_CODE,
  ]);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const canvas = document.createElement("canvas");
  return {
    kind: "zxing",
    read: async (video) => {
      const c = frameCanvas(video, canvas);
      if (!c) return [];
      try {
        const r = reader.decodeWithState(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c))));
        return r ? [r.getText()] : [];
      } catch {
        return []; // nothing found in this frame
      } finally {
        reader.reset();
      }
    },
  };
}

export async function makeBarcodeReader() {
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const d = new window.BarcodeDetector({ formats });
        return { kind: "native", read: async (source) => (await d.detect(source)).map((x) => x.rawValue).filter(Boolean) };
      }
    } catch {
      // fall through to ZXing
    }
  }
  try {
    return await wasmReader();
  } catch {
    return jsReader();
  }
}

// A code counts only once it's been read the same way in two frames in a row
// (a misread rarely repeats), so one bad frame can't scan the wrong item
export function makeConfirmer({ frames = 2, windowMs = 900 } = {}) {
  const seen = new Map(); // code -> { n, last }
  return (codes, now = Date.now()) => {
    const out = [];
    for (const c of codes) {
      const s = seen.get(c);
      const n = s && now - s.last <= windowMs ? s.n + 1 : 1;
      seen.set(c, { n, last: now });
      if (n >= frames) out.push(c);
    }
    for (const [c, s] of seen) if (now - s.last > 10_000) seen.delete(c);
    return out;
  };
}

// The same item held in view counts once: its code counts again only after it has
// been out of view for a moment (so two of the same item are shown one at a time).
// Reads miss the odd frame, so "out of view" means unseen for gapMs.
export function makeDebouncer({ gapMs = 1500 } = {}) {
  const seen = new Map(); // code -> last time seen
  const fresh = (codes, now = Date.now()) => {
    const out = [];
    for (const c of codes) {
      const last = seen.get(c);
      if (last === undefined || now - last > gapMs) out.push(c);
      seen.set(c, now);
    }
    return out;
  };
  // After a pause (matching by photo), codes seen before it count as still in view
  fresh.hold = (now = Date.now()) => {
    for (const c of seen.keys()) seen.set(c, now);
  };
  return fresh;
}

// ---------------------------------------------------------------------------
// Matching a photo to the box's items (no barcode): a small image model run in
// the browser compares the photo with each item's product image
// ---------------------------------------------------------------------------

let modelPromise = null;
export function loadMatcher() {
  if (!modelPromise)
    modelPromise = (async () => {
      await loadScript(TF_URL);
      await loadScript(MOBILENET_URL);
      return window.mobilenet.load({ version: 2, alpha: 1.0 });
    })();
  modelPromise.catch(() => {
    modelPromise = null;
  });
  return modelPromise;
}

// Shopify's image links carry the size; ask for a bigger one to compare against
export const largerImage = (url, width = 400) => (url ? (/[?&]width=\d+/.test(url) ? url.replace(/([?&]width=)\d+/, `$1${width}`) : url) : null);

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = url;
  });
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// The middle of the frame, square (the item is held up to the camera)
export function snapshot(video, size = 448) {
  const c = document.createElement("canvas");
  const w = video.videoWidth;
  const h = video.videoHeight;
  const side = Math.min(w, h) * 0.8;
  c.width = size;
  c.height = size;
  c.getContext("2d").drawImage(video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  return c;
}

const embedCache = new Map(); // image url -> vector
async function embed(model, source) {
  const t = model.infer(source, true);
  const v = await t.data();
  t.dispose();
  return Array.from(v);
}

// lines: [{key, imageUrl, ...}] → the same lines with a score (0–1), best first.
// Lines without an image get no score.
export async function rankByPhoto(model, photo, lines) {
  const target = await embed(model, photo);
  const out = [];
  for (const l of lines) {
    const url = largerImage(l.imageUrl);
    let score = null;
    if (url) {
      try {
        if (!embedCache.has(url)) embedCache.set(url, await embed(model, await loadImage(url)));
        score = cosine(target, embedCache.get(url));
      } catch {
        score = null;
      }
    }
    out.push({ ...l, score });
  }
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

// How sure the best match is: clearly ahead of the next one, and similar enough
export function matchConfidence(ranked) {
  const [a, b] = ranked;
  if (!a || a.score === null) return "none";
  const gap = a.score - (b?.score ?? 0);
  if (a.score > 0.6 && gap > 0.08) return "high";
  if (a.score > 0.45 && gap > 0.03) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Recording: one video per box
// ---------------------------------------------------------------------------

export function recordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  // MP4 (H.264) first: it plays everywhere, including in Google Drive's preview and on
  // phones. Browsers that can't record MP4 fall back to WebM.
  for (const t of ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

export function startRecording(stream, { onStop }) {
  const type = recordingType();
  if (type === null) return null;
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 1_500_000 });
  const chunks = [];
  const startedAt = Date.now();
  rec.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
  rec.onstop = () => {
    const mime = (rec.mimeType || type || "video/webm").split(";")[0];
    const endedAt = Date.now();
    onStop({ blob: new Blob(chunks, { type: mime }), mime, startedAt, endedAt, seconds: Math.round((endedAt - startedAt) / 1000) });
  };
  rec.start(1000);
  return { stop: () => rec.state !== "inactive" && rec.stop(), startedAt };
}

// ---------------------------------------------------------------------------
// Upload queue: videos wait in this browser (IndexedDB) until Google Drive has
// them, so a closed window or a dropped connection doesn't lose one
// ---------------------------------------------------------------------------

const DB = "mb-pack-camera";
const STORE = "uploads";
function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const memory = new Map(); // when IndexedDB isn't available
async function tx(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  } catch {
    return undefined;
  }
}
export async function queuePut(item) {
  memory.set(item.id, item);
  await tx("readwrite", (s) => s.put(item));
}
export async function queueDelete(id) {
  memory.delete(id);
  await tx("readwrite", (s) => s.delete(id));
}
export async function queueAll() {
  const rows = await tx("readonly", (s) => s.getAll());
  const all = new Map((rows ?? []).map((r) => [r.id, r]));
  for (const [id, r] of memory) if (!all.has(id)) all.set(id, r);
  return [...all.values()].sort((a, b) => a.createdAt - b.createdAt);
}

const CHUNK = 8 * 256 * 1024; // 2 MB (Google wants multiples of 256 KB)

// One PUT to the upload address; with XMLHttpRequest (in the browser) so the
// progress bar moves while a piece is on its way. Resolves { status, range, json }.
function put(url, headers, body, onSent) {
  if (typeof XMLHttpRequest === "undefined")
    return fetch(url, { method: "PUT", headers, body }).then((r) => ({ status: r.status, range: r.headers.get("Range"), json: () => r.json() }));
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onSent && x.upload) x.upload.onprogress = (e) => onSent(e.loaded);
    x.onload = () => resolve({ status: x.status, range: x.getResponseHeader("Range"), json: async () => JSON.parse(x.responseText || "{}") });
    x.onerror = () => reject(new Error("Network error"));
    x.ontimeout = () => reject(new Error("Timed out"));
    x.send(body ?? null);
  });
}

// Sends one queued video to its Drive upload address, resuming where it left off.
// Returns { done: fileId } or { expired: true } (start a new address) or throws.
// onProgress(bytesSent, total, saved): as it goes; saved = Google has confirmed it
export async function sendToDrive(item, onProgress) {
  const total = item.blob.size;
  // Where did Google get to?
  let offset = 0;
  const probe = await put(item.uploadUrl, { "Content-Range": `bytes */${total}` }, null);
  if (probe.status === 200 || probe.status === 201) return { done: (await probe.json()).id };
  if (probe.status === 404 || probe.status === 410) return { expired: true };
  if (probe.status === 308) {
    // (Some browsers can't read Google's Range header; then trust what this queue last sent)
    offset = probe.range ? Number(probe.range.split("-")[1]) + 1 : item.sent ?? 0;
  }
  onProgress?.(offset, total, false);
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const from = offset;
    const res = await put(item.uploadUrl, { "Content-Range": `bytes ${offset}-${end - 1}/${total}` }, item.blob.slice(offset, end), (n) => onProgress?.(Math.min(end, from + n), total, false));
    if (res.status === 200 || res.status === 201) {
      onProgress?.(total, total, true);
      return { done: (await res.json()).id };
    }
    if (res.status === 404 || res.status === 410) return { expired: true };
    if (res.status !== 308) throw new Error(`Google Drive answered ${res.status}`);
    offset = res.range ? Number(res.range.split("-")[1]) + 1 : end;
    onProgress?.(offset, total, true);
  }
  throw new Error("Upload didn't finish");
}
