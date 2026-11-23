// Cleaning HTML that staff write (ticket replies, signatures and email
// templates) before it's stored, shown in MonkeyBean or emailed. Shared by the
// server and the template designer, so its preview is exactly what's sent.
//
// Kept: paragraphs and line breaks, bold/italic/underline, lists, quotes,
// headings, links (http, https, mailto, tel) and images from https addresses.
// Everything else (scripts, styles, event handlers, forms, iframes…) is removed.
//
// { email: true } (templates) also keeps what designed emails are made of:
// tables, inline styles, colors, alignment and sizes. Still no <style> blocks,
// scripts or event handlers, and no positioning that could cover the page.

const KEEP = new Set(["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "a", "img", "hr", "small", "sub", "sup"]);
const VOID = new Set(["br", "img", "hr", "col"]);
const EMAIL_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "center", "font", "h5", "h6", "pre", "code"]);
const EMAIL_ATTRS = new Set(["style", "align", "valign", "width", "height", "bgcolor", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "role", "dir", "color", "face", "size", "title", "lang"]);
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

// Inline CSS: plain declarations only
const BAD_CSS = /expression|javascript:|vbscript:|behavior|binding|@import|[\\<>]/i;
const BAD_PROPS = /^(position|z-index|inset|top|left|right|bottom|transform|filter|cursor|pointer-events|content)$/;
export function cleanStyle(style) {
  return String(style ?? "")
    .split(";")
    .map((d) => {
      const i = d.indexOf(":");
      if (i < 0) return null;
      const prop = d.slice(0, i).trim().toLowerCase();
      const value = d.slice(i + 1).trim();
      if (!/^-?[a-z][a-z-]*$/.test(prop) || BAD_PROPS.test(prop) || !value || BAD_CSS.test(value)) return null;
      // Images in CSS only from https addresses
      for (const m of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (!/^https:\/\//i.test(m[2])) return null;
      if (/url\(/i.test(value) && !/url\(\s*['"]?https:/i.test(value)) return null;
      return `${prop}: ${value}`;
    })
    .filter(Boolean)
    .join("; ");
}

function allAttrs(attrs) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrs))) out.push([m[1].toLowerCase(), (m[3] ?? m[4] ?? m[5] ?? "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")]);
  return out;
}

// The design attributes kept on a tag in email mode
function emailAttrs(attrs) {
  let out = "";
  for (const [name, raw] of allAttrs(attrs)) {
    if (!EMAIL_ATTRS.has(name)) continue;
    let v = raw.trim();
    if (name === "style") v = cleanStyle(v);
    else if (["width", "height", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "size"].includes(name)) v = /^\d{1,4}%?$/.test(v) ? v : "";
    else if (["bgcolor", "color"].includes(name)) v = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(v) ? v : "";
    else if (["align", "valign", "dir", "role"].includes(name)) v = /^[a-z-]{1,20}$/i.test(v) ? v : "";
    else v = v.slice(0, 200);
    if (v) out += ` ${name}="${escapeAttr(v)}"`;
  }
  return out;
}

export function sanitizeHtml(input, { maxLength = 200_000, email = false } = {}) {
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
    if (!KEEP.has(name) && !(email && EMAIL_TAGS.has(name))) continue;
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
      const extra = email ? emailAttrs(attrs) : "";
      out += href ? `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer"${extra}>` : `<a${extra}>`;
      open.push("a");
      continue;
    }
    if (name === "img") {
      const src = safeUrl(attr(attrs, "src"), ["https://"]);
      if (!src) continue;
      const alt = attr(attrs, "alt");
      const w = Number(attr(attrs, "width"));
      const h = Number(attr(attrs, "height"));
      const own = email ? cleanStyle(attr(attrs, "style")) : "";
      const align = email && /^(left|right|center|middle|top|bottom)$/i.test(attr(attrs, "align") ?? "") ? ` align="${attr(attrs, "align").toLowerCase()}"` : "";
      out += `<img src="${escapeAttr(src)}"${alt ? ` alt="${escapeAttr(alt)}"` : ' alt=""'}${w > 0 && w <= 2000 ? ` width="${Math.round(w)}"` : ""}${h > 0 && h <= 2000 ? ` height="${Math.round(h)}"` : ""}${align} style="${escapeAttr(own ? `${own}; max-width:100%` : "max-width:100%;height:auto")}">`;
      continue;
    }
    const extra = email ? emailAttrs(attrs) : "";
    if (VOID.has(name)) {
      out += `<${name}${extra}>`;
      continue;
    }
    out += `<${name}${extra}>`;
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
