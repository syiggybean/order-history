import { createSign } from "node:crypto";
import nodemailer from "nodemailer";
import db from "./db.server";

// ---------------------------------------------------------------------------
// Sending email through the store's Google Workspace mailbox
//
// Two ways, set in Railway (the service account is used if both are set):
//
// 1. Google service account (no 2-Step Verification needed)
//    GOOGLE_SERVICE_ACCOUNT_JSON  the service account's JSON key, pasted whole
//    MAIL_SENDER                  the Workspace mailbox to send as, e.g. preorders@yiggybean.com
//    The service account needs domain-wide delegation for the scope
//    https://www.googleapis.com/auth/gmail.send (Google Admin console).
//
// 2. SMTP with an App password
//    SMTP_USER / SMTP_PASS        mailbox and its App password
//    SMTP_HOST / SMTP_PORT        optional, default smtp.gmail.com / 465
//
// Either way:
//   MAIL_FROM          optional display name and address, e.g. "Yiggybean <preorders@yiggybean.com>"
//   MAIL_DAILY_LIMIT   optional, default 1800 (Workspace allows 2,000 a day)
//
// Emails wait in the EmailSend table and go out a few at a time, so a big
// batch never trips Google's limits. Anything over the daily limit simply
// waits until the next day.
// ---------------------------------------------------------------------------

const DAILY_LIMIT = Number(process.env.MAIL_DAILY_LIMIT) || 1800;
const GAP_MS = Number(process.env.MAIL_GAP_MS ?? 1500); // between emails
const BATCH = 20; // per run
const MAX_ATTEMPTS = 4;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const key = JSON.parse(raw);
    if (!key.client_email || !key.private_key) return null;
    // Keys pasted with literal "\n" sequences still work
    return { ...key, private_key: key.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

export const mailMethod = () =>
  serviceAccount() && process.env.MAIL_SENDER
    ? "gmail-api"
    : process.env.SMTP_USER && process.env.SMTP_PASS
      ? "smtp"
      : null;
export const mailConfigured = () => Boolean(mailMethod());
const senderAddress = () => (mailMethod() === "gmail-api" ? process.env.MAIL_SENDER : process.env.SMTP_USER);

export function mailFrom(fromName) {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  return `${fromName || "Yiggybean"} <${senderAddress()}>`;
}

// What's wrong with the email settings, in plain words (null = looks fine)
export function mailSetupProblem() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !serviceAccount())
    return "GOOGLE_SERVICE_ACCOUNT_JSON isn't a valid service account key. Paste the whole JSON file's contents.";
  if (serviceAccount() && !process.env.MAIL_SENDER) return "Add MAIL_SENDER: the mailbox to send as, e.g. preorders@yiggybean.com.";
  return null;
}

// ---------------------------------------------------------------------------
// Gmail API: a signed token for the mailbox, then one HTTPS call per email
// ---------------------------------------------------------------------------

const b64url = (buf) => Buffer.from(buf).toString("base64url");
let cachedToken = null; // { token, expires }

async function gmailToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const key = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: process.env.MAIL_SENDER, // the mailbox the service account acts for
      scope: GMAIL_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
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
      ? " The service account isn't allowed to send as this mailbox yet: add its Client ID with the gmail.send scope under Domain-wide delegation in the Google Admin console (it can take a few minutes to apply)."
      : /invalid_grant/i.test(why)
        ? " Check MAIL_SENDER is a real mailbox in your Google Workspace."
        : "";
    const err = new Error(`Google sign-in failed: ${why}.${hint}`);
    err.setup = true;
    throw err;
  }
  cachedToken = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

// Turns a message ({ from, to, subject, html, text, headers }) into raw MIME
const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });

const gmailTransport = {
  async sendMail(message) {
    const { message: raw } = await composer.sendMail(message);
    const token = await gmailToken();
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: b64url(raw) }),
    });
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "";
    const err = new Error(`Gmail refused the email: ${body?.error?.message ?? `HTTP ${res.status}`}${reason ? ` (${reason})` : ""}`);
    if (res.status === 401) cachedToken = null;
    // Same meaning as SMTP codes, so retries work the same way:
    // 4xx from the recipient's side is permanent, limits and Google hiccups aren't
    if (res.status === 429 || /rateLimit|dailyLimit|quota/i.test(reason)) err.message += " — sending limit reached";
    else if (res.status === 400) err.responseCode = 550;
    throw err;
  },
};

let transport = null;
function getTransport() {
  if (!transport) {
    if (mailMethod() === "gmail-api") {
      transport = gmailTransport;
    } else {
      const port = Number(process.env.SMTP_PORT) || 465;
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port,
        secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        pool: true,
        maxConnections: 1,
      });
    }
  }
  return transport;
}

// For tests: replace the real sender, forget the Google token
export function setTransportForTests(t) {
  transport = t;
  cachedToken = null;
}

// Sends one email straight away (for "Send a test email")
export async function sendNow(message) {
  if (!mailConfigured()) {
    throw new Error(
      mailSetupProblem() ??
        "Email isn't set up yet: add GOOGLE_SERVICE_ACCOUNT_JSON and MAIL_SENDER in Railway (or SMTP_USER and SMTP_PASS).",
    );
  }
  await getTransport().sendMail(message);
}

export async function sentInLastDay() {
  return db.emailSend.count({ where: { status: "sent", sentAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } });
}

export async function mailStatus() {
  const [sentToday, queued, failed] = await Promise.all([
    sentInLastDay(),
    db.emailSend.count({ where: { status: "queued" } }),
    db.emailSend.count({ where: { status: "failed" } }),
  ]);
  return {
    configured: mailConfigured(),
    method: mailMethod(),
    problem: mailSetupProblem() ?? lastSetupError,
    from: mailConfigured() ? mailFrom() : null,
    dailyLimit: DAILY_LIMIT,
    sentToday,
    queued,
    failed,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = false;
let lastSetupError = null;

// Sends what's waiting. render(send) returns { subject, html, text, headers }.
export async function deliverQueued(render, { gapMs = GAP_MS } = {}) {
  if (running || !mailConfigured()) return 0;
  running = true;
  let sent = 0;
  try {
    const room = DAILY_LIMIT - (await sentInLastDay());
    if (room <= 0) return 0;
    const due = await db.emailSend.findMany({
      where: { status: "queued", nextTryAt: { lte: new Date() } },
      orderBy: { id: "asc" },
      take: Math.min(BATCH, room),
    });
    for (const send of due) {
      let message;
      try {
        message = await render(send);
      } catch (e) {
        await db.emailSend.update({ where: { id: send.id }, data: { status: "failed", error: `Couldn't build the email: ${e.message}` } });
        continue;
      }
      if (!message) {
        await db.emailSend.update({ where: { id: send.id }, data: { status: "skipped" } });
        continue;
      }
      try {
        await getTransport().sendMail({ from: message.from, to: send.email, ...message });
        await db.emailSend.update({ where: { id: send.id }, data: { status: "sent", sentAt: new Date(), error: null } });
        lastSetupError = null;
        sent++;
      } catch (e) {
        const attempts = send.attempts + 1;
        const msg = String(e?.response ?? e?.message ?? e).slice(0, 500);
        // Settings problem (e.g. delegation not set up yet): nothing will send,
        // so leave everything waiting and try again in 10 minutes
        if (e?.setup) {
          await db.emailSend.update({
            where: { id: send.id },
            data: { error: msg, nextTryAt: new Date(Date.now() + 10 * 60 * 1000) },
          });
          lastSetupError = msg;
          break;
        }
        // Mailbox doesn't exist: no point retrying
        const permanent = /^5\d\d/.test(String(e?.responseCode ?? "")) && !/limit|quota|rate/i.test(msg);
        await db.emailSend.update({
          where: { id: send.id },
          data: {
            attempts,
            error: msg,
            status: permanent || attempts >= MAX_ATTEMPTS ? "failed" : "queued",
            nextTryAt: new Date(Date.now() + attempts * 10 * 60 * 1000),
          },
        });
        // Google says we've sent too much: stop for now
        if (/limit|quota|rate/i.test(msg)) break;
      }
      if (gapMs) await sleep(gapMs);
    }
  } finally {
    running = false;
  }
  return sent;
}
