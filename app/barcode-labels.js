// Barcode label rules shared by the server and the page (no server-only code here):
// barcode checks, label counts and the 2 × 1 ZPL label.

export class BarcodeLabelError extends Error {}

export const MAX_LABELS = 10_000;
export const CONFIRM_OVER = 100;
export const VARIANT_ID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;
const GTIN = new Map([
  [8, "ean8"],
  [12, "upca"],
  [13, "ean13"],
]);

export function expectedCheckDigit(digits) {
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    sum += Number(digits[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return String((10 - (sum % 10)) % 10);
}

// { ok, value, symbology: upca|ean13|ean8|code128, warnings } or { ok: false, message }
export function inspectBarcode(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, code: "missing", message: "This item has no barcode in Shopify." };
  if (raw !== raw.trim()) return { ok: false, code: "whitespace", message: "The barcode starts or ends with a space. Fix it in Shopify before printing." };
  if (!/^[\x20-\x7E]+$/.test(raw)) return { ok: false, code: "characters", message: "The barcode has characters this label can't print." };
  if (/^\d+$/.test(raw) && GTIN.has(raw.length)) {
    const expected = expectedCheckDigit(raw.slice(0, -1));
    if (raw.at(-1) !== expected) {
      return { ok: false, code: "checkDigit", message: `The ${GTIN.get(raw.length).toUpperCase()} check digit is wrong (it should be ${expected}). Fix it in Shopify.` };
    }
    return { ok: true, value: raw, symbology: GTIN.get(raw.length), warnings: [] };
  }
  return {
    ok: true,
    value: raw,
    symbology: "code128",
    warnings: /^\d+$/.test(raw) ? ["This number isn't 8, 12 or 13 digits, so it prints as Code 128."] : [],
  };
}

// mode: one | custom | stock
export function resolveQuantity({ mode, custom, stock }) {
  let n;
  if (mode === "one") n = 1;
  else if (mode === "custom") {
    const t = String(custom ?? "").trim();
    if (!/^\d+$/.test(t)) return { ok: false, message: "Enter a whole number of labels." };
    n = Number(t);
  } else if (mode === "stock") {
    if (!Number.isFinite(stock)) return { ok: false, message: "Shopify's inventory count isn't available for this item." };
    n = Math.max(0, Math.floor(stock));
  } else return { ok: false, message: "Choose how many labels to print." };
  if (n < 1) return { ok: false, message: "There are no labels to print." };
  if (n > MAX_LABELS) return { ok: false, message: `One print can't be more than ${MAX_LABELS.toLocaleString("en-US")} labels.` };
  return { ok: true, quantity: n, confirm: n > CONFIRM_OVER };
}

// ---------------------------------------------------------------------------
// The label (406 × 203 dots: 2 × 1 inch at 203 dpi), same layout as before
// ---------------------------------------------------------------------------

export function zplText(v, max) {
  return String(v ?? "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function barcodeField(p) {
  if (p.symbology === "upca") return { x: 82, command: "^BUN,82,Y,N,Y", data: p.value.slice(0, -1) };
  if (p.symbology === "ean13") return { x: 82, command: "^BEN,82,Y,N", data: p.value.slice(0, -1) };
  if (p.symbology === "ean8") return { x: 126, command: "^B8N,82,Y,N", data: p.value.slice(0, -1) };
  return { x: 22, command: "^BCN,82,Y,N,N,A", data: p.value };
}

export function buildZpl({ title, sku, barcode }, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LABELS) throw new BarcodeLabelError("The number of labels isn't valid.");
  const p = inspectBarcode(barcode);
  if (!p.ok) throw new BarcodeLabelError(p.message);
  const f = barcodeField(p);
  const top = 20;
  return [
    "^XA",
    "^PW406",
    "^LL203",
    "^LH0,0",
    "^LT0",
    "^LS0",
    "^PR2",
    `^FO12,${top}^A0N,22,20^FB382,1,0,C,0^FD${zplText(title, 42)}^FS`,
    `^FO12,${top + 25}^A0N,17,15^FB382,1,0,C,0^FD${zplText(sku, 32)}^FS`,
    "^BY2,2,82",
    `^FO${f.x},${top + 45}${f.command}^FD${f.data}^FS`,
    `^PQ${quantity},0,0,N`,
    "^XZ",
    "",
  ].join("\n");
}
