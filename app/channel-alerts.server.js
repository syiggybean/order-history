import db from "./db.server";
import { mailConfigured, mailFrom, sendNow } from "./mailer.server";

// ---------------------------------------------------------------------------
// Email when products are taken off a sales channel.
//
// Removals noticed from the moment alerts were set up (not the year of past
// changes read from Shopify's log). Removals close together are sent as one
// email: it goes once nothing new has turned up for a few minutes, after
// giving Shopify's log a moment to say who did it.
// ---------------------------------------------------------------------------

export const DEFAULT_RECIPIENTS = "zeni@yiggybean.com, rosie@yiggybean.com";
const QUIET_MS = 5 * 60 * 1000; // nothing new for this long: send
const WHO_WAIT_MS = 10 * 60 * 1000; // wait this long for Shopify's log to say who
const MAX_WAIT_MS = 20 * 60 * 1000; // never hold one longer than this
const RECENT_MS = 24 * 3600 * 1000; // older removals (from the log) aren't news
const MAX_LIST = 200;

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function parseRecipients(text) {
  const list = String(text ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = list.filter((s) => !EMAIL.test(s));
  return { list: [...new Set(list.filter((s) => EMAIL.test(s)))], bad };
}

export async function getAlertSettings(shop) {
  return db.channelAlertSettings.upsert({
    where: { shop },
    create: { shop, enabled: true, recipients: DEFAULT_RECIPIENTS },
    update: {},
  });
}

export async function saveAlertSettings(shop, { enabled, recipients }) {
  const { list, bad } = parseRecipients(recipients);
  if (bad.length) return { error: `Not an email address: ${bad.join(", ")}` };
  if (enabled && !list.length) return { error: "Add at least one email address, or turn the emails off." };
  await getAlertSettings(shop);
  const s = await db.channelAlertSettings.update({ where: { shop }, data: { enabled: Boolean(enabled), recipients: list.join(", ") } });
  return { ok: true, settings: view(s) };
}

export const view = (s) => ({
  enabled: s.enabled,
  recipients: s.recipients,
  lastSentAt: s.lastSentAt?.toISOString() ?? null,
  lastError: s.lastError ?? null,
  mailReady: mailConfigured(),
});

// Removals waiting to be emailed
function pendingWhere(shop, s, now) {
  return {
    shop,
    subject: "channel",
    action: "removed",
    hidden: false,
    alertedAt: null,
    createdAt: { gte: s.startedAt },
    occurredAt: { gte: new Date(now - RECENT_MS) },
  };
}

// Is this batch ready to go?
export function ready(rows, now = Date.now()) {
  if (!rows.length) return false;
  const created = rows.map((r) => r.createdAt.getTime());
  const oldest = Math.min(...created);
  const newest = Math.max(...created);
  if (now - oldest >= MAX_WAIT_MS) return true;
  if (now - newest < QUIET_MS) return false;
  // Still waiting on who did some of them?
  return rows.every((r) => r.staffName || r.appName || r.eventId || now - r.createdAt.getTime() >= WHO_WAIT_MS);
}

const fmt = (d) =>
  new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function compose(shop, rows) {
  const store = shop.replace(/\.myshopify\.com$/, "");
  const channels = [...new Set(rows.map((r) => r.channel ?? "a sales channel"))];
  const n = rows.length;
  const what = n === 1 ? (rows[0].productTitle ?? "A product") : `${n} products`;
  const subject = `${what} removed from ${channels.length === 1 ? channels[0] : `${channels.length} sales channels`}`;
  const whoOf = (r) => (r.staffName && r.appName ? `${r.staffName} · ${r.appName}` : r.staffName ?? r.appName ?? "Unknown (not in Shopify's log)");
  const whenOf = (r) => (r.earliest ? `between ${fmt(r.earliest)} and ${fmt(r.occurredAt)}` : fmt(r.occurredAt));
  const link = (r) => (r.productId ? `https://admin.shopify.com/store/${store}/products/${r.productId.split("/").pop()}` : null);
  const sorted = [...rows].sort((a, b) => a.occurredAt - b.occurredAt).slice(0, MAX_LIST);
  const more = n - sorted.length;

  const text = [
    `${n === 1 ? "A product was" : `${n} products were`} taken off a sales channel:`,
    "",
    ...sorted.map((r) => `- ${r.productTitle ?? "A product (name not recorded)"}: removed from ${r.channel ?? "a sales channel"}, ${whenOf(r)}, by ${whoOf(r)}${link(r) ? `\n  ${link(r)}` : ""}`),
    ...(more > 0 ? [`…and ${more} more. See MonkeyBean → Inventory history.`] : []),
    "",
    "Full list: MonkeyBean → Inventory history → Show: Removed from a sales channel.",
  ].join("\n");

  const td = 'style="padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top"';
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a">
<p>${n === 1 ? "A product was" : `${n} products were`} taken off a sales channel.</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><th ${td} align="left">Product</th><th ${td} align="left">Removed from</th><th ${td} align="left">When</th><th ${td} align="left">Who</th></tr>
${sorted
  .map(
    (r) =>
      `<tr><td ${td}>${link(r) ? `<a href="${esc(link(r))}" style="color:#005bd3">${esc(r.productTitle ?? "A product (name not recorded)")}</a>` : esc(r.productTitle ?? "A product (name not recorded)")}${r.sku ? `<br><span style="color:#666;font-size:12px">${esc(r.sku)}</span>` : ""}</td><td ${td}>${esc(r.channel ?? "A sales channel")}</td><td ${td}>${esc(whenOf(r))}</td><td ${td}>${esc(whoOf(r))}</td></tr>`,
  )
  .join("\n")}
</table>
${more > 0 ? `<p>…and ${more} more.</p>` : ""}
<p style="color:#555">Full list: MonkeyBean → Inventory history → Show: Removed from a sales channel. To change who gets these emails, use the settings there.</p>
</div>`;
  return { subject, text, html };
}

// One shop: send what's ready
export async function sendAlerts(shop, { now = Date.now(), send = sendNow } = {}) {
  const s = await getAlertSettings(shop);
  if (!s.enabled) return { skipped: "off" };
  const { list } = parseRecipients(s.recipients);
  if (!list.length) return { skipped: "no recipients" };
  const rows = await db.catalogEvent.findMany({ where: pendingWhere(shop, s, now), orderBy: { createdAt: "asc" }, take: 1000 });
  if (!ready(rows, now)) return { waiting: rows.length };
  const message = compose(shop, rows);
  try {
    await send({ from: mailFrom("MonkeyBean"), to: list.join(", "), ...message });
  } catch (e) {
    await db.channelAlertSettings.update({ where: { shop }, data: { lastError: String(e?.message ?? e).slice(0, 500) } });
    return { error: e?.message ?? String(e) };
  }
  await db.catalogEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { alertedAt: new Date(now) } });
  await db.channelAlertSettings.update({ where: { shop }, data: { lastSentAt: new Date(now), lastError: null } });
  return { sent: rows.length };
}

if (!globalThis.__channelAlertTimer && process.env.NODE_ENV !== "test") {
  const tick = async () => {
    const sessions = await db.session.findMany({ where: { isOnline: false }, select: { shop: true } });
    for (const shop of new Set(sessions.map((x) => x.shop))) {
      await sendAlerts(shop).catch((e) => console.error(`[channel alerts] ${shop}:`, e?.message ?? e));
    }
  };
  globalThis.__channelAlertTimer = setInterval(() => tick().catch(() => {}), 2 * 60 * 1000);
}
