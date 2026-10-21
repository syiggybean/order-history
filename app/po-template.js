// The PO document template: shared by the server (rendering, PDF) and the
// editor in the browser (preview). No server-only code here.

export const FIELDS = [
  { key: "po_number", label: "PO number", sample: "PO-0042" },
  { key: "po_date", label: "PO date", sample: "October 20, 2026" },
  { key: "expected_date", label: "Expected date", sample: "November 3, 2026" },
  { key: "supplier_name", label: "Supplier name", sample: "Seven Seas Distribution" },
  { key: "supplier_address", label: "Supplier address", sample: "123 Harbor Way<br>Los Angeles, CA 90021" },
  { key: "supplier_email", label: "Supplier email", sample: "orders@supplier.com" },
  { key: "store_name", label: "Store name", sample: "Yiggybean Books" },
  { key: "ship_to", label: "Ship-to address", sample: "Yiggybean Warehouse<br>500 Main St<br>Reno, NV 89501" },
  { key: "supplier_note", label: "Note for supplier", sample: "Please ship by ground. Call ahead for delivery." },
  { key: "line_items", label: "Line items table", sample: null },
  { key: "subtotal", label: "Subtotal", sample: "$1,240.00" },
  { key: "tax_total", label: "Tax", sample: "$102.30" },
  { key: "total", label: "Total", sample: "$1,342.30" },
  { key: "total_quantity", label: "Total quantity", sample: "180" },
  { key: "line_count", label: "Number of lines", sample: "6" },
  { key: "currency", label: "Currency", sample: "USD" },
];

export const DEFAULT_TEMPLATE = `<table style="width:100%"><tbody><tr>
<td style="width:60%"><h1>Purchase order</h1><p><strong>{{store_name}}</strong></p></td>
<td style="text-align:right"><h2>{{po_number}}</h2><p>Date: {{po_date}}<br>Expected: {{expected_date}}</p></td>
</tr></tbody></table>
<table style="width:100%;margin:14px 0"><tbody><tr>
<td style="width:50%"><h3>Supplier</h3><p>{{supplier_name}}<br>{{supplier_address}}</p></td>
<td style="width:50%"><h3>Ship to</h3><p>{{ship_to}}</p></td>
</tr></tbody></table>
<p>{{supplier_note}}</p>
{{line_items}}
<table style="width:100%"><tbody><tr><td style="width:60%"></td><td>
<table style="width:100%"><tbody>
<tr><td>Subtotal</td><td style="text-align:right">{{subtotal}}</td></tr>
<tr><td>Tax</td><td style="text-align:right">{{tax_total}}</td></tr>
<tr><td><strong>Total</strong></td><td style="text-align:right"><strong>{{total}}</strong></td></tr>
</tbody></table></td></tr></tbody></table>
<p style="margin-top:24px;font-size:11px;color:#555">Please include the PO number on all invoices and packing slips. Contact us with any questions about this order.</p>`;

export const DEFAULT_EMAIL_SUBJECT = "Purchase order {{po_number}} from {{store_name}}";
export const DEFAULT_EMAIL_BODY = `Hello {{supplier_name}},

Please find our purchase order {{po_number}} attached ({{total_quantity}} units, {{total}}).

{{supplier_note}}

Thank you,
{{store_name}}`;

export const DOC_CSS = `
  @page { size: Letter; margin: 14mm 12mm; }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 12px; line-height: 1.45; margin: 0; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0 0 4px; } h3 { font-size: 13px; margin: 0 0 4px; }
  p { margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { vertical-align: top; }
  .po-lines { margin: 10px 0; font-size: 11px; }
  .po-lines th { text-align: left; background: #f3f3f3; border-bottom: 1px solid #bbb; padding: 6px 5px; white-space: nowrap; }
  .po-lines td { border-bottom: 1px solid #e3e3e3; padding: 5px; }
  .po-lines .num { text-align: right; white-space: nowrap; }
  .po-lines tr { page-break-inside: avoid; }
  img { max-width: 100%; }
`;

const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function linesTableHtml(lines, fmt) {
  const rate = (r) => `${Number(r || 0).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`;
  const rows = lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${escHtml(l.sku ?? "")}</td><td>${escHtml(l.supplierCode ?? "")}</td><td>${escHtml(l.supplierBarcode ?? "")}</td><td>${escHtml(l.title)}</td><td class="num">${l.quantity}</td><td class="num">${fmt(l.unitCost)}</td><td class="num">${rate(l.taxRate)}</td><td class="num">${fmt(l.tax)}</td><td class="num">${fmt(l.total)}</td></tr>`,
    )
    .join("");
  return `<table class="po-lines"><thead><tr><th>#</th><th>SKU</th><th>Supplier code</th><th>Supplier barcode</th><th>Title</th><th class="num">Qty</th><th class="num">Unit cost</th><th class="num">Tax rate</th><th class="num">Tax</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Keeps only plain formatting: no scripts, event handlers, forms, frames or
// javascript: links. Runs on save and again when rendering.
const ALLOWED = new Set(["a", "b", "strong", "i", "em", "u", "s", "p", "br", "hr", "div", "span", "h1", "h2", "h3", "h4", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "img", "blockquote", "font", "small", "sub", "sup", "colgroup", "col"]);
const ATTRS = new Set(["style", "href", "src", "alt", "width", "height", "colspan", "rowspan", "align", "class", "title", "color", "size", "face"]);

const cleanStyle = (v) =>
  String(v)
    .replace(/expression\s*\(/gi, "")
    .replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, "")
    .replace(/behavior\s*:/gi, "")
    .replace(/-moz-binding/gi, "");

const safeUrl = (v, img) => {
  const s = String(v).trim();
  if (/^https:\/\//i.test(s)) return s;
  if (!img && (/^mailto:/i.test(s) || /^http:\/\//i.test(s))) return s;
  if (img && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(s)) return s;
  return null;
};

export function sanitizeTemplate(html) {
  let s = String(html ?? "");
  // Whole elements whose content must go too
  s = s.replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|form|textarea|select|button|link|meta|base)[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, name, rest) => {
    const n = name.toLowerCase();
    if (!ALLOWED.has(n)) return "";
    if (tag.startsWith("</")) return `</${n}>`;
    const attrs = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m;
    while ((m = re.exec(rest))) {
      const a = m[1].toLowerCase();
      if (!ATTRS.has(a)) continue;
      let v = m[3] ?? m[4] ?? m[5] ?? "";
      if (a === "href" || a === "src") {
        v = safeUrl(v.replace(/&amp;/g, "&"), a === "src");
        if (v === null) continue;
      }
      if (a === "style") v = cleanStyle(v);
      attrs.push(`${a}="${v.replace(/"/g, "&quot;")}"`);
    }
    if (n === "a") attrs.push('target="_blank"', 'rel="noopener"');
    const selfClose = /\/\s*$/.test(rest) || n === "br" || n === "hr" || n === "img" || n === "col";
    return `<${n}${attrs.length ? " " + attrs.join(" ") : ""}${selfClose && n !== "br" && n !== "hr" ? " /" : ""}>`;
  });
}

// For the editor's preview: sample values
export function sampleValues() {
  const lines = [
    { sku: "LORE-V1", supplierCode: "SS-1001", supplierBarcode: "9781638581234", title: "Lore Vol. 1", quantity: 60, unitCost: 8.5, taxRate: 8.25, tax: 42.08, total: 552.08 },
    { sku: "MIST-V1", supplierCode: "SS-1002", supplierBarcode: "9781638585678", title: "Mist Vol. 1", quantity: 40, unitCost: 9.25, taxRate: 8.25, tax: 30.53, total: 400.53 },
  ];
  const out = Object.fromEntries(FIELDS.filter((f) => f.sample !== null).map((f) => [f.key, f.sample]));
  out.line_items = linesTableHtml(lines, (n) => `$${Number(n).toFixed(2)}`);
  return out;
}
