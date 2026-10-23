import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { errorMessage, gql } from "./preorders.server";
import { runBulkQuery } from "./bulk.server";
import { isSandboxShop } from "./shipping.server";

// ---------------------------------------------------------------------------
// Bins ↔ Shopify: each variant has a "Bin location" field in Shopify admin (a
// metafield, custom.bin_location), kept in step with Shipping → Bins.
//
//   Set in the app        → written to the variant in Shopify straight away.
//   Edited in Shopify     → picked up when the product is saved (webhook) and by a
//                           full check every 30 minutes.
//   Both changed          → the most recent edit wins.
//   Cleared in Shopify    → cleared here (only if it had been in Shopify before).
// The sandbox copy never writes to Shopify.
// ---------------------------------------------------------------------------

export const BIN_NAMESPACE = "custom";
export const BIN_KEY = "bin_location";
const FULL_EVERY_MS = 30 * 60 * 1000;
const clean = (v) => String(v ?? "").trim().slice(0, 40);

const DEFINITION = `#graphql
  query BinDefinition {
    metafieldDefinitions(first: 1, ownerType: PRODUCTVARIANT, namespace: "custom", key: "bin_location") {
      nodes { id pinnedPosition }
    }
  }`;
const CREATE_DEFINITION = `#graphql
  mutation BinDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }`;
const SET = `#graphql
  mutation BinsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { ownerType value updatedAt owner { ... on ProductVariant { id } } }
      userErrors { field message code }
    }
  }`;
const DELETE = `#graphql
  mutation BinsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { ownerId }
      userErrors { field message }
    }
  }`;
const PRODUCT_BINS = `#graphql
  query ProductBins($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 250) {
        nodes { id sku barcode title metafield(namespace: "custom", key: "bin_location") { value updatedAt } }
      }
    }
  }`;
const BULK_BINS = `{
  productVariants {
    edges {
      node {
        id
        sku
        barcode
        title
        product { id title }
        metafield(namespace: "custom", key: "bin_location") { value updatedAt }
      }
    }
  }
}`;

// The "Bin location" field shows on every variant in Shopify admin (pinned), made once per store
const defined = new Set();
export async function ensureBinField(shop, admin) {
  if (defined.has(shop)) return;
  const found = (await gql(admin, DEFINITION))?.metafieldDefinitions?.nodes?.[0];
  if (!found) {
    const r = await gql(admin, CREATE_DEFINITION, {
      definition: {
        name: "Bin location",
        namespace: BIN_NAMESPACE,
        key: BIN_KEY,
        type: "single_line_text_field",
        ownerType: "PRODUCTVARIANT",
        description: "Where this item is shelved. Kept in step with MonkeyBean (Shipping → Bins).",
        pin: true,
      },
    });
    const err = r?.metafieldDefinitionCreate?.userErrors?.find((e) => e.code !== "TAKEN");
    if (err) throw new Error(`Couldn't add the Bin location field in Shopify: ${err.message}`);
  }
  defined.add(shop);
}

async function adminFor(shop) {
  return (await unauthenticated.admin(shop)).admin;
}

// Writes bins to Shopify: items [{ variantId, bin }] (empty bin clears it). Never throws.
export async function pushBins(shop, items, { admin = null } = {}) {
  if (isSandboxShop(shop) || !items.length) return { pushed: 0, errors: [] };
  const errors = [];
  let pushed = 0;
  try {
    const client = admin ?? (await adminFor(shop));
    await ensureBinField(shop, client);
    const sets = items.filter((i) => clean(i.bin));
    const clears = items.filter((i) => !clean(i.bin));
    for (let i = 0; i < sets.length; i += 25) {
      const part = sets.slice(i, i + 25);
      const r = await gql(client, SET, { metafields: part.map((x) => ({ ownerId: x.variantId, namespace: BIN_NAMESPACE, key: BIN_KEY, type: "single_line_text_field", value: clean(x.bin) })) });
      const errs = r?.metafieldsSet?.userErrors ?? [];
      if (errs.length) errors.push(...errs.map((e) => e.message));
      const ok = new Set((r?.metafieldsSet?.metafields ?? []).map((m) => m.owner?.id).filter(Boolean));
      if (ok.size) await db.productBin.updateMany({ where: { shop, variantId: { in: [...ok] } }, data: { shopifySyncedAt: new Date() } });
      pushed += ok.size;
    }
    for (let i = 0; i < clears.length; i += 25) {
      const part = clears.slice(i, i + 25);
      const r = await gql(client, DELETE, { metafields: part.map((x) => ({ ownerId: x.variantId, namespace: BIN_NAMESPACE, key: BIN_KEY })) });
      const errs = r?.metafieldsDelete?.userErrors ?? [];
      if (errs.length) errors.push(...errs.map((e) => e.message));
      pushed += part.length - errs.length;
    }
  } catch (e) {
    errors.push(errorMessage(e));
  }
  if (errors.length) console.error(`[bins] writing to Shopify (${shop}):`, errors.slice(0, 3).join("; "));
  return { pushed, errors };
}

// One variant as Shopify has it, against the app's saved bin. Returns what to push back, if anything.
async function reconcile(shop, v, saved) {
  const theirs = clean(v.metafield?.value);
  const theirsAt = v.metafield?.updatedAt ? new Date(v.metafield.updatedAt) : null;
  const title = v.productTitle ? (v.title && v.title !== "Default Title" ? `${v.productTitle} – ${v.title}` : v.productTitle) : saved?.title ?? null;
  if (theirs && !saved) {
    await db.productBin.create({
      data: { shop, variantId: v.id, productId: v.productId ?? null, sku: v.sku ?? null, barcode: v.barcode ?? null, title, bin: theirs, updatedBy: "Shopify admin", shopifySyncedAt: new Date() },
    });
    return { changed: "fromShopify" };
  }
  if (theirs && saved) {
    if (theirs === saved.bin) {
      if (!saved.shopifySyncedAt) await db.productBin.update({ where: { id: saved.id }, data: { shopifySyncedAt: new Date() } });
      return null;
    }
    // Different: the newer edit wins
    if (theirsAt && theirsAt > saved.updatedAt) {
      await db.productBin.update({ where: { id: saved.id }, data: { bin: theirs, updatedBy: "Shopify admin", shopifySyncedAt: new Date() } });
      return { changed: "fromShopify" };
    }
    return { push: { variantId: v.id, bin: saved.bin } };
  }
  if (!theirs && saved) {
    // It was in Shopify and someone cleared it there: clear it here too
    // (not changed here since it last matched Shopify: the sync stamp itself moves updatedAt by a moment)
    if (saved.shopifySyncedAt && saved.updatedAt.getTime() - saved.shopifySyncedAt.getTime() < 5000) {
      await db.productBin.delete({ where: { id: saved.id } });
      return { changed: "clearedInShopify" };
    }
    return { push: { variantId: v.id, bin: saved.bin } };
  }
  return null;
}

// A product was saved in Shopify: pick up bin edits on its variants
export async function pullProductBins(shop, productId, { admin = null } = {}) {
  if (isSandboxShop(shop)) return { changed: 0 };
  const client = admin ?? (await adminFor(shop));
  const p = (await gql(client, PRODUCT_BINS, { id: productId }))?.product;
  if (!p) return { changed: 0 };
  const ids = p.variants.nodes.map((v) => v.id);
  const saved = new Map((await db.productBin.findMany({ where: { shop, variantId: { in: ids } } })).map((b) => [b.variantId, b]));
  let changed = 0;
  const push = [];
  for (const v of p.variants.nodes) {
    const r = await reconcile(shop, { ...v, productId: p.id, productTitle: p.title }, saved.get(v.id));
    if (r?.changed) changed++;
    if (r?.push) push.push(r.push);
  }
  if (push.length) await pushBins(shop, push, { admin: client });
  return { changed, pushed: push.length };
}

// Everything: every variant's Bin location against the app's bins (bulk read)
const running = new Map();
export function syncAllBins(shop, { admin = null, force = false } = {}) {
  if (isSandboxShop(shop)) return Promise.resolve(null);
  if (running.has(shop)) return running.get(shop);
  const p = (async () => {
    const settings = await db.shippingSettings.findUnique({ where: { shop } });
    if (!force && settings?.binsSyncedAt && Date.now() - settings.binsSyncedAt.getTime() < FULL_EVERY_MS) return null;
    const client = admin ?? (await adminFor(shop));
    try {
      await ensureBinField(shop, client);
      const rows = await runBulkQuery(client, BULK_BINS, { label: "Reading bin locations" });
      const saved = new Map((await db.productBin.findMany({ where: { shop } })).map((b) => [b.variantId, b]));
      const seen = new Set();
      let fromShopify = 0;
      let cleared = 0;
      const push = [];
      for (const r of rows) {
        if (!r.id || r.__parentId) continue;
        seen.add(r.id);
        const x = await reconcile(shop, { id: r.id, sku: r.sku, barcode: r.barcode, title: r.title, productId: r.product?.id, productTitle: r.product?.title, metafield: r.metafield }, saved.get(r.id));
        if (x?.changed === "fromShopify") fromShopify++;
        if (x?.changed === "clearedInShopify") cleared++;
        if (x?.push) push.push(x.push);
      }
      // Bins for variants that no longer exist in Shopify are left alone (shown in the app only)
      const { pushed, errors } = await pushBins(shop, push, { admin: client });
      await db.shippingSettings.updateMany({ where: { shop }, data: { binsSyncedAt: new Date(), binsSyncError: errors.length ? errors[0].slice(0, 300) : null } });
      return { variants: seen.size, fromShopify, cleared, pushed, errors: errors.length };
    } catch (e) {
      await db.shippingSettings.updateMany({ where: { shop }, data: { binsSyncedAt: new Date(), binsSyncError: errorMessage(e).slice(0, 300) } });
      throw e;
    }
  })().finally(() => running.delete(shop));
  running.set(shop, p);
  return p;
}

export async function binSyncStatus(shop) {
  const s = await db.shippingSettings.findUnique({ where: { shop } });
  return { syncedAt: s?.binsSyncedAt?.toISOString() ?? null, error: s?.binsSyncError ?? null, running: running.has(shop) };
}
