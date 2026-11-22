// Tickets: statuses and email templates. Shared by the server and the page
// (no server-only code here), so the designer's preview matches what's sent.

export const STATUSES = ["open", "waiting", "closed"];
export const STATUS_LABELS = { open: "Open", waiting: "Waiting on customer", closed: "Closed" };

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// live: sent today. Others can be designed now and are sent once status-change
// emails are switched on in a later update.
export const TEMPLATES = [
  {
    key: "autoReply",
    name: "Auto-reply to new tickets",
    description: "Sent once when a new email becomes a ticket, in the same email conversation.",
    live: true,
    subject: "Re: {{ticket.subject}}",
    html:
      "<p>Hi {{customer.first_name | default: \"there\"}},</p>" +
      "<p>Thanks for contacting {{shop.name}}! We've received your message and opened ticket <b>#{{ticket.number}}</b>. " +
      "Someone from our team will reply as soon as we can.</p>" +
      "<p>If you need to add anything, just reply to this email.</p>" +
      "<p>{{shop.name}}</p>",
  },
  {
    key: "status.closed",
    name: "Status changed: Closed",
    description: "When a ticket is closed.",
    live: false,
    subject: "Re: {{ticket.subject}}",
    html: "<p>Hi {{customer.first_name | default: \"there\"}},</p><p>We've closed ticket #{{ticket.number}}. If there's anything else, just reply and it will reopen.</p><p>{{shop.name}}</p>",
  },
  {
    key: "status.open",
    name: "Status changed: Open",
    description: "When a ticket is reopened by staff.",
    live: false,
    subject: "Re: {{ticket.subject}}",
    html: "<p>Hi {{customer.first_name | default: \"there\"}},</p><p>We've reopened ticket #{{ticket.number}} and we're looking into it.</p><p>{{agent.name}}<br>{{shop.name}}</p>",
  },
];
export const templateDef = (key) => TEMPLATES.find((t) => t.key === key) ?? null;

export const VARIABLES = [
  { name: "customer.name", label: "Customer's full name", sample: "Jane Doe" },
  { name: "customer.first_name", label: "Customer's first name", sample: "Jane" },
  { name: "customer.email", label: "Customer's email", sample: "jane@example.com" },
  { name: "ticket.number", label: "Ticket number", sample: "1042" },
  { name: "ticket.subject", label: "Ticket subject", sample: "Where is my order?" },
  { name: "ticket.status", label: "Ticket status", sample: "Waiting on customer" },
  { name: "agent.name", label: "Staff member's name", sample: "Rosie Taylor" },
  { name: "shop.name", label: "Store name", sample: "Yiggybean" },
  { name: "today", label: "Today's date", sample: "November 21, 2026" },
];

export const sampleValues = () => Object.fromEntries(VARIABLES.map((v) => [v.name, v.sample]));

// The values for one ticket
export function ticketValues({ ticket, agentName = null, shopName = "Yiggybean", now = new Date() }) {
  const name = (ticket.customerName ?? "").trim();
  return {
    "customer.name": name,
    "customer.first_name": name ? name.split(/\s+/)[0] : "",
    "customer.email": ticket.customerEmail ?? "",
    "ticket.number": String(ticket.number ?? ""),
    "ticket.subject": ticket.subject ?? "",
    "ticket.status": STATUS_LABELS[ticket.status] ?? ticket.status ?? "",
    "agent.name": agentName ?? "",
    "shop.name": shopName,
    today: now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }),
  };
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// {{ name }} or {{ name | default: "fallback" }}. Unknown names stay as typed,
// so a typo is easy to spot in the preview. html: values are escaped.
const TOKEN = /\{\{\s*([a-z_][a-z0-9_.]*)\s*(?:\|\s*default\s*:\s*(?:"([^"]*)"|'([^']*)'|&quot;(.*?)&quot;))?\s*\}\}/gi;
export function renderTemplate(text, values, { html = false } = {}) {
  return String(text ?? "").replace(TOKEN, (whole, name, d1, d2, d3) => {
    if (!(name in values)) return whole;
    const v = String(values[name] ?? "").trim() || (d1 ?? d2 ?? d3 ?? "");
    return html ? escapeHtml(v) : v;
  });
}

// Names used in a template that aren't variables (shown as a warning)
export function unknownVariables(...texts) {
  const known = new Set(VARIABLES.map((v) => v.name));
  const bad = new Set();
  for (const t of texts) for (const m of String(t ?? "").matchAll(TOKEN)) if (!known.has(m[1])) bad.add(m[1]);
  return [...bad];
}
