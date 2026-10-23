import { mailFrom, sendNow } from "./mailer.server";
import { getSettings as getMailSettings } from "./preorder-notify.server";
import { PoError, getPoSettings, listLocations, markSent, poContacts, poDetail, poRecipients, splitEmails } from "./po.server";
import { DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, DEFAULT_TEMPLATE, DOC_CSS, FIELDS, linesTableHtml, sanitizeTemplate } from "./po-template";

// ---------------------------------------------------------------------------
// The PO document (from the template), as HTML, PDF, and email
// ---------------------------------------------------------------------------

// Every PO email is copied here, always. Not a setting on purpose.
export const PO_BCC = "zeni@yiggybean.com";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nl2br = (s) => esc(s).replace(/\n/g, "<br>");

export function money(n, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(Number(n) || 0);
}
const day = (iso, timeZone = "America/Los_Angeles") => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone, month: "long", day: "numeric", year: "numeric" }) : "");

// The values for {{fields}}. HTML-safe; multi-line text keeps its breaks.
export function fieldValues(po, { storeName = "", locationAddress = "", contacts = [] } = {}) {
  const to = poRecipients(contacts);
  const units = po.lines.reduce((t, l) => t + l.quantity, 0);
  return {
    po_number: esc(po.poNumber),
    po_date: day(po.openedAt ?? po.createdAt),
    created_date: day(po.createdAt),
    // A plain date (stored as midnight UTC)
    expected_date: po.expectedAt ? day(po.expectedAt, "UTC") : "",
    status: esc(po.status),
    supplier_name: esc(po.supplierName ?? ""),
    supplier_email: esc(po.supplierEmails ?? ""),
    // The contacts who get POs (names, emails)
    contact_name: esc(to.map((c) => c.name).filter(Boolean).join(" and ")),
    contact_email: esc(to.map((c) => c.email).join(", ")),
    supplier_address: nl2br(po.supplierAddress ?? ""),
    store_name: esc(storeName),
    ship_to: nl2br(locationAddress || po.locationName || ""),
    ship_to_name: esc(po.locationName ?? ""),
    supplier_note: nl2br(po.supplierNote ?? ""),
    subtotal: money(po.subtotal, po.currency),
    tax_total: money(po.taxTotal, po.currency),
    total: money(po.total, po.currency),
    currency: esc(po.currency),
    line_count: String(po.lines.length),
    total_quantity: String(units),
    line_items: linesTableHtml(po.lines, (n) => money(n, po.currency)),
  };
}

export function fillTemplate(template, values) {
  return String(template).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in values ? values[k] : m));
}



export async function renderPoHtml(shop, admin, poId, { forPrint = true } = {}) {
  const { po } = await poDetail(shop, poId);
  const settings = await getPoSettings(shop);
  let storeName = "";
  let locationAddress = "";
  if (admin) {
    try {
      const [shopRes, locs] = await Promise.all([admin.graphql(`#graphql
        query PoShopName { shop { name } }`).then((r) => r.json()), listLocations(admin)]);
      storeName = shopRes?.data?.shop?.name ?? "";
      locationAddress = locs.find((l) => l.id === po.locationId)?.address ?? "";
    } catch {
      // the document still renders without them
    }
  }
  const contacts = await poContacts(shop, po);
  const values = fieldValues(po, { storeName, locationAddress, contacts });
  const body = fillTemplate(sanitizeTemplate(settings.template || DEFAULT_TEMPLATE), values);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(po.poNumber)}</title><style>${DOC_CSS}</style></head><body>${body}</body></html>`;
  return { po, html, values, storeName, forPrint, contacts };
}

// ---------------------------------------------------------------------------
// PDF: headless Chromium (installed in the Docker image)
// ---------------------------------------------------------------------------

let browserPromise = null;
async function browser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const puppeteer = (await import("puppeteer-core")).default;
      const { existsSync } = await import("node:fs");
      // Alpine has called it both names over the years
      const executablePath = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));
      if (!executablePath) throw new Error("Chromium not found (set CHROMIUM_PATH)");
      return puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--font-render-hinting=none"] });
    })().catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

export async function htmlToPdf(html) {
  const b = await browser();
  const page = await b.newPage();
  try {
    // No network: the document is self-contained (images are data URLs or https)
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function poPdf(shop, admin, poId) {
  const { po, html } = await renderPoHtml(shop, admin, poId);
  let pdf;
  try {
    pdf = await htmlToPdf(html);
  } catch (e) {
    console.error("[po] PDF:", e?.message ?? e);
    throw new PoError("The PDF couldn't be made on the server. Check that Chromium is installed in the Docker image (see the Dockerfile).");
  }
  return { po, pdf, filename: `${po.poNumber}${po.supplierName ? ` - ${po.supplierName}` : ""}.pdf`.replace(/[\\/:*?"<>|]/g, "-") };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export async function emailDefaults(shop, admin, poId) {
  const settings = await getPoSettings(shop);
  const { po, values, contacts } = await renderPoHtml(shop, admin, poId);
  const plain = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).replace(/<br>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")]));
  delete plain.line_items;
  return {
    to: poRecipients(contacts).map((c) => c.email).join(", ") || po.supplierEmails || "",
    // Everyone at the supplier, to choose from
    contacts: contacts.filter((c) => c.email),
    subject: fillTemplate(settings.emailSubject || DEFAULT_EMAIL_SUBJECT, plain),
    body: fillTemplate(settings.emailBody || DEFAULT_EMAIL_BODY, plain),
    bcc: PO_BCC,
  };
}

export async function emailPo(shop, admin, poId, { to, cc, subject, body }, user) {
  const toList = splitEmails(to);
  const ccList = splitEmails(cc);
  const bad = [...toList, ...ccList].filter((e) => !/^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s.]{2,}$/.test(e));
  if (!toList.length) throw new PoError("Add the supplier's email address.");
  if (bad.length) throw new PoError(`Not a valid email: ${bad.join(", ")}`);
  const subj = String(subject ?? "").trim().slice(0, 300);
  if (!subj) throw new PoError("Add a subject.");
  const text = String(body ?? "").slice(0, 20000);
  const { po, pdf, filename } = await poPdf(shop, admin, poId);
  const mail = await getMailSettings(shop);
  await sendNow({
    from: mailFrom(mail.fromName),
    to: toList.join(", "),
    ...(ccList.length ? { cc: ccList.join(", ") } : {}),
    // Always, whatever was typed
    bcc: PO_BCC,
    ...(user?.email ? { replyTo: user.email } : {}),
    subject: subj,
    text,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${nl2br(text)}</div>`,
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  });
  await markSent(shop, po.id, { how: "email", to: [...toList, ...ccList].join(", ") }, user);
  return { to: toList, cc: ccList, bcc: PO_BCC };
}

export { FIELDS };
export const emailFieldList = FIELDS.filter((f) => f.key !== "line_items");
