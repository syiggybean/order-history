import { gql } from "./preorders.server";
import { BarcodeLabelError, VARIANT_ID, buildZpl, inspectBarcode, resolveQuantity } from "./barcode-labels";

export { BarcodeLabelError, CONFIRM_OVER, MAX_LABELS, buildZpl, inspectBarcode, resolveQuantity } from "./barcode-labels";
import { queuePrint, rememberStation, stationReady, fallbackText } from "./print.server";

// ---------------------------------------------------------------------------
// Barcode labels: 2 × 1 inch product labels on a Zebra (ZD410), printed through
// the MonkeyBean Print agent on the packing Mac (the station's "Barcode labels"
// printer). Ported from the Yiggybean Barcode Labels app, without its Cloudflare
// broker, pairing codes or separate Mac helper.
//
// Read-only in Shopify: it never changes products, barcodes or stock. The
// variant is read again right before printing, so a stale page can't print an
// old barcode, and blank, malformed or duplicate barcodes are refused.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shopify (read only)
// ---------------------------------------------------------------------------

const quoted = (v) => `"${String(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function itemOf(v, product = null) {
  const productTitle = String(product?.title ?? v?.product?.title ?? "").trim();
  const option = String(v?.title ?? "").trim();
  const title = !option || option.toLowerCase() === "default title" ? productTitle : productTitle ? `${productTitle} — ${option}` : option;
  const barcode = String(v?.barcode ?? "");
  const check = inspectBarcode(barcode);
  return {
    id: String(v.id),
    productId: String(product?.id ?? v?.product?.id ?? ""),
    title,
    sku: String(v?.sku ?? ""),
    barcode,
    stock: Number.isFinite(Number(v?.inventoryQuantity)) ? Number(v.inventoryQuantity) : null,
    symbology: check.ok ? check.symbology : null,
    problem: check.ok ? null : check.message,
    warnings: check.ok ? check.warnings : [],
  };
}

const SEARCH = `#graphql
  query BarcodeLabelSearch($variantQuery: String!, $productQuery: String!) {
    byVariant: productVariants(first: 50, query: $variantQuery) {
      nodes { id title sku barcode inventoryQuantity product { id title status } }
    }
    byProduct: products(first: 20, query: $productQuery) {
      nodes { id title status variants(first: 50) { nodes { id title sku barcode inventoryQuantity } } }
    }
  }`;

export async function searchItems(admin, q) {
  const text = String(q ?? "").trim().slice(0, 120);
  if (!text) return [];
  const data = await gql(admin, SEARCH, { variantQuery: `sku:${quoted(text)}* OR barcode:${quoted(text)}`, productQuery: quoted(text) });
  const items = new Map();
  for (const v of data?.byVariant?.nodes ?? []) if (v.product?.status !== "ARCHIVED") items.set(v.id, itemOf(v));
  for (const p of data?.byProduct?.nodes ?? []) {
    if (p.status === "ARCHIVED") continue;
    for (const v of p.variants?.nodes ?? []) items.set(v.id, itemOf(v, p));
  }
  const lower = text.toLowerCase();
  const score = (i) =>
    i.barcode.toLowerCase() === lower ? 0 : i.sku.toLowerCase() === lower ? 1 : i.sku.toLowerCase().startsWith(lower) ? 2 : i.title.toLowerCase().includes(lower) ? 3 : 4;
  return [...items.values()].sort((a, b) => score(a) - score(b) || a.title.localeCompare(b.title)).slice(0, 50);
}

const VARIANT = `#graphql
  query BarcodeLabelVariant($id: ID!) {
    productVariant(id: $id) { id title sku barcode inventoryQuantity product { id title } }
  }`;
const DUPLICATES = `#graphql
  query BarcodeLabelDuplicates($query: String!) {
    productVariants(first: 3, query: $query) { nodes { id barcode } }
  }`;

// The variant as Shopify has it right now, with its duplicate-barcode check
export async function getItem(admin, id) {
  if (!VARIANT_ID.test(String(id ?? ""))) throw new BarcodeLabelError("Choose an item first.");
  const data = await gql(admin, VARIANT, { id: String(id) });
  if (!data?.productVariant) throw new BarcodeLabelError("That item no longer exists in Shopify.");
  const item = itemOf(data.productVariant);
  item.duplicate = false;
  if (item.barcode) {
    const dup = await gql(admin, DUPLICATES, { query: `barcode:${quoted(item.barcode)}` });
    item.duplicate = (dup?.productVariants?.nodes ?? []).filter((v) => String(v.barcode ?? "") === item.barcode).length > 1;
  }
  return item;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

// input: { variantId, mode, custom, confirmed, stationId }
// Returns { job, item, quantity } | { fallback, text } | { needsConfirm, quantity, item }
export async function printBarcodeLabels(shop, admin, input, user, staffKey) {
  const stationId = Number(input.stationId) || null;
  const ready = await stationReady(shop, stationId, "barcode");
  if (!ready.ready) return { fallback: ready.reason, text: fallbackText(ready) };

  const item = await getItem(admin, input.variantId); // fresh from Shopify, never the page's copy
  if (item.problem) throw new BarcodeLabelError(item.problem);
  if (item.duplicate) throw new BarcodeLabelError(`Another item in Shopify has the same barcode (${item.barcode}). Fix the duplicate before printing.`);
  const q = resolveQuantity({ mode: input.mode, custom: input.custom, stock: item.stock });
  if (!q.ok) throw new BarcodeLabelError(q.message);
  if (q.confirm && !input.confirmed) return { needsConfirm: true, quantity: q.quantity, item };

  const zpl = buildZpl(item, q.quantity);
  await rememberStation(shop, staffKey, stationId);
  const r = await queuePrint(
    shop,
    stationId,
    {
      role: "barcode",
      kind: "barcode",
      title: `${q.quantity} × ${item.sku || item.barcode} barcode`,
      format: "ZPL",
      bytes: Buffer.from(zpl, "utf8"),
    },
    user,
  );
  return { ...r, item, quantity: q.quantity };
}
