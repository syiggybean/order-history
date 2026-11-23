import { createSign } from "node:crypto";
import nodemailer from "nodemailer";
import db from "./db.server";
import { emailDocument, isBlank, sanitizeHtml, textToHtml } from "./email-html.server";

// ---------------------------------------------------------------------------
// Tickets from the help@ mailbox
//
// Reads the mailbox through the Gmail API with the same Google service account
// MonkeyBean already uses for email (GOOGLE_SERVICE_ACCOUNT_JSON). In the Google
// Admin console, under Security → API controls → Domain-wide delegation, the
// service account's Client ID needs this scope added (next to gmail.send):
//
//   https://www.googleapis.com/auth/gmail.modify
//
// Optional in Railway:
//   HELPDESK_MAILBOX   the mailbox, default help@yiggybean.com
//   HELPDESK_FROM      how replies are signed, default "Yiggybean <help@yiggybean.com>"
//
// Every minute, mail that arrived in the inbox since tickets were switched on
// (and doesn't have the "MonkeyBean" label yet) becomes a ticket, or joins
// its ticket if it's a reply in the same Gmail conversation. Each imported
// email gets the "MonkeyBean" label, so it's never imported twice; nothing
// else about it changes (it stays in the inbox, read or unread as it was).
// Replies staff send from Gmail itself in a ticket's conversation are picked
// up too.
// ---------------------------------------------------------------------------

export class HelpdeskError extends Error {}

export const mailbox = () => (process.env.HELPDESK_MAILBOX || "help@yiggybean.com").trim().toLowerCase();
const fromLine = () => process.env.HELPDESK_FROM || `Yiggybean <${mailbox()}>`;
const LABEL = "MonkeyBean";
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const SYNC_EVERY_MS = 60_000;
const MAX_PER_RUN = 100;
const BODY_LIMIT = 200_000; // characters of text kept per email

import { STATUSES, TEMPLATES, renderTemplate, templateDef, ticketValues } from "./tickets";

export { STATUSES };

// ---------------------------------------------------------------------------
// Google access
// ---------------------------------------------------------------------------

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const key = JSON.parse(raw);
    if (!key.client_email || !key.private_key) return null;
    return { ...key, private_key: key.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

export function setupProblem() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return "Add GOOGLE_SERVICE_ACCOUNT_JSON in Railway (the Google service account MonkeyBean uses for email).";
  if (!serviceAccount()) return "GOOGLE_SERVICE_ACCOUNT_JSON isn't a valid service account key.";
  return null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
let cached = null; // { mailbox, token, expires }

async function token() {
  const box = mailbox();
  if (cached && cached.mailbox === box && cached.expires > Date.now() + 60_000) return cached.token;
  const key = serviceAccount();
  if (!key) throw new HelpdeskError(setupProblem());
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, sub: box, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const why = body.error_description || body.error || `HTTP ${res.status}`;
    const hint = /unauthorized_client|not authorized/i.test(why)
      ? ` MonkeyBean isn't allowed to read ${box} yet: in the Google Admin console (Security → API controls → Domain-wide delegation), add ${SCOPE} to the service account's scopes. It can take a few minutes to apply.`
      : /invalid_grant/i.test(why)
        ? ` Check that ${box} is a real mailbox in your Google Workspace (set HELPDESK_MAILBOX in Railway if it's a different one).`
        : "";
    throw new HelpdeskError(`Google sign-in for ${box} failed: ${why}.${hint}`);
  }
  cached = { mailbox: box, token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

let gmailFetch = null; // tests replace this

async function gmail(path, { method = "GET", body } = {}) {
  if (gmailFetch) return gmailFetch(path, { method, body });
  const res = await fetch(`${GMAIL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) cached = null;
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HelpdeskError(`Gmail: ${data?.error?.message ?? `HTTP ${res.status}`}`);
  return data;
}

// For tests
export function _setGmail(fn) {
  gmailFetch = fn;
}

async function labelId() {
  const { labels = [] } = await gmail("/labels");
  const found = labels.find((l) => l.name === LABEL);
  if (found) return found.id;
  const made = await gmail("/labels", { method: "POST", body: { name: LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" } });
  return made.id;
}

// ---------------------------------------------------------------------------
// Reading an email
// ---------------------------------------------------------------------------

const decode = (data) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "Jane Doe <jane@x.com>" → { name, email }
export function parseAddress(s) {
  const str = String(s ?? "").trim();
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  const e = str.match(/[^\s<>,;"]+@[^\s<>,;"]+/);
  return { name: null, email: e ? e[0].toLowerCase() : null };
}

// Contact-form emails (Shopify's "New customer message", sent by
// mailer@shopify.com) name the real customer in the body:
//   Name:\n Hannah Truong\n\n Email:\n hannah@example.com
// The ticket belongs to that person, so lookups and replies go to them.
const FORM_SENDERS = /^(mailer@shopify\.com)$/i;
export function formCustomer(fromEmail, text, replyTo = null) {
  const body = String(text ?? "");
  const fromForm = FORM_SENDERS.test(fromEmail ?? "");
  if (!fromForm && !/contact form/i.test(body)) return null;
  const field = (label) => body.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(?:\\r?\\n[ \\t]*)?([^\\r\\n]+)`, "im"))?.[1]?.trim() ?? null;
  let email = parseAddress(field("E-?mail(?: address)?") ?? "").email;
  if (!email && fromForm && replyTo) email = parseAddress(replyTo).email;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || FORM_SENDERS.test(email) || email === mailbox()) return null;
  const name = field("Name");
  return { email, name: name && !/@/.test(name) ? name.slice(0, 200) : null };
}

export function readMessage(msg) {
  const headers = {};
  for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  let plain = "";
  let html = "";
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    const type = (part.mimeType ?? "").toLowerCase();
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ name: part.filename, mime: part.mimeType ?? null, size: part.body.size ?? null, id: part.body.attachmentId });
      return;
    }
    if (type === "text/plain" && !plain) plain = decode(part.body?.data);
    else if (type === "text/html" && !html) html = decode(part.body?.data);
    for (const p of part.parts ?? []) walk(p);
  };
  walk(msg.payload);
  const text = (plain.trim() ? plain : htmlToText(html)).replace(/\r\n/g, "\n").slice(0, BODY_LIMIT);
  const from = parseAddress(headers.from);
  const formFrom = formCustomer(from.email, text, headers["reply-to"]);
  return {
    gmailId: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    from,
    to: headers.to ?? null,
    cc: headers.cc ?? null,
    subject: (headers.subject ?? "").trim() || "(no subject)",
    messageId: headers["message-id"] ?? null,
    references: headers.references ?? null,
    sentAt: msg.internalDate ? new Date(Number(msg.internalDate)) : headers.date ? new Date(headers.date) : new Date(),
    text,
    attachments,
    // A contact form is always a real person writing in, even if sent by a robot
    autoReply: !formFrom && /auto-replied|auto-generated/i.test(headers["auto-submitted"] ?? "") || /^(mailer-daemon|postmaster)@/i.test(from.email ?? ""),
    // Who the ticket is for: the sender, or the person who filled in a contact form
    customer: formFrom ?? from,
    // Mail that must never get an auto-reply back (other robots, lists,
    // newsletters). A contact form's auto-reply goes to the person who wrote it.
    noAutoReply: formFrom
      ? /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)[@+._-]/i.test(formFrom.email)
      : /^(?!no$)./i.test(headers["auto-submitted"] ?? "") ||
      /bulk|list|junk/i.test(headers.precedence ?? "") ||
      Boolean(headers["list-id"] || headers["list-unsubscribe"] || headers["x-autoreply"] || headers["x-autorespond"]) ||
      /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)[@+._-]/i.test(from.email ?? ""),
  };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

export async function getSync(shop) {
  return db.helpdeskSync.findUnique({ where: { shop } });
}

// Switch on: mail from now on becomes tickets
export async function connect(shop) {
  const problem = setupProblem();
  if (problem) throw new HelpdeskError(problem);
  const id = await labelId(); // also proves the mailbox can be read
  const now = new Date();
  await db.helpdeskSync.upsert({
    where: { shop },
    create: { shop, mailbox: mailbox(), enabledAt: now, labelId: id, lastError: null },
    update: { mailbox: mailbox(), enabledAt: now, labelId: id, lastError: null, pausedAt: null },
  });
  return syncNow(shop);
}

export async function pause(shop, paused) {
  await db.helpdeskSync.update({ where: { shop }, data: { pausedAt: paused ? new Date() : null } });
}

const running = new Map();
export function sync(shop) {
  if (running.has(shop)) return running.get(shop);
  const p = syncNow(shop).finally(() => running.delete(shop));
  running.set(shop, p);
  return p;
}

async function list(q, max) {
  const ids = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await gmail(`/messages?${params}`);
    for (const m of data.messages ?? []) ids.push(m);
    pageToken = data.nextPageToken ?? null;
  } while (pageToken && ids.length < max);
  return ids;
}

// Tickets that came in from a contact form before MonkeyBean read the form:
// move them to the customer named in it (once; cheap when there are none)
export async function fixFormTickets(shop) {
  const tickets = await db.ticket.findMany({ where: { shop, customerEmail: { in: ["mailer@shopify.com"] } } });
  let fixed = 0;
  for (const t of tickets) {
    const first = await db.ticketMessage.findFirst({ where: { shop, ticketId: t.id, kind: "email" }, orderBy: { sentAt: "asc" } });
    const c = first ? formCustomer(first.fromEmail, first.body) : null;
    if (!c) continue;
    await db.ticket.update({ where: { id: t.id }, data: { customerEmail: c.email, customerName: c.name ?? t.customerName } });
    fixed++;
  }
  return fixed;
}

async function syncNow(shop) {
  const s = await getSync(shop);
  if (!s?.enabledAt || s.pausedAt) return { skipped: true };
  try {
    await fixFormTickets(shop);
    const label = s.labelId ?? (await labelId());
    const after = Math.floor(s.enabledAt.getTime() / 1000);
    // New mail in the inbox
    const incoming = await list(`in:inbox -label:${LABEL} after:${after}`, MAX_PER_RUN);
    // Replies staff sent from Gmail in a ticket's conversation
    const sentAfter = Math.max(after, Math.floor(((s.lastSentScanAt ?? s.enabledAt).getTime() - 3600_000) / 1000));
    const sent = await list(`in:sent -label:${LABEL} after:${sentAfter}`, MAX_PER_RUN);

    let imported = 0;
    // Oldest first, so ticket numbers and threads come out in order
    const full = [];
    for (const m of incoming) full.push(readMessage(await gmail(`/messages/${m.id}?format=full`)));
    full.sort((a, b) => a.sentAt - b.sentAt);
    for (const m of full) {
      const done = await importMessage(shop, m, { outgoing: m.from.email === mailbox() });
      if (done) imported++;
      if (done === "created") await autoReply(shop, m).catch((e) => console.error(`[helpdesk] auto-reply:`, e?.message ?? e));
      await gmail(`/messages/${m.gmailId}/modify`, { method: "POST", body: { addLabelIds: [label] } });
    }
    const threads = new Set((await db.ticket.findMany({ where: { shop, gmailThreadId: { in: sent.map((m) => m.threadId) } }, select: { gmailThreadId: true } })).map((t) => t.gmailThreadId));
    for (const m of sent.filter((x) => threads.has(x.threadId))) {
      const msg = readMessage(await gmail(`/messages/${m.id}?format=full`));
      if (await importMessage(shop, msg, { outgoing: true })) imported++;
      await gmail(`/messages/${m.id}/modify`, { method: "POST", body: { addLabelIds: [label] } });
    }
    await db.helpdeskSync.update({ where: { shop }, data: { labelId: label, lastSyncAt: new Date(), lastSentScanAt: new Date(), lastError: null } });
    return { imported };
  } catch (e) {
    const message = e instanceof HelpdeskError ? e.message : `Couldn't read the mailbox: ${e?.message ?? e}`;
    await db.helpdeskSync.update({ where: { shop }, data: { lastError: message.slice(0, 1000), lastSyncAt: new Date() } }).catch(() => {});
    if (!(e instanceof HelpdeskError)) console.error(`[helpdesk] ${shop}:`, e);
    return { error: message };
  }
}

// One email onto its ticket (a new one for a new conversation). False if already there.
export async function importMessage(shop, m, { outgoing = false } = {}) {
  if (await db.ticketMessage.findFirst({ where: { shop, gmailMessageId: m.gmailId } })) return false;
  let ticket = await db.ticket.findFirst({ where: { shop, gmailThreadId: m.threadId } });
  let isNew = false;
  if (!ticket) {
    isNew = true;
    // Staff's own emails start no tickets; neither do bounces
    if (outgoing || m.autoReply) return false;
    const last = await db.ticket.findFirst({ where: { shop }, orderBy: { number: "desc" }, select: { number: true } });
    ticket = await db.ticket.create({
      data: {
        shop,
        number: (last?.number ?? 1000) + 1,
        subject: m.subject.slice(0, 500),
        status: "open",
        customerEmail: (m.customer ?? m.from).email,
        customerName: (m.customer ?? m.from).name,
        gmailThreadId: m.threadId,
        lastMessageAt: m.sentAt,
        lastInboundAt: m.sentAt,
        needsReply: true,
      },
    });
  }
  await db.ticketMessage.create({
    data: {
      shop,
      ticketId: ticket.id,
      kind: outgoing ? "reply" : "email",
      gmailMessageId: m.gmailId,
      messageIdHeader: m.messageId,
      referencesHeader: m.references,
      fromName: m.from.name,
      fromEmail: m.from.email,
      toLine: m.to,
      ccLine: m.cc,
      subject: m.subject.slice(0, 500),
      body: m.text,
      attachments: m.attachments.length ? JSON.stringify(m.attachments) : null,
      sentAt: m.sentAt,
    },
  });
  const later = !ticket.lastMessageAt || m.sentAt >= ticket.lastMessageAt;
  await db.ticket.update({
    where: { id: ticket.id },
    data: outgoing
      ? { ...(later ? { lastMessageAt: m.sentAt, needsReply: false } : {}) }
      : {
          lastInboundAt: m.sentAt,
          ...(later ? { lastMessageAt: m.sentAt, needsReply: true } : {}),
          // The customer wrote again: back to open
          ...(ticket.status !== "open" && !m.autoReply ? { status: "open", closedAt: null } : {}),
        },
  });
  return isNew ? "created" : true;
}

// ---------------------------------------------------------------------------
// Working tickets
// ---------------------------------------------------------------------------

const view = (t) => ({
  id: t.id,
  number: t.number,
  subject: t.subject,
  status: t.status,
  customerEmail: t.customerEmail,
  customerName: t.customerName,
  assigneeId: t.assigneeId,
  assigneeName: t.assigneeName,
  needsReply: t.needsReply,
  lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

export async function listTickets(shop, { status = "open", who = "all", q = "", userId = null, take = 200 } = {}) {
  const where = { shop };
  if (status === "active") where.status = { in: ["open", "waiting"] };
  else if (STATUSES.includes(status)) where.status = status;
  if (who === "mine") where.assigneeId = userId ?? -1;
  if (who === "unassigned") where.assigneeId = null;
  const text = String(q ?? "").trim();
  if (text) {
    const n = Number(text.replace(/^#/, ""));
    where.OR = [
      { subject: { contains: text, mode: "insensitive" } },
      { customerEmail: { contains: text, mode: "insensitive" } },
      { customerName: { contains: text, mode: "insensitive" } },
      ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : []),
    ];
  }
  const [rows, counts] = await Promise.all([
    db.ticket.findMany({ where, orderBy: { lastMessageAt: "desc" }, take }),
    db.ticket.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
  ]);
  return { tickets: rows.map(view), counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) };
}

export async function getTicket(shop, id) {
  const t = await db.ticket.findFirst({ where: { shop, id: Number(id) } });
  if (!t) return null;
  const messages = await db.ticketMessage.findMany({ where: { shop, ticketId: t.id }, orderBy: { sentAt: "asc" } });
  return {
    ...view(t),
    shopifyCustomerId: t.shopifyCustomerId,
    messages: messages.map((m) => ({
      id: m.id,
      kind: m.kind,
      fromName: m.fromName,
      fromEmail: m.fromEmail,
      to: m.toLine,
      cc: m.ccLine,
      body: m.body,
      // Our replies are HTML (cleaned again on the way out, to be safe)
      html: m.bodyHtml ? sanitizeHtml(m.bodyHtml, { email: m.kind === "auto" }) : null,
      staffName: m.staffName,
      staffId: m.staffId,
      editedAt: m.editedAt?.toISOString() ?? null,
      editedBy: m.editedBy ?? null,
      attachments: m.attachments ? JSON.parse(m.attachments).map(({ name, mime, size }, i) => ({ i, name, mime, size })) : [],
      sentAt: m.sentAt.toISOString(),
    })),
  };
}

async function ticketOr404(shop, id) {
  const t = await db.ticket.findFirst({ where: { shop, id: Number(id) } });
  if (!t) throw new HelpdeskError("That ticket doesn't exist.");
  return t;
}

export async function setStatus(shop, id, status) {
  if (!STATUSES.includes(status)) throw new HelpdeskError("Unknown status.");
  await ticketOr404(shop, id);
  await db.ticket.update({ where: { id: Number(id) }, data: { status, closedAt: status === "closed" ? new Date() : null } });
}

export async function assign(shop, id, staffId) {
  await ticketOr404(shop, id);
  if (!staffId) return db.ticket.update({ where: { id: Number(id) }, data: { assigneeId: null, assigneeName: null } });
  const member = await db.staffMember.findFirst({ where: { shop, id: Number(staffId) } });
  if (!member) throw new HelpdeskError("That staff member isn't in MonkeyBean.");
  await db.ticket.update({ where: { id: Number(id) }, data: { assigneeId: member.id, assigneeName: member.name ?? member.email } });
}

// Status and assignee together, from the ticket's Save button. Returns what changed.
export async function updateTicket(shop, id, { status, staffId }) {
  const t = await ticketOr404(shop, id);
  if (!STATUSES.includes(status)) throw new HelpdeskError("Unknown status.");
  const data = {};
  if (status !== t.status) Object.assign(data, { status, closedAt: status === "closed" ? new Date() : null });
  const nextAssignee = staffId ? Number(staffId) : null;
  if (nextAssignee !== (t.assigneeId ?? null)) {
    if (!nextAssignee) Object.assign(data, { assigneeId: null, assigneeName: null });
    else {
      const member = await db.staffMember.findFirst({ where: { shop, id: nextAssignee } });
      if (!member) throw new HelpdeskError("That staff member isn't in MonkeyBean.");
      Object.assign(data, { assigneeId: member.id, assigneeName: member.name ?? member.email });
    }
  }
  if (Object.keys(data).length) await db.ticket.update({ where: { id: t.id }, data });
  return { statusChanged: "status" in data, from: t.status, to: status, assigneeChanged: "assigneeId" in data };
}

export async function addNote(shop, id, text, user) {
  const body = String(text ?? "").trim();
  if (!body) throw new HelpdeskError("Write a note first.");
  await ticketOr404(shop, id);
  await db.ticketMessage.create({
    data: { shop, ticketId: Number(id), kind: "note", body: body.slice(0, BODY_LIMIT), staffName: user?.name ?? null, staffId: user?.id ?? null, sentAt: new Date() },
  });
}

// Staff who can see tickets, for the Assign menu
export async function assignees(shop) {
  const members = await db.staffMember.findMany({ where: { shop }, orderBy: { name: "asc" } });
  return members
    .filter((m) => {
      if (m.accountOwner) return true;
      try {
        const a = JSON.parse(m.access || "{}");
        return a.tickets && a.tickets !== "hidden";
      } catch {
        return false;
      }
    })
    .map((m) => ({ id: m.id, name: m.name ?? m.email ?? "Staff member" }));
}

// ---------------------------------------------------------------------------
// Replying (from the help@ mailbox, in the same Gmail conversation)
// ---------------------------------------------------------------------------

const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });

const reSubject = (s) => (/^re:/i.test(s) ? s : `Re: ${s}`);

// html: what staff wrote (cleaned here); their signature is added unless signature is false
export async function reply(shop, id, html, user, { status = "waiting", signature = true } = {}) {
  const message = sanitizeHtml(html);
  if (isBlank(message)) throw new HelpdeskError("Write a reply first.");
  const t = await ticketOr404(shop, id);
  const sig = signature && user?.id ? await getSignature(shop, user.id) : null;
  const full = sig && !isBlank(sig) ? `${message}<br><div class="signature">${sig}</div>` : message;
  const now = await sendInThread(shop, t, { html: full, kind: "reply", user });
  await db.ticket.update({
    where: { id: t.id },
    data: { lastMessageAt: now, needsReply: false, status: STATUSES.includes(status) ? status : "waiting", closedAt: status === "closed" ? now : null },
  });
}

// An email from the help mailbox in the ticket's conversation, recorded on the ticket
async function sendInThread(shop, t, { html, subject = null, kind, user = null, auto = false }) {
  if (!t.customerEmail) throw new HelpdeskError("This ticket has no customer email address to reply to.");
  const s = await getSync(shop);
  if (!s?.enabledAt) throw new HelpdeskError("Tickets aren't connected to the mailbox yet.");
  const text = htmlToText(html);
  // Thread it under the customer's latest email
  const lastIn = await db.ticketMessage.findFirst({ where: { shop, ticketId: t.id, kind: "email" }, orderBy: { sentAt: "desc" } });
  const refs = [lastIn?.referencesHeader, lastIn?.messageIdHeader].filter(Boolean).join(" ").trim() || undefined;
  const subj = (subject ?? "").trim() || reSubject(lastIn?.subject ?? t.subject);
  const { message: raw } = await composer.sendMail({
    from: fromLine(),
    to: t.customerName ? `"${t.customerName.replace(/"/g, "")}" <${t.customerEmail}>` : t.customerEmail,
    subject: subj,
    text,
    html: emailDocument(html),
    inReplyTo: lastIn?.messageIdHeader ?? undefined,
    references: refs,
    // Robots on the other end shouldn't answer an automatic email
    headers: auto ? { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" } : undefined,
  });
  const sent = await gmail("/messages/send", { method: "POST", body: { raw: b64url(raw), threadId: t.gmailThreadId } });
  const now = new Date();
  await db.ticketMessage.create({
    data: {
      shop,
      ticketId: t.id,
      kind,
      gmailMessageId: sent.id ?? null,
      fromName: user?.name ?? null,
      fromEmail: mailbox(),
      toLine: t.customerEmail,
      subject: subj.slice(0, 500),
      body: text,
      bodyHtml: html,
      staffName: user?.name ?? null,
      staffId: user?.id ?? null,
      sentAt: now,
    },
  });
  if (sent.id && s.labelId) await gmail(`/messages/${sent.id}/modify`, { method: "POST", body: { addLabelIds: [s.labelId] } }).catch(() => {});
  return now;
}

// ---------------------------------------------------------------------------
// Email templates (designed on the Tickets page; see tickets.js)
// ---------------------------------------------------------------------------

// Every new ticket gets one auto-reply. The cap only stops a mail loop with a
// robot that keeps opening new tickets (no real customer gets near it).
const AUTO_REPLY_LOOP_MAX = 10;
const AUTO_REPLY_LOOP_WINDOW_MS = 3600 * 1000;
const shopName = () => process.env.HELPDESK_SHOP_NAME || "Yiggybean";

export async function getTemplates(shop) {
  const rows = await db.ticketTemplate.findMany({ where: { shop } });
  return TEMPLATES.map((d) => {
    const r = rows.find((x) => x.key === d.key);
    return {
      key: d.key,
      name: d.name,
      description: d.description,
      live: d.live,
      subject: r?.subject ?? d.subject,
      html: r?.html ? sanitizeHtml(r.html, { email: true }) : d.html,
      enabled: Boolean(r?.enabled),
      updatedAt: r?.updatedAt?.toISOString() ?? null,
      updatedBy: r?.updatedBy ?? null,
      customized: Boolean(r),
    };
  });
}

async function template(shop, key) {
  return (await getTemplates(shop)).find((t) => t.key === key) ?? null;
}

export async function saveTemplate(shop, key, { subject, html, enabled }, user) {
  const def = templateDef(key);
  if (!def) throw new HelpdeskError("Unknown template.");
  const clean = sanitizeHtml(html, { maxLength: 100_000, email: true });
  if (isBlank(clean)) throw new HelpdeskError("The email needs some text.");
  const subj = String(subject ?? "").trim().slice(0, 300) || def.subject;
  const data = { subject: subj, html: clean, enabled: def.live ? Boolean(enabled) : false, updatedBy: user?.name ?? null };
  await db.ticketTemplate.upsert({ where: { shop_key: { shop, key } }, create: { shop, key, ...data }, update: data });
}

// Back to the original wording
export async function resetTemplate(shop, key) {
  await db.ticketTemplate.deleteMany({ where: { shop, key } });
}

// What a template looks like for a ticket (or the sample customer)
export function renderFor(tpl, ticket, { agentName } = {}) {
  const values = ticketValues({ ticket, agentName, shopName: shopName() });
  return { subject: renderTemplate(tpl.subject, values).replace(/\s+/g, " ").trim(), html: sanitizeHtml(renderTemplate(tpl.html, values, { html: true }), { email: true }) };
}

// The auto-reply for a brand-new ticket
async function autoReply(shop, m) {
  if (m.noAutoReply || m.autoReply || !m.from.email || m.from.email === mailbox()) return false;
  const tpl = await template(shop, "autoReply");
  if (!tpl?.enabled) return false;
  const t = await db.ticket.findFirst({ where: { shop, gmailThreadId: m.threadId } });
  if (!t) return false;
  // One per ticket
  if (await db.ticketMessage.findFirst({ where: { shop, ticketId: t.id, kind: "auto" } })) return false;
  const lastHour = await db.ticketMessage.count({
    where: { shop, kind: "auto", toLine: t.customerEmail, sentAt: { gte: new Date(Date.now() - AUTO_REPLY_LOOP_WINDOW_MS) } },
  });
  if (lastHour >= AUTO_REPLY_LOOP_MAX) {
    console.warn(`[helpdesk] auto-reply skipped for ticket #${t.number}: ${lastHour} sent to ${t.customerEmail} in the last hour (mail loop?)`);
    return false;
  }
  const { subject, html } = renderFor(tpl, t);
  await sendInThread(shop, t, { html, subject, kind: "auto", auto: true });
  return true;
}

// "Send a test to me": the template with the sample customer, to the staff member
export async function sendTest(shop, { subject, html }, user) {
  if (!user?.email) throw new HelpdeskError("MonkeyBean doesn't know your email address.");
  const s = await getSync(shop);
  if (!s?.enabledAt) throw new HelpdeskError("Connect the mailbox first: tests are sent from it.");
  const sample = { number: 1042, subject: "Where is my order?", status: "open", customerName: "Jane Doe", customerEmail: "jane@example.com" };
  const r = renderFor({ subject, html: sanitizeHtml(html, { email: true }) }, sample, { agentName: user.name });
  const { message: raw } = await composer.sendMail({
    from: fromLine(),
    to: user.email,
    subject: `[Test] ${r.subject}`,
    text: htmlToText(r.html),
    html: emailDocument(r.html),
  });
  await gmail("/messages/send", { method: "POST", body: { raw: b64url(raw) } });
  return user.email;
}

// ---------------------------------------------------------------------------
// Editing internal notes (the person who wrote it, or an admin)
// ---------------------------------------------------------------------------

export async function editNote(shop, messageId, text, user) {
  const body = String(text ?? "").trim();
  if (!body) throw new HelpdeskError("A note can't be empty.");
  const m = await db.ticketMessage.findFirst({ where: { shop, id: Number(messageId), kind: "note" } });
  if (!m) throw new HelpdeskError("That note doesn't exist.");
  if (!user?.isAdmin && m.staffId !== user?.id) throw new HelpdeskError("Only the person who wrote a note (or an app admin) can edit it.");
  await db.ticketMessage.update({ where: { id: m.id }, data: { body: body.slice(0, BODY_LIMIT), editedAt: new Date(), editedBy: user?.name ?? null } });
}

// ---------------------------------------------------------------------------
// Signatures: each staff member's own, added to their replies
// ---------------------------------------------------------------------------

export async function getSignature(shop, staffId) {
  if (!staffId) return null;
  const row = await db.ticketSignature.findFirst({ where: { shop, staffId: Number(staffId) } });
  return row?.html ? sanitizeHtml(row.html) : null;
}

export async function saveSignature(shop, staffId, html) {
  if (!staffId) throw new HelpdeskError("Signatures belong to a staff member; open MonkeyBean from Shopify admin.");
  const clean = sanitizeHtml(html, { maxLength: 20_000 });
  const value = isBlank(clean) ? "" : clean;
  await db.ticketSignature.upsert({
    where: { shop_staffId: { shop, staffId: Number(staffId) } },
    create: { shop, staffId: Number(staffId), html: value },
    update: { html: value },
  });
  return value;
}

export { textToHtml };

// An attachment, straight from Gmail (base64)
export async function attachment(shop, messageId, index) {
  const m = await db.ticketMessage.findFirst({ where: { shop, id: Number(messageId) } });
  const list = m?.attachments ? JSON.parse(m.attachments) : [];
  const a = list[Number(index)];
  if (!m?.gmailMessageId || !a) throw new HelpdeskError("That attachment isn't available.");
  const data = await gmail(`/messages/${m.gmailMessageId}/attachments/${a.id}`);
  return { name: a.name, mime: a.mime ?? "application/octet-stream", base64: Buffer.from(data.data ?? "", "base64url").toString("base64") };
}

// ---------------------------------------------------------------------------
// The customer in Shopify, and their recent orders
// ---------------------------------------------------------------------------

const CUSTOMER = `#graphql
  query TicketCustomer($q: String!) {
    customers(first: 1, query: $q) {
      nodes {
        id displayName email numberOfOrders
        amountSpent { amount currencyCode }
        tags
        orders(first: 5, reverse: true) {
          nodes {
            id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
            totalPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }
  }`;

export async function customerFor(shop, admin, email) {
  if (!email) return null;
  const res = await admin.graphql(CUSTOMER, { variables: { q: `email:"${String(email).replace(/"/g, "")}"` } });
  const body = await res.json();
  const c = body?.data?.customers?.nodes?.[0];
  if (!c) return null;
  const store = shop.replace(/\.myshopify\.com$/, "");
  const num = (gid) => String(gid).split("/").pop();
  return {
    id: c.id,
    name: c.displayName,
    email: c.email,
    orders: c.numberOfOrders != null ? Number(c.numberOfOrders) : null,
    spent: c.amountSpent ? `${Number(c.amountSpent.amount).toFixed(2)} ${c.amountSpent.currencyCode}` : null,
    tags: c.tags ?? [],
    url: `https://admin.shopify.com/store/${store}/customers/${num(c.id)}`,
    recent: (c.orders?.nodes ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      at: o.createdAt,
      paid: o.displayFinancialStatus,
      fulfilled: o.displayFulfillmentStatus,
      cancelled: Boolean(o.cancelledAt),
      total: o.totalPriceSet?.shopMoney ? `${Number(o.totalPriceSet.shopMoney.amount).toFixed(2)} ${o.totalPriceSet.shopMoney.currencyCode}` : null,
      url: `https://admin.shopify.com/store/${store}/orders/${num(o.id)}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Flyouts: a customer's full details, and one order's
// ---------------------------------------------------------------------------

const money = (m) => (m?.shopMoney ? `${Number(m.shopMoney.amount).toFixed(2)} ${m.shopMoney.currencyCode}` : null);
const adminUrl = (shop, kind, gid) => `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/${kind}/${String(gid).split("/").pop()}`;

const CUSTOMER_DETAIL = `#graphql
  query TicketCustomerDetail($id: ID!) {
    customer(id: $id) {
      id displayName email phone note tags createdAt numberOfOrders
      amountSpent { amount currencyCode }
      defaultAddress { formatted(withName: true) }
      orders(first: 25, reverse: true) {
        nodes {
          id name createdAt displayFinancialStatus displayFulfillmentStatus cancelledAt
          totalPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }
  }`;

export async function customerDetail(shop, admin, id) {
  if (!/^gid:\/\/shopify\/Customer\/\d+$/.test(String(id ?? ""))) throw new HelpdeskError("That customer can't be shown.");
  const res = await admin.graphql(CUSTOMER_DETAIL, { variables: { id } });
  const body = await res.json();
  if (body?.errors?.length) throw new HelpdeskError(`Shopify: ${body.errors.map((e) => e.message).join("; ")}`);
  const c = body?.data?.customer;
  if (!c) throw new HelpdeskError("That customer isn't in Shopify any more.");
  return {
    id: c.id,
    name: c.displayName,
    email: c.email,
    phone: c.phone,
    note: c.note,
    tags: c.tags ?? [],
    since: c.createdAt,
    orders: c.numberOfOrders != null ? Number(c.numberOfOrders) : null,
    spent: c.amountSpent ? `${Number(c.amountSpent.amount).toFixed(2)} ${c.amountSpent.currencyCode}` : null,
    address: c.defaultAddress?.formatted ?? [],
    url: adminUrl(shop, "customers", c.id),
    recent: (c.orders?.nodes ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      at: o.createdAt,
      paid: o.displayFinancialStatus,
      fulfilled: o.displayFulfillmentStatus,
      cancelled: Boolean(o.cancelledAt),
      total: money(o.totalPriceSet),
    })),
  };
}

const ORDER_DETAIL = `#graphql
  query TicketOrderDetail($id: ID!) {
    order(id: $id) {
      id name createdAt cancelledAt cancelReason displayFinancialStatus displayFulfillmentStatus note tags email
      customer { id displayName }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      shippingAddress { formatted(withName: true) }
      shippingLine { title }
      lineItems(first: 60) {
        nodes {
          id title variantTitle sku quantity currentQuantity
          image { url(transform: { maxWidth: 96, maxHeight: 96 }) }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        }
      }
      fulfillments(first: 10) {
        createdAt displayStatus
        trackingInfo(first: 5) { number url company }
      }
    }
  }`;

export async function orderDetail(shop, admin, id) {
  if (!/^gid:\/\/shopify\/Order\/\d+$/.test(String(id ?? ""))) throw new HelpdeskError("That order can't be shown.");
  const res = await admin.graphql(ORDER_DETAIL, { variables: { id } });
  const body = await res.json();
  if (body?.errors?.length) throw new HelpdeskError(`Shopify: ${body.errors.map((e) => e.message).join("; ")}`);
  const o = body?.data?.order;
  if (!o) throw new HelpdeskError("That order isn't in Shopify any more.");
  return {
    id: o.id,
    name: o.name,
    at: o.createdAt,
    cancelled: o.cancelledAt ? { at: o.cancelledAt, reason: o.cancelReason } : null,
    paid: o.displayFinancialStatus,
    fulfilled: o.displayFulfillmentStatus,
    note: o.note,
    tags: o.tags ?? [],
    email: o.email,
    customer: o.customer ? { id: o.customer.id, name: o.customer.displayName } : null,
    totals: {
      subtotal: money(o.subtotalPriceSet),
      shipping: money(o.totalShippingPriceSet),
      tax: money(o.totalTaxSet),
      discounts: Number(o.totalDiscountsSet?.shopMoney?.amount) > 0 ? money(o.totalDiscountsSet) : null,
      refunded: Number(o.totalRefundedSet?.shopMoney?.amount) > 0 ? money(o.totalRefundedSet) : null,
      total: money(o.totalPriceSet),
    },
    shipTo: o.shippingAddress?.formatted ?? [],
    shippingMethod: o.shippingLine?.title ?? null,
    items: (o.lineItems?.nodes ?? []).map((l) => ({
      id: l.id,
      title: l.title,
      variant: l.variantTitle && l.variantTitle !== "Default Title" ? l.variantTitle : null,
      sku: l.sku,
      qty: l.quantity,
      current: l.currentQuantity,
      image: l.image?.url ?? null,
      price: money(l.originalUnitPriceSet),
    })),
    fulfillments: (o.fulfillments ?? []).map((f) => ({
      at: f.createdAt,
      status: f.displayStatus,
      tracking: (f.trackingInfo ?? []).map((t) => ({ number: t.number, url: t.url, company: t.company })),
    })),
    url: adminUrl(shop, "orders", o.id),
    packing: await packingStatus(shop, o.id),
  };
}

// Where the order's unshipped parts are in MonkeyBean's Shipping: waiting,
// ready, or in which batch (by name)
const PACKING_LABELS = { waiting: "Waiting", ready: "Ready to ship", batched: "In a batch", packed: "Packed", labeling: "Getting a label" };
export async function packingStatus(shop, orderId) {
  const parts = await db.shipment.findMany({ where: { shop, orderId, state: { in: Object.keys(PACKING_LABELS) } }, orderBy: [{ partIndex: "asc" }, { id: "asc" }] });
  if (!parts.length) return [];
  const ids = [...new Set(parts.map((p) => p.batchId).filter(Boolean))];
  const batches = new Map((ids.length ? await db.batch.findMany({ where: { shop, id: { in: ids } } }) : []).map((b) => [b.id, b]));
  return parts.map((p) => {
    const b = p.batchId ? batches.get(p.batchId) : null;
    let lines = [];
    try {
      lines = JSON.parse(p.lines || "[]");
    } catch {
      lines = [];
    }
    return {
      part: p.partIndex,
      state: p.state,
      label: PACKING_LABELS[p.state] ?? p.state,
      waitingReason: p.state === "waiting" ? p.waitingReason : null,
      batch: b ? { id: b.id, tag: b.tag, name: b.name, title: b.name ? `${b.tag} · ${b.name}` : b.tag } : p.batchId ? { id: p.batchId, title: `Batch ${p.batchId}` } : null,
      items: lines.map((l) => ({ name: `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`, quantity: l.quantity })),
    };
  });
}

// ---------------------------------------------------------------------------
// Every minute
// ---------------------------------------------------------------------------

if (!globalThis.__helpdeskTimer && process.env.NODE_ENV !== "test") {
  const tick = async () => {
    const on = await db.helpdeskSync.findMany({ where: { enabledAt: { not: null }, pausedAt: null }, select: { shop: true } });
    for (const s of on) await sync(s.shop).catch(() => {});
  };
  globalThis.__helpdeskTimer = setInterval(() => tick().catch(() => {}), SYNC_EVERY_MS);
}
