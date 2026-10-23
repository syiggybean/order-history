import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import db from "./db.server";
import agentScript from "./print-agent/agent.sh?raw";
import installTemplate from "./print-agent/install.sh?raw";
import uninstallScript from "./print-agent/uninstall.sh?raw";

// ---------------------------------------------------------------------------
// Direct printing through the MonkeyBean Print agent on each packing Mac.
//
// A packing computer ("station") is added in Settings, which gives a one-time install
// command. The agent on the Mac swaps that code for its own key, reports its printers,
// then keeps a request open to /print-agent/next. Printing anything here queues a job for
// the person's packing computer; the agent downloads and prints it with lp, and reports
// back. Jobs nobody picks up within 10 minutes are dropped, so a Mac that was off never
// comes back and prints a stack of old labels.
// ---------------------------------------------------------------------------

export const AGENT_VERSION = Number(agentScript.match(/^AGENT_VERSION=(\d+)/m)?.[1] ?? 1);
export const ONLINE_MS = 75_000; // the agent asks again at least every ~45 s
const PAIR_MS = 60 * 60_000;
const JOB_TTL_MS = 10 * 60_000;
const CLAIM_MS = 2 * 60_000;
const WAIT_MS = 25_000;
export const SLIP_SIZES = ["letter", "4x6"];

export class PrintError extends Error {}

const wake = new EventEmitter();
wake.setMaxListeners(0);
const poke = (stationId) => wake.emit(`s${stationId}`);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode() {
  const b = crypto.randomBytes(12);
  let s = "";
  for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const newToken = () => `mbp_${crypto.randomBytes(32).toString("base64url")}`;
const oneLine = (s, max = 200) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
const parse = (s, d) => {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
};

export function appUrl(request) {
  return String(process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
}
export const installCommand = (url, code) => `curl -fsSL ${url}/print-agent/install | bash -s -- ${code}`;
export const uninstallCommand = (url) => `curl -fsSL ${url}/print-agent/uninstall | bash`;

// lp options typed in settings, kept to plain words (e.g. "fit-to-page media=w288h432")
export function cleanOptions(s) {
  return String(s ?? "")
    .split(/\s+/)
    .filter((o) => /^[A-Za-z0-9][A-Za-z0-9._:=,-]{0,60}$/.test(o))
    .slice(0, 10)
    .join(" ");
}

// ---------------------------------------------------------------------------
// What the Mac reports (lpstat output)
// ---------------------------------------------------------------------------

const THERMAL = /zebra|rollo|dymo|label|4\s*x\s*6|zd\d|gk4|gx4|zt\d|lp\s?2844|tlp|munbyn|polono|phomemo|arkscan|itari|nelko|idprt|xprinter|ql-\d/i;
const ZEBRA = /zebra|zd\d|gk4|gx4|zt\d|lp\s?2844|tlp/i;

export function parsePrinters(listing = "", defaultText = "", devicesText = "") {
  const out = [];
  let cur = null;
  for (const line of String(listing).split(/\r?\n/)) {
    const m = line.match(/^printer (\S+) (.*)$/);
    if (m) {
      const rest = m[2];
      cur = { name: m[1], description: null, state: /disabled/i.test(rest) ? "disabled" : /printing/i.test(rest) ? "printing" : "idle" };
      out.push(cur);
      continue;
    }
    const d = cur && line.match(/^\s+Description:\s*(.*)$/);
    if (d && d[1].trim()) cur.description = d[1].trim();
  }
  const def = String(defaultText).match(/system default destination:\s*(\S+)/)?.[1] ?? null;
  const devices = new Map();
  for (const line of String(devicesText).split(/\r?\n/)) {
    const m = line.match(/^device for (\S+):\s*(\S+)/);
    if (m) devices.set(m[1], m[2]);
  }
  return out.slice(0, 40).map((p) => {
    const words = `${p.name} ${p.description ?? ""} ${decodeURIComponent(devices.get(p.name) ?? "")}`;
    return {
      ...p,
      isDefault: p.name === def,
      device: devices.get(p.name)?.replace(/\?.*$/, "") ?? null,
      thermal: THERMAL.test(words),
      zebra: ZEBRA.test(words),
    };
  });
}

// ---------------------------------------------------------------------------
// Packing computers
// ---------------------------------------------------------------------------

const online = (st) => Boolean(st.lastSeenAt && Date.now() - st.lastSeenAt.getTime() < ONLINE_MS);

export function stationView(st) {
  const printers = parse(st.printers, []);
  return {
    id: st.id,
    name: st.name,
    host: st.host ?? null,
    agentVersion: st.agentVersion ? Number(st.agentVersion) : null,
    outdated: Boolean(st.agentVersion && Number(st.agentVersion) < AGENT_VERSION),
    osVersion: st.osVersion ?? null,
    paired: Boolean(st.tokenHash),
    installPending: Boolean(st.pairHash && st.pairExpiresAt && st.pairExpiresAt > new Date()),
    installExpiresAt: st.pairExpiresAt?.toISOString() ?? null,
    online: online(st),
    lastSeenAt: st.lastSeenAt?.toISOString() ?? null,
    printers,
    printersAt: st.printersAt?.toISOString() ?? null,
    labelPrinter: st.labelPrinter ?? null,
    labelOptions: st.labelOptions ?? "",
    slipPrinter: st.slipPrinter ?? null,
    slipOptions: st.slipOptions ?? "",
    slipSize: SLIP_SIZES.includes(st.slipSize) ? st.slipSize : "letter",
    labelZebra: Boolean(printers.find((p) => p.name === st.labelPrinter)?.zebra),
  };
}

export async function listStations(shop) {
  const rows = await db.printStation.findMany({ where: { shop }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return rows.map(stationView);
}

async function stationOf(shop, id) {
  const st = await db.printStation.findFirst({ where: { shop, id: Number(id) } });
  if (!st) throw new PrintError("That packing computer was removed.");
  return st;
}

async function withInstallCode(st, url) {
  const code = newCode();
  const updated = await db.printStation.update({ where: { id: st.id }, data: { pairHash: sha(code), pairExpiresAt: new Date(Date.now() + PAIR_MS) } });
  return { station: stationView(updated), code, command: installCommand(url, code), expiresAt: updated.pairExpiresAt.toISOString() };
}

export async function addStation(shop, name, user, url) {
  const n = oneLine(name, 60);
  if (!n) throw new PrintError("Give the computer a name, like “Packing 1”.");
  if (await db.printStation.findFirst({ where: { shop, name: { equals: n, mode: "insensitive" } } })) throw new PrintError("There's already a computer with that name.");
  const st = await db.printStation.create({ data: { shop, name: n, createdBy: user?.name ?? null } });
  return withInstallCode(st, url);
}

// A fresh install command (reinstalling, or a new Mac taking over the same station)
export async function newInstallCode(shop, id, url) {
  return withInstallCode(await stationOf(shop, id), url);
}

export async function saveStation(shop, id, input) {
  const st = await stationOf(shop, id);
  const data = {};
  if (input.name !== undefined) {
    const n = oneLine(input.name, 60);
    if (!n) throw new PrintError("The name can't be empty.");
    const clash = await db.printStation.findFirst({ where: { shop, id: { not: st.id }, name: { equals: n, mode: "insensitive" } } });
    if (clash) throw new PrintError("There's already a computer with that name.");
    data.name = n;
  }
  const names = new Set(parse(st.printers, []).map((p) => p.name));
  for (const k of ["labelPrinter", "slipPrinter"]) {
    if (input[k] === undefined) continue;
    const v = input[k] ? String(input[k]) : null;
    if (v && !names.has(v)) throw new PrintError(`“${v}” isn't one of this Mac's printers. Refresh its printers and choose again.`);
    data[k] = v;
  }
  if (input.labelOptions !== undefined) data.labelOptions = cleanOptions(input.labelOptions) || null;
  if (input.slipOptions !== undefined) data.slipOptions = cleanOptions(input.slipOptions) || null;
  if (input.slipSize !== undefined) data.slipSize = SLIP_SIZES.includes(input.slipSize) ? input.slipSize : "letter";
  return stationView(await db.printStation.update({ where: { id: st.id }, data }));
}

export async function removeStation(shop, id) {
  const st = await stationOf(shop, id);
  await db.printJob.updateMany({ where: { stationId: st.id, status: { in: ["queued", "printing"] } }, data: { status: "failed", message: "The computer was removed.", data: null, doneAt: new Date() } });
  await db.printPref.deleteMany({ where: { shop, stationId: st.id } });
  await db.printStation.delete({ where: { id: st.id } });
  poke(st.id);
  return { removed: st.id };
}

export async function refreshPrinters(shop, id) {
  const st = await stationOf(shop, id);
  await db.printStation.update({ where: { id: st.id }, data: { wantHello: true } });
  poke(st.id);
  return { ok: true };
}

// The computer each person last printed from: used when their browser has forgotten
export async function rememberStation(shop, staffKey, stationId) {
  if (!staffKey) return;
  if (!stationId) {
    await db.printPref.deleteMany({ where: { shop, staffKey } });
    return;
  }
  await db.printPref.upsert({ where: { shop_staffKey: { shop, staffKey } }, create: { shop, staffKey, stationId: Number(stationId) }, update: { stationId: Number(stationId) } });
}
export async function myStationId(shop, staffKey) {
  if (!staffKey) return null;
  return (await db.printPref.findUnique({ where: { shop_staffKey: { shop, staffKey } } }))?.stationId ?? null;
}

// ---------------------------------------------------------------------------
// Print jobs (from the app)
// ---------------------------------------------------------------------------

export function jobView(j, stationName = null) {
  return {
    id: j.id,
    stationId: j.stationId,
    station: stationName,
    kind: j.kind,
    title: j.title,
    printer: j.printer,
    format: j.format,
    status: j.status,
    message: j.message ?? null,
    createdAt: j.createdAt.toISOString(),
    doneAt: j.doneAt?.toISOString() ?? null,
    by: j.createdBy ?? null,
    done: ["printed", "waiting", "failed", "expired"].includes(j.status),
  };
}

// Jobs that were never picked up or never reported back
async function tidy(where = {}) {
  const now = Date.now();
  await db.printJob.updateMany({
    where: { ...where, status: "queued", createdAt: { lt: new Date(now - JOB_TTL_MS) } },
    data: { status: "expired", message: "The packing computer didn't pick this up within 10 minutes, so it was dropped.", data: null, doneAt: new Date() },
  });
  await db.printJob.updateMany({
    where: { ...where, status: "printing", claimedAt: { lt: new Date(now - CLAIM_MS) } },
    data: { status: "failed", message: "The packing computer took this job but never said whether it printed. Check the printer before printing again.", doneAt: new Date() },
  });
}

// Is this station ready to print this kind of thing? (checked before fetching any files)
export async function stationReady(shop, stationId, role) {
  if (!stationId) return { ready: false, reason: "none" };
  const st = await db.printStation.findFirst({ where: { shop, id: Number(stationId) } });
  if (!st) return { ready: false, reason: "removed" };
  if (!online(st)) return { ready: false, reason: "offline", station: st.name };
  const printer = role === "slip" ? st.slipPrinter : st.labelPrinter;
  if (!printer) return { ready: false, reason: "noPrinter", station: st.name };
  return { ready: true, station: st, printer };
}

export const FALLBACK_TEXT = {
  none: "This computer isn't set up for direct printing",
  removed: "The packing computer chosen here was removed",
  offline: "{station} isn't connected (is the Mac on?)",
  noPrinter: "{station} has no printer chosen for this",
};
export const fallbackText = (r) => (FALLBACK_TEXT[r?.reason] ?? "Direct printing isn't available").replace("{station}", r?.station ?? "The packing computer");

// Queue a file: { role: label|slip, kind, title, format: PDF|ZPL, bytes: Buffer, copies }
export async function queuePrint(shop, stationId, doc, user) {
  const r = await stationReady(shop, stationId, doc.role);
  if (!r.ready) return { fallback: r.reason, text: fallbackText(r) };
  const st = r.station;
  const job = await db.printJob.create({
    data: {
      shop,
      stationId: st.id,
      kind: doc.kind,
      role: doc.role,
      title: oneLine(doc.title, 120) || "MonkeyBean",
      printer: r.printer,
      options: doc.format === "ZPL" ? null : cleanOptions(doc.role === "slip" ? st.slipOptions : st.labelOptions) || null,
      format: doc.format === "ZPL" ? "ZPL" : "PDF",
      copies: Math.min(Math.max(Number(doc.copies) || 1, 1), 20),
      data: Buffer.from(doc.bytes),
      createdBy: user?.name ?? null,
    },
  });
  poke(st.id);
  return { job: jobView(job, st.name) };
}

export async function jobStatus(shop, ids) {
  const list = [...new Set((ids ?? []).map(Number).filter(Boolean))].slice(0, 50);
  if (!list.length) return [];
  await tidy({ shop, id: { in: list } });
  const rows = await db.printJob.findMany({ where: { shop, id: { in: list } } });
  const names = new Map((await db.printStation.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.stationId))] } } })).map((s) => [s.id, s.name]));
  return rows.map((j) => jobView(j, names.get(j.stationId) ?? "a removed computer"));
}

export async function recentJobs(shop, take = 25) {
  await tidy({ shop });
  // Files are only kept a day (to retry); job history for 30 days
  await db.printJob.updateMany({ where: { shop, data: { not: null }, createdAt: { lt: new Date(Date.now() - 86_400_000) } }, data: { data: null } });
  await db.printJob.deleteMany({ where: { shop, createdAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
  const rows = await db.printJob.findMany({ where: { shop }, orderBy: { id: "desc" }, take });
  const names = new Map((await db.printStation.findMany({ where: { shop } })).map((s) => [s.id, s.name]));
  return rows.map((j) => jobView(j, names.get(j.stationId) ?? "Removed computer"));
}

// Print a failed or dropped job again (same file, same computer's current printer)
export async function retryJob(shop, id, user) {
  const j = await db.printJob.findFirst({ where: { shop, id: Number(id) } });
  if (!j) throw new PrintError("That print job couldn't be found.");
  if (!["failed", "expired"].includes(j.status)) throw new PrintError("Only failed or dropped jobs can be printed again.");
  if (!j.data) throw new PrintError("This job's file is no longer kept. Print it again from where it came from.");
  return queuePrint(shop, j.stationId, { role: j.role, kind: j.kind, title: j.title, format: j.format, bytes: j.data, copies: j.copies }, user);
}

// Test pages, made here so they don't depend on Shopify
export async function testPrint(shop, stationId, role, user) {
  const r = await stationReady(shop, stationId, role);
  if (!r.ready) return { fallback: r.reason, text: fallbackText(r) };
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const st = r.station;
  const slip = role === "slip";
  const size = slip && st.slipSize !== "4x6" ? [612, 792] : [288, 432];
  const doc = await PDFDocument.create();
  const page = doc.addPage(size);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const m = 18;
  page.drawRectangle({ x: m / 2, y: m / 2, width: size[0] - m, height: size[1] - m, borderWidth: 2 });
  let y = size[1] - 50;
  const line = (t, f = font, s = 12) => {
    page.drawText(t, { x: m + 6, y, size: s, font: f });
    y -= s + 8;
  };
  line("MonkeyBean", bold, 22);
  line(slip ? "Packing slip test" : "Label test", bold, 16);
  y -= 6;
  line(`Computer: ${st.name}`.slice(0, 44));
  line(`Printer: ${r.printer}`.slice(0, 44));
  line(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  y -= 10;
  line(slip ? "If this fills a sheet, slips print right." : "The box should sit just", font, 11);
  if (!slip) line("inside the label's edges.", font, 11);
  const bytes = await doc.save();
  return queuePrint(shop, st.id, { role, kind: slip ? "test-slip" : "test-label", title: `Test ${slip ? "slip" : "label"}`, format: "PDF", bytes }, user);
}

// ---------------------------------------------------------------------------
// The agent's side (token auth, plain-text replies the bash agent can read)
// ---------------------------------------------------------------------------

export function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
const lines = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${oneLine(v, 400)}`)
    .join("\n") + "\n";

export async function agentStation(request) {
  const m = String(request.headers.get("authorization") ?? "").match(/^Bearer\s+(mbp_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  return db.printStation.findUnique({ where: { tokenHash: sha(m[1]) } });
}

export async function pairAgent(code, host) {
  const c = String(code ?? "").trim().toUpperCase();
  const st = c ? await db.printStation.findUnique({ where: { pairHash: sha(c) } }) : null;
  if (!st || !st.pairExpiresAt || st.pairExpiresAt < new Date()) return text(lines({ error: "That install code isn't valid or has expired." }), 400);
  const token = newToken();
  await db.printStation.update({
    where: { id: st.id },
    data: { tokenHash: sha(token), pairHash: null, pairExpiresAt: null, host: oneLine(host, 80) || null, lastSeenAt: new Date() },
  });
  return text(lines({ token, station: st.name }));
}

export async function agentHello(st, form) {
  const printers = parsePrinters(form.get("printers"), form.get("default"), form.get("devices"));
  const data = {
    printers: JSON.stringify(printers),
    printersAt: new Date(),
    lastSeenAt: new Date(),
    wantHello: false,
    host: oneLine(form.get("host"), 80) || st.host,
    agentVersion: oneLine(form.get("version"), 10) || null,
    osVersion: oneLine(form.get("os"), 20) || null,
  };
  // First time: pick the obvious printers (the only label printer; the default ordinary one)
  const names = new Set(printers.map((p) => p.name));
  if (!st.labelPrinter || !names.has(st.labelPrinter)) {
    const thermal = printers.filter((p) => p.thermal);
    if (!st.labelPrinter && thermal.length === 1) data.labelPrinter = thermal[0].name;
  }
  if (!st.slipPrinter) {
    const plain = printers.filter((p) => !p.thermal);
    const pick = plain.find((p) => p.isDefault) ?? (plain.length === 1 ? plain[0] : null);
    if (pick) data.slipPrinter = pick.name;
  }
  await db.printStation.update({ where: { id: st.id }, data });
  return text(lines({ ok: 1, station: st.name, printers: printers.length }));
}

async function claimNext(stationId) {
  const fresh = new Date(Date.now() - JOB_TTL_MS);
  for (let tries = 0; tries < 3; tries++) {
    const j = await db.printJob.findFirst({ where: { stationId, status: "queued", createdAt: { gte: fresh } }, orderBy: { id: "asc" } });
    if (!j) return null;
    const got = await db.printJob.updateMany({ where: { id: j.id, status: "queued" }, data: { status: "printing", claimedAt: new Date() } });
    if (got.count) return j;
  }
  return null;
}

// Long poll: answers as soon as there's a job (or something to do), else after ~25 s
export async function agentNext(st, request, { waitMs = WAIT_MS } = {}) {
  const asked = new URL(request.url).searchParams.get("version");
  const version = asked === null ? null : Number(asked) || 0;
  await db.printStation.update({ where: { id: st.id }, data: { lastSeenAt: new Date(), ...(version !== null ? { agentVersion: String(version) } : {}) } });
  await tidy({ stationId: st.id });
  const update = version !== null && version < AGENT_VERSION ? 1 : null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const fresh = await db.printStation.findUnique({ where: { id: st.id } });
    if (!fresh) return text("error=removed\n", 401);
    const job = await claimNext(st.id);
    if (job) {
      return text(lines({ job: job.id, printer: job.printer, format: job.format, copies: job.copies, title: job.title, options: job.options, hello: fresh.wantHello ? 1 : null, update }));
    }
    if (fresh.wantHello || update) return text(lines({ hello: fresh.wantHello ? 1 : null, update }));
    const left = deadline - Date.now();
    if (left <= 0 || request.signal?.aborted) break;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        wake.off(`s${st.id}`, done);
        request.signal?.removeEventListener?.("abort", done);
        resolve();
      };
      const t = setTimeout(done, Math.min(left, 5000));
      wake.on(`s${st.id}`, done);
      request.signal?.addEventListener?.("abort", done);
    });
  }
  await db.printStation.update({ where: { id: st.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  return new Response(null, { status: 204 });
}

export async function agentFile(st, jobId) {
  const j = await db.printJob.findFirst({ where: { id: Number(jobId) || 0, stationId: st.id, status: "printing" } });
  if (!j?.data) return text("error=not found\n", 404);
  return new Response(j.data, {
    status: 200,
    headers: { "Content-Type": j.format === "ZPL" ? "application/octet-stream" : "application/pdf", "Cache-Control": "no-store" },
  });
}

export async function agentResult(st, form) {
  const id = Number(form.get("job")) || 0;
  const state = String(form.get("state") ?? "");
  if (!["printed", "waiting", "failed"].includes(state)) return text("error=bad state\n", 400);
  const message = oneLine(form.get("message"), 500) || null;
  const got = await db.printJob.updateMany({
    where: { id, stationId: st.id, status: { in: ["printing", "failed"] } },
    data: { status: state, message, doneAt: new Date(), ...(state === "printed" ? { data: null } : {}) },
  });
  await db.printStation.update({ where: { id: st.id }, data: { lastSeenAt: new Date() } });
  return text(lines({ ok: got.count ? 1 : 0 }));
}

// ---------------------------------------------------------------------------
// The scripts the Mac downloads
// ---------------------------------------------------------------------------

// Always Unix line endings (a Windows checkout may have added \r, which bash chokes on)
const lf = (s) => String(s).replace(/\r\n?/g, "\n");
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
export const scripts = {
  agent: () => lf(agentScript),
  install: (url) => lf(installTemplate).replace("APP_URL=__APP_URL__", `APP_URL=${shellQuote(url)}`),
  uninstall: () => lf(uninstallScript),
};
