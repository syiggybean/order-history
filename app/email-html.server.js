// Cleaning HTML that staff write (ticket replies and signatures) before it's
// stored, shown in MonkeyBean or emailed: only simple formatting survives.
//
// Kept: paragraphs and line breaks, bold/italic/underline, lists, quotes,
// headings, links (http, https, mailto, tel) and images from https addresses.
// Everything else (scripts, styles, event handlers, forms, iframes…) is removed.

const KEEP = new Set(["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "a", "img", "hr", "small", "sub", "sup"]);
const VOID = new Set(["br", "img", "hr"]);
const DROP_WITH_CONTENT = /<(script|style|head|title|iframe|object|embed|noscript|template|svg|math|form|select|textarea|button)\b[\s\S]*?<\/\1\s*>/gi;

const escapeAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!m) return null;
  return (m[2] ?? m[3] ?? m[4] ?? "").replace(/&amp;/g, "&").trim();
}

const safeUrl = (u, schemes) => {
  const v = String(u ?? "").replace(/[\u0000-\u001f\s]+/g, "");
  return schemes.some((s) => v.toLowerCase().startsWith(s)) ? v : null;
};

export function sanitizeHtml(input, { maxLength = 200_000 } = {}) {
  let html = String(input ?? "").slice(0, maxLength);
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(DROP_WITH_CONTENT, "").replace(/<(script|style)\b[^>]*>/gi, "");
  const open = [];
  let out = "";
  let last = 0;
  const tag = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = tag.exec(html))) {
    out += escapeText(html.slice(last, m.index));
    last = tag.lastIndex;
    const name = m[1].toLowerCase();
    const closing = m[0][1] === "/";
    if (!KEEP.has(name)) continue;
    if (closing) {
      if (VOID.has(name)) continue;
      const i = open.lastIndexOf(name);
      if (i < 0) continue;
      // Close anything left open inside it
      while (open.length > i) out += `</${open.pop()}>`;
      continue;
    }
    const attrs = m[2] ?? "";
    if (name === "a") {
      const href = safeUrl(attr(attrs, "href"), ["https://", "http://", "mailto:", "tel:"]);
      out += href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">` : "<a>";
      open.push("a");
      continue;
    }
    if (name === "img") {
      const src = safeUrl(attr(attrs, "src"), ["https://"]);
      if (!src) continue;
      const alt = attr(attrs, "alt");
      const w = Number(attr(attrs, "width"));
      const h = Number(attr(attrs, "height"));
      out += `<img src="${escapeAttr(src)}"${alt ? ` alt="${escapeAttr(alt)}"` : ' alt=""'}${w > 0 && w <= 2000 ? ` width="${Math.round(w)}"` : ""}${h > 0 && h <= 2000 ? ` height="${Math.round(h)}"` : ""} style="max-width:100%;height:auto">`;
      continue;
    }
    if (VOID.has(name)) {
      out += `<${name}>`;
      continue;
    }
    out += `<${name}>`;
    open.push(name);
  }
  out += escapeText(html.slice(last));
  while (open.length) out += `</${open.pop()}>`;
  return out.trim();
}

// Text between tags: stray < and > become safe; entities already there stay
function escapeText(s) {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;");
}

// Is there anything in it besides empty tags and spaces?
export const isBlank = (html) => !String(html ?? "").replace(/<(?!img)[^>]*>/gi, "").replace(/&nbsp;/g, " ").trim() && !/<img/i.test(String(html ?? ""));

// Plain text into simple HTML (older replies, or a text-only signature)
export const textToHtml = (text) =>
  String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

// The whole email body around a reply
export function emailDocument(innerHtml) {
  return `<!doctype html><html><body><div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${innerHtml}</div></body></html>`;
}
