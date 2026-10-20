import { randomUUID } from "node:crypto";
import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import { KEY, NAMESPACE, TIERS, errorMessage, gql, toDay } from "./preorders.server";
import { createCampaign, getSettings, kickMail, metricsFor, storeUrl } from "./preorder-notify.server";

// ---------------------------------------------------------------------------
// Pre-order countdowns
//
// Products added to the group get an opening time and (optionally) a closing
// time. The theme block shows a countdown before opening, a "Pre-Order"
// button while open, and "Pre-Orders Closed" afterwards.
//
// The buttons on the page are only half of it: to stop sales everywhere
// (quick-add, cart links, checkout) the app turns "Continue selling when out
// of stock" off before opening and after closing, and on while open. Pre-order
// items have 0 stock, so with it off they can't be bought at all.
//
// With a sales limit, "Continue selling" stays off and the app gives each
// variant its limit as stock at opening, so Shopify stops at exactly 0.
// Stock is taken off sale (held) at closing and put back on re-opening.
// Adding stock after selling out re-opens sales; once enough is added, the
// people who signed up are emailed.
//
// Times are entered and shown in store time (Pacific).
// ---------------------------------------------------------------------------

export const STORE_TZ = "America/Los_Angeles";
export const MF_NAMESPACE = "oh_preorder";
const TICK_MS = 15 * 1000;

// ---------------------------------------------------------------------------
// Store time <-> instants
// ---------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: STORE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
});

function storeParts(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const m = (p.timeZoneName ?? "GMT").match(/GMT([+-])(\d{2}):?(\d{2})?/);
  const offset = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return { ...p, offset };
}

// "2026-11-01T09:00" (Pacific) → Date, or null
export function fromStoreInput(value) {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // Guess with the offset near that time, then correct it (daylight saving)
  const guess = wall - storeParts(new Date(wall)).offset * 60000;
  const at = new Date(wall - storeParts(new Date(guess)).offset * 60000);
  // A time skipped when clocks go forward doesn't exist; it lands an hour later
  return Number.isNaN(at.getTime()) ? null : at;
}

// Date → "2026-11-01T09:00" (Pacific), for datetime inputs
export function toStoreInput(date) {
  if (!date) return "";
  const p = storeParts(new Date(date));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

// scheduled: before opening · open: buying allowed · closed: after closing
export function phaseOf(w, now = Date.now()) {
  const t = typeof now === "number" ? now : now.getTime();
  if (w.closesAt && t >= new Date(w.closesAt).getTime()) return "closed";
  if (w.opensAt && t < new Date(w.opensAt).getTime()) return "scheduled";
  return "open";
}

const json = (s, fallback = {}) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
export const limitsOf = (w) => {
  const l = json(w.limits, null);
  return l && Object.keys(l).length ? l : null;
};

// ---------------------------------------------------------------------------
// Shopify calls
// ---------------------------------------------------------------------------

const PRODUCT_QUERY = `#graphql
  query ($id: ID!, $after: String, $location: ID!, $withLevels: Boolean!) {
    product(id: $id) {
      id
      title
      handle
      featuredMedia {
        preview {
          image {
            thumb: url(transform: { maxWidth: 120 })
            large: url(transform: { maxWidth: 600 })
          }
        }
      }
      variants(first: 250, after: $after) {
        nodes {
          id
          title
          inventoryPolicy
          inventoryItem {
            id
            tracked
            inventoryLevel(locationId: $location) @include(if: $withLevels) {
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

// locationId: also read each variant's available stock there
async function loadProduct(admin, productId, locationId = null) {
  let after = null;
  let product = null;
  const variants = [];
  do {
    const data = await gql(admin, PRODUCT_QUERY, {
      id: productId,
      after,
      location: locationId ?? "gid://shopify/Location/0",
      withLevels: Boolean(locationId),
    });
    if (!data?.product) throw new Error("This product couldn't be found in Shopify.");
    product = data.product;
    variants.push(
      ...product.variants.nodes.map((v) => {
        const level = v.inventoryItem?.inventoryLevel;
        return {
          id: v.id,
          title: v.title,
          inventoryPolicy: v.inventoryPolicy,
          inventoryItemId: v.inventoryItem?.id ?? null,
          tracked: Boolean(v.inventoryItem?.tracked),
          stocked: Boolean(level),
          available: level ? level.quantities.find((q) => q.name === "available")?.quantity ?? 0 : 0,
        };
      }),
    );
    after = product.variants.pageInfo.hasNextPage ? product.variants.pageInfo.endCursor : null;
  } while (after);
  const image = product.featuredMedia?.preview?.image;
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl: image?.thumb ?? null,
    largeImageUrl: image?.large ?? null,
    variants,
  };
}

const VARIANTS_UPDATE = `#graphql
  mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }`;

async function setPolicies(admin, productId, changes) {
  for (let i = 0; i < changes.length; i += 100) {
    const data = await gql(admin, VARIANTS_UPDATE, { productId, variants: changes.slice(i, i + 100) });
    const errs = data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
}

const LOCATIONS_QUERY = `#graphql
  { locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`;

export async function listLocations(admin) {
  const data = await gql(admin, LOCATIONS_QUERY);
  return (data?.locations?.nodes ?? []).filter((l) => l.isActive);
}

// Where limited stock is kept: the chosen location, or the first one that
// fulfils online orders
export async function sellingLocation(shop, admin) {
  const s = await getSettings(shop);
  if (s.locationId) return s.locationId;
  const locations = await listLocations(admin);
  const pick = locations.find((l) => l.fulfillsOnlineOrders) ?? locations[0];
  if (!pick) throw new Error("No active location found to hold pre-order stock.");
  await db.preorderSettings.update({ where: { shop }, data: { locationId: pick.id } });
  return pick.id;
}

const ACTIVATE = `#graphql
  mutation ($item: ID!, $location: ID!) {
    inventoryActivate(inventoryItemId: $item, locationId: $location) { userErrors { field message } }
  }`;

const ADJUST = `#graphql
  mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      userErrors { field message code }
    }
  }`;

const LEVEL_QUERY = `#graphql
  query ($item: ID!, $location: ID!) {
    inventoryItem(id: $item) {
      inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } }
    }
  }`;

async function readAvailable(admin, inventoryItemId, locationId) {
  const data = await gql(admin, LEVEL_QUERY, { item: inventoryItemId, location: locationId });
  const level = data?.inventoryItem?.inventoryLevel;
  return level ? level.quantities.find((q) => q.name === "available")?.quantity ?? 0 : null;
}

// Sets a variant's available stock at the location. Returns the new amount.
async function setAvailable(admin, w, variant, locationId, target) {
  if (!variant.tracked) throw new Error(`"${variant.title}" doesn't track stock, so it can't have a sales limit.`);
  let current = variant.stocked ? variant.available : await readAvailable(admin, variant.inventoryItemId, locationId);
  if (current === null && target === 0) return 0; // not stocked there: already nothing on sale
  if (current === null) {
    const data = await gql(admin, ACTIVATE, { item: variant.inventoryItemId, location: locationId });
    const errs = data?.inventoryActivate?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
    current = 0;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const delta = target - current;
    if (delta === 0) return target;
    const data = await gql(admin, ADJUST, {
      key: randomUUID(),
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `gid://order-history/PreorderWindow/${w.id}`,
        changes: [{ delta, inventoryItemId: variant.inventoryItemId, locationId, changeFromQuantity: current }],
      },
    });
    const err = data?.inventoryAdjustQuantities?.userErrors?.[0];
    if (!err) return target;
    const stale = err.code === "CHANGE_FROM_QUANTITY_STALE" || /stale|changed/i.test(err.message);
    if (!stale || attempt === 1) throw new Error(err.message);
    current = (await readAvailable(admin, variant.inventoryItemId, locationId)) ?? 0;
  }
  return target;
}

const METAFIELDS_SET = `#graphql
  mutation ($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

const METAFIELDS_DELETE = `#graphql
  mutation ($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) { userErrors { field message } }
  }`;

// The theme block reads these: product.metafields.oh_preorder.opens_at / closes_at / limited
async function writeMetafields(admin, productId, { opensAt, closesAt, limited = false }) {
  const set = [];
  const remove = [];
  for (const [key, at] of [
    ["opens_at", opensAt],
    ["closes_at", closesAt],
  ]) {
    if (at) set.push({ ownerId: productId, namespace: MF_NAMESPACE, key, type: "date_time", value: new Date(at).toISOString() });
    else remove.push({ ownerId: productId, namespace: MF_NAMESPACE, key });
  }
  if (limited) set.push({ ownerId: productId, namespace: MF_NAMESPACE, key: "limited", type: "boolean", value: "true" });
  else remove.push({ ownerId: productId, namespace: MF_NAMESPACE, key: "limited" });
  if (set.length) {
    const data = await gql(admin, METAFIELDS_SET, { metafields: set });
    const errs = data?.metafieldsSet?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
  if (remove.length) {
    const data = await gql(admin, METAFIELDS_DELETE, { metafields: remove });
    const errs = data?.metafieldsDelete?.userErrors ?? [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  }
}

// ---------------------------------------------------------------------------
// Applying a window to Shopify
// ---------------------------------------------------------------------------

const busy = new Set(); // windows being changed right now

async function productUrlFor(shop, admin, handle) {
  return `${(await storeUrl(shop, admin)).replace(/\/$/, "")}/products/${handle}`;
}

async function sendCampaign(shop, admin, w, product, kind, dedupeKey) {
  return createCampaign(shop, {
    window: w,
    kind,
    dedupeKey,
    product,
    productUrl: await productUrlFor(shop, admin, product.handle),
  });
}

// Makes Shopify match the window's phase:
//   - "Continue selling when out of stock": on only while open and unlimited
//   - with a limit: stock goes on sale at opening and is held at closing
// Sends the "pre-orders are open" / "re-opened" emails on the way into open.
export async function enforce(admin, w, now = Date.now()) {
  const phase = phaseOf(w, now);
  const prev = w.appliedPhase;
  const limits = limitsOf(w);
  try {
    const locationId = limits ? w.locationId ?? (await sellingLocation(w.shop, admin)) : null;
    const product = await loadProduct(admin, w.productId, locationId);

    const want = !limits && phase === "open" ? "CONTINUE" : "DENY";
    const policyChanges = product.variants
      .filter((v) => v.inventoryPolicy !== want)
      .map((v) => ({ id: v.id, inventoryPolicy: want }));
    if (policyChanges.length) await setPolicies(admin, w.productId, policyChanges);

    const held = json(w.held);
    const stock = json(w.stock);
    const data = {};
    let firstOpen = false;
    let reopened = false;

    if (limits && prev !== phase) {
      for (const v of product.variants) {
        let target;
        if (phase === "open") {
          // First opening: exactly the limit. Re-opening: what was held back.
          target = !w.firstOpenedAt ? Number(limits[v.id] ?? 0) : v.available + Number(held[v.id] ?? 0);
          held[v.id] = 0;
        } else {
          // Not on sale: hold whatever is there for later
          held[v.id] = Number(held[v.id] ?? 0) + Math.max(0, v.available);
          target = 0;
        }
        stock[v.id] = await setAvailable(admin, w, v, locationId, target);
        v.available = stock[v.id];
      }
      data.held = JSON.stringify(held);
      data.stock = JSON.stringify(stock);
      data.locationId = locationId;
    } else if (limits) {
      for (const v of product.variants) stock[v.id] = v.available;
      data.stock = JSON.stringify(stock);
      data.locationId = locationId;
    }

    if (phase === "open" && prev !== "open") {
      firstOpen = !w.firstOpenedAt;
      reopened = !firstOpen;
      data.firstOpenedAt = w.firstOpenedAt ?? new Date();
      data.closedAt = null;
      data.soldOutAt = null;
      data.restockedUnits = 0;
    }
    if (phase === "closed" && prev !== "closed") data.closedAt = new Date();

    const saved = await db.preorderWindow.update({
      where: { id: w.id },
      data: {
        ...data,
        appliedPhase: phase,
        appliedAt: new Date(),
        lastError: null,
        title: product.title,
        handle: product.handle,
        imageUrl: product.imageUrl,
      },
    });

    // Emails
    if (firstOpen) {
      await sendCampaign(w.shop, admin, saved, product, "opened", `opened:${w.id}:${saved.firstOpenedAt.toISOString()}`);
    } else if (reopened) {
      const settings = await getSettings(w.shop);
      const onSale = limits ? product.variants.reduce((n, v) => n + Math.max(0, v.available), 0) : Infinity;
      if (onSale > settings.restockThreshold) {
        await sendCampaign(w.shop, admin, saved, product, "reopened", `reopened:${w.id}:${Date.now()}`);
      }
    }
    return { phase, changed: policyChanges.length };
  } catch (e) {
    await db.preorderWindow.update({ where: { id: w.id }, data: { lastError: errorMessage(e).slice(0, 500) } });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The group
// ---------------------------------------------------------------------------

export class WindowError extends Error {}

const sum = (obj) => Object.values(obj ?? {}).reduce((n, x) => n + Math.max(0, Number(x) || 0), 0);

const view = (w, now = Date.now(), metrics = null) => {
  const limits = limitsOf(w);
  const phase = phaseOf(w, now);
  const stock = json(w.stock);
  return {
    id: w.id,
    productId: w.productId,
    title: w.title ?? "Unknown product",
    handle: w.handle,
    imageUrl: w.imageUrl,
    opensAt: w.opensAt?.toISOString() ?? null,
    closesAt: w.closesAt?.toISOString() ?? null,
    opensInput: toStoreInput(w.opensAt),
    closesInput: toStoreInput(w.closesAt),
    phase,
    appliedPhase: w.appliedPhase,
    limited: Boolean(limits),
    limitTotal: limits ? sum(limits) : null,
    variantCount: limits ? Object.keys(limits).length : 0,
    available: limits ? sum(stock) : null,
    held: limits ? sum(json(w.held)) : 0,
    soldOut: Boolean(limits && phase === "open" && w.appliedPhase === "open" && sum(stock) === 0),
    restockedUnits: w.restockedUnits,
    firstOpenedAt: w.firstOpenedAt?.toISOString() ?? null,
    closedAt: w.closedAt?.toISOString() ?? null,
    lastError: w.lastError,
    updatedBy: w.updatedBy ?? w.addedBy,
    updatedAt: w.updatedAt.toISOString(),
    metrics,
  };
};

export async function listWindows(shop) {
  const rows = await db.preorderWindow.findMany({ where: { shop }, orderBy: [{ opensAt: "asc" }, { id: "asc" }] });
  const metrics = rows.length ? await metricsFor(shop, rows.map((w) => w.productId)) : {};
  const now = Date.now();
  const order = { scheduled: 0, open: 1, closed: 2 };
  return rows.map((w) => view(w, now, metrics[w.productId])).sort((a, b) => order[a.phase] - order[b.phase]);
}

// Adds a product to the group. Nothing changes in Shopify until times are set.
export async function addProduct(shop, admin, productId, user) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId ?? "")) throw new WindowError("Pick a product to add.");
  const existing = await db.preorderWindow.findUnique({ where: { shop_productId: { shop, productId } } });
  if (existing) return view(existing);
  const product = await loadProduct(admin, productId);
  const w = await db.preorderWindow.create({
    data: {
      shop,
      productId,
      title: product.title,
      handle: product.handle,
      imageUrl: product.imageUrl,
      // Remember how each variant was set, to put it back on removal
      originalPolicies: JSON.stringify(Object.fromEntries(product.variants.map((v) => [v.id, v.inventoryPolicy]))),
      addedBy: user?.name ?? null,
    },
  });
  return view(w);
}

// Variants with their current stock and limits, for the edit form
export async function windowVariants(shop, admin, id) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const locationId = w.locationId ?? (await sellingLocation(shop, admin));
  const product = await loadProduct(admin, w.productId, locationId);
  const limits = limitsOf(w) ?? {};
  return product.variants.map((v) => ({
    id: v.id,
    title: v.title === "Default Title" ? product.title : v.title,
    tracked: v.tracked,
    available: v.available,
    limit: limits[v.id] ?? null,
  }));
}

const parseLimits = (input) => {
  if (!input) return null;
  const out = {};
  for (const [id, n] of Object.entries(input)) {
    if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)) continue;
    const x = Math.round(Number(n));
    if (!Number.isFinite(x) || x < 0) throw new WindowError("Limits must be whole numbers of 0 or more.");
    out[id] = x;
  }
  return Object.keys(out).length ? out : null;
};

// Sets times and the optional sales limit.
// opens/closes: Pacific "YYYY-MM-DDTHH:mm" (blank = none); limits: {variantId: n} or null
export async function saveWindow(shop, admin, id, { opens, closes, limits }, user) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const opensAt = opens ? fromStoreInput(opens) : null;
  const closesAt = closes ? fromStoreInput(closes) : null;
  if (opens && !opensAt) throw new WindowError("The opening time isn't a valid date and time.");
  if (closes && !closesAt) throw new WindowError("The closing time isn't a valid date and time.");
  if (opensAt && closesAt && closesAt <= opensAt) throw new WindowError("Pre-orders must close after they open.");
  if (!opensAt && !closesAt) throw new WindowError("Set an opening time, a closing time, or both.");
  const newLimits = parseLimits(limits);

  if (busy.has(w.id)) throw new WindowError("This product is being updated. Try again in a moment.");
  busy.add(w.id);
  try {
    // Limit changed while on sale: add or take away the difference now
    const oldLimits = limitsOf(w);
    if (newLimits && w.appliedPhase === "open" && phaseOf({ opensAt, closesAt }) === "open") {
      const locationId = w.locationId ?? (await sellingLocation(shop, admin));
      const product = await loadProduct(admin, w.productId, locationId);
      const stock = json(w.stock);
      for (const v of product.variants) {
        const before = oldLimits ? Number(oldLimits[v.id] ?? 0) : 0;
        const diff = Number(newLimits[v.id] ?? 0) - before;
        if (diff !== 0) stock[v.id] = await setAvailable(admin, w, v, locationId, Math.max(0, v.available + diff));
      }
      await db.preorderWindow.update({ where: { id: w.id }, data: { stock: JSON.stringify(stock), locationId } });
    }

    await writeMetafields(admin, w.productId, { opensAt, closesAt, limited: Boolean(newLimits) });
    const saved = await db.preorderWindow.update({
      where: { id: w.id },
      data: { opensAt, closesAt, limits: newLimits ? JSON.stringify(newLimits) : null, updatedBy: user?.name ?? null },
    });
    await enforce(admin, saved);
  } finally {
    busy.delete(w.id);
  }
  return view(await db.preorderWindow.findUnique({ where: { id: w.id } }));
}

// Kept for older callers
export const saveTimes = (shop, admin, id, times, user) =>
  db.preorderWindow
    .findFirst({ where: { shop, id } })
    .then((w) => saveWindow(shop, admin, id, { ...times, limits: w ? limitsOf(w) : null }, user));

// History tab: open a closed product again, with a new closing time (or none).
// addUnits: with a sales limit, extra units for each variant on top of what
// was held back at closing.
export async function reopenWindow(shop, admin, id, { closes, addUnits = 0 }, user) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) throw new WindowError("That product isn't in the group anymore.");
  const closesAt = closes ? fromStoreInput(closes) : null;
  if (closes && !closesAt) throw new WindowError("The closing time isn't a valid date and time.");
  if (closesAt && closesAt <= new Date()) throw new WindowError("The new closing time has to be in the future.");
  const extra = Math.round(Number(addUnits) || 0);
  if (extra < 0) throw new WindowError("Units to add can't be negative.");
  const limits = limitsOf(w);
  if (extra && limits) {
    // Goes on sale with the held stock when enforce() opens it
    const held = json(w.held);
    const bigger = {};
    for (const vid of Object.keys(limits)) {
      held[vid] = Number(held[vid] ?? 0) + extra;
      bigger[vid] = Number(limits[vid] ?? 0) + extra;
    }
    await db.preorderWindow.update({ where: { id: w.id }, data: { held: JSON.stringify(held), limits: JSON.stringify(bigger) } });
    w.limits = JSON.stringify(bigger);
  }
  return saveWindow(
    shop,
    admin,
    id,
    { opens: toStoreInput(w.opensAt ?? new Date()), closes: closes || "", limits: limitsOf(w) },
    user,
  );
}

// Takes a product out of the group: countdown off, selling setting put back
export async function removeProduct(shop, admin, id) {
  const w = await db.preorderWindow.findFirst({ where: { shop, id } });
  if (!w) return;
  await writeMetafields(admin, w.productId, { opensAt: null, closesAt: null, limited: false });
  const original = json(w.originalPolicies);
  const held = json(w.held);
  const locationId = w.locationId;
  const product = await loadProduct(admin, w.productId, sum(held) && locationId ? locationId : null).catch(() => null);
  if (product && sum(held) && locationId) {
    // Stock the app held back goes back on the shelf
    for (const v of product.variants) {
      const extra = Number(held[v.id] ?? 0);
      if (extra > 0) await setAvailable(admin, w, v, locationId, v.available + extra).catch(() => null);
    }
  }
  if (product) {
    // Variants added since default to selling, like the rest of the pre-orders
    const changes = product.variants
      .map((v) => ({ id: v.id, inventoryPolicy: original[v.id] ?? "CONTINUE", was: v.inventoryPolicy }))
      .filter((v) => v.inventoryPolicy !== v.was)
      .map(({ id: vid, inventoryPolicy }) => ({ id: vid, inventoryPolicy }));
    if (changes.length) await setPolicies(admin, w.productId, changes);
  }
  await db.preorderWindow.delete({ where: { id: w.id } });
}

// ---------------------------------------------------------------------------
// Stock changes (from Shopify's inventory notifications)
// ---------------------------------------------------------------------------

async function variantFor(shop, inventoryItemId) {
  const info = await db.inventoryItemInfo.findUnique({ where: { shop_inventoryItemId: { shop, inventoryItemId } } });
  if (info?.productId && info?.variantId) return { productId: info.productId, variantId: info.variantId };
  const { admin } = await unauthenticated.admin(shop);
  const data = await gql(
    admin,
    `#graphql
    query ($id: ID!) { inventoryItem(id: $id) { variant { id product { id } } } }`,
    { id: inventoryItemId },
  );
  const v = data?.inventoryItem?.variant;
  return v ? { productId: v.product.id, variantId: v.id } : null;
}

// Watches limited products: notices selling out, and re-opens (with an email)
// once more than the threshold has been added back. Stock that appears while
// pre-orders aren't open is held until they are.
export async function stockChanged(shop, payload, now = Date.now()) {
  const inventoryItemId = `gid://shopify/InventoryItem/${payload?.inventory_item_id}`;
  const locationId = `gid://shopify/Location/${payload?.location_id}`;
  const available = Number(payload?.available);
  if (!payload?.inventory_item_id || !Number.isFinite(available)) return;

  const groupIds = await db.preorderWindow.findMany({ where: { shop, limits: { not: null } }, select: { productId: true } });
  if (!groupIds.length) return;
  const found = await variantFor(shop, inventoryItemId);
  if (!found) return;
  const w = await db.preorderWindow.findUnique({ where: { shop_productId: { shop, productId: found.productId } } });
  if (!w || !limitsOf(w) || (w.locationId && w.locationId !== locationId)) return;
  if (busy.has(w.id)) return; // the app is changing it itself
  const phase = phaseOf(w, now);
  if (phase !== w.appliedPhase) return; // about to open or close; that run sets the stock

  busy.add(w.id);
  try {
    const stock = json(w.stock);
    const before = Number(stock[found.variantId] ?? 0);
    stock[found.variantId] = available;
    const data = { stock: JSON.stringify(stock) };
    const { admin } = await unauthenticated.admin(shop);

    if (phase !== "open") {
      // Not on sale: hold it back so it can't be bought early or late
      if (available > 0) {
        const product = await loadProduct(admin, w.productId, locationId);
        const v = product.variants.find((x) => x.id === found.variantId);
        if (v && v.available > 0) {
          const held = json(w.held);
          held[found.variantId] = Number(held[found.variantId] ?? 0) + v.available;
          stock[found.variantId] = await setAvailable(admin, w, v, locationId, 0);
          data.held = JSON.stringify(held);
          data.stock = JSON.stringify(stock);
        }
      }
      await db.preorderWindow.update({ where: { id: w.id }, data });
      return;
    }

    const total = sum(stock);
    const added = available - before;
    let restocked = false;
    if (total === 0 && !w.soldOutAt) {
      data.soldOutAt = new Date();
      data.restockedUnits = 0;
    } else if (added > 0 && w.soldOutAt) {
      const units = w.restockedUnits + added;
      const settings = await getSettings(shop);
      if (units > settings.restockThreshold) {
        data.soldOutAt = null;
        data.restockedUnits = 0;
        restocked = true;
      } else {
        data.restockedUnits = units;
      }
    }
    const saved = await db.preorderWindow.update({ where: { id: w.id }, data });
    if (restocked) {
      const product = await loadProduct(admin, w.productId);
      await sendCampaign(shop, admin, saved, product, "reopened", `reopened:${w.id}:${Date.now()}`);
    }
  } finally {
    busy.delete(w.id);
  }
}

// ---------------------------------------------------------------------------
// Finding products to add
// ---------------------------------------------------------------------------

const SEARCH_QUERY = `#graphql
  query ($query: String!) {
    products(first: 25, query: $query, sortKey: TITLE) {
      nodes {
        id
        title
        status
        tags
        featuredMedia { preview { image { url(transform: { maxWidth: 80 }) } } }
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
      }
    }
  }`;

const GT_QUERY = TIERS.map((t) => `tag:${t.tag}`).join(" OR ");

// Words → product search. Empty search lists current pre-orders (GT tags).
export async function searchProducts(shop, admin, text) {
  const words = String(text ?? "")
    .trim()
    .replace(/["\\():]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const query = words.length ? words.map((w) => `(title:*${w}* OR sku:${w}*)`).join(" AND ") : `(${GT_QUERY})`;
  const [data, inGroup] = await Promise.all([
    gql(admin, SEARCH_QUERY, { query: `${query} AND -status:archived` }),
    db.preorderWindow.findMany({ where: { shop }, select: { productId: true } }),
  ]);
  const added = new Set(inGroup.map((w) => w.productId));
  const today = new Date().toISOString().slice(0, 10);
  return (data?.products?.nodes ?? []).map((p) => {
    const release = toDay(p.metafield?.value);
    return {
      productId: p.id,
      title: p.title,
      status: p.status,
      imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
      release,
      preorder: Boolean(release && release > today) || p.tags.some((t) => TIERS.some((x) => x.tag.toLowerCase() === t.toLowerCase())),
      inGroup: added.has(p.id),
    };
  });
}

// ---------------------------------------------------------------------------
// Keeping Shopify in step: checks every 15 seconds for products whose phase
// has changed (opened or closed) since the app last applied it, and sends the
// "closing soon" reminder.
// ---------------------------------------------------------------------------

export async function checkWindows(now = Date.now()) {
  const rows = await db.preorderWindow.findMany({
    where: { OR: [{ opensAt: { not: null } }, { closesAt: { not: null } }] },
  });
  for (const w of rows) {
    if (busy.has(w.id)) continue;
    const phase = phaseOf(w, now);
    if (phase !== w.appliedPhase) {
      busy.add(w.id);
      try {
        const { admin } = await unauthenticated.admin(w.shop);
        await enforce(admin, w, now);
      } catch (e) {
        console.error(`[preorder-windows] ${w.productId}:`, errorMessage(e));
      } finally {
        busy.delete(w.id);
      }
      continue;
    }
    if (phase === "open" && w.closesAt) await maybeRemind(w, now);
  }
}

async function maybeRemind(w, now) {
  const settings = await getSettings(w.shop);
  if (!settings.reminderHours) return;
  const closes = new Date(w.closesAt).getTime();
  if (now < closes - settings.reminderHours * 3600 * 1000 || now >= closes) return;
  // No point reminding people about something that's sold out
  if (limitsOf(w) && sum(json(w.stock)) === 0) return;
  const key = `closing:${w.id}:${new Date(w.closesAt).toISOString()}`;
  if (await db.emailCampaign.findUnique({ where: { dedupeKey: key } })) return;
  try {
    const { admin } = await unauthenticated.admin(w.shop);
    const product = await loadProduct(admin, w.productId);
    await sendCampaign(w.shop, admin, w, product, "closing", key);
  } catch (e) {
    console.error(`[preorder-windows] reminder ${w.productId}:`, errorMessage(e));
  }
}

// Someone may change "Continue selling" by hand; put it back if it matters
export async function recheckProduct(shop, productId) {
  const w = await db.preorderWindow.findUnique({ where: { shop_productId: { shop, productId } } });
  if (!w || (!w.opensAt && !w.closesAt) || busy.has(w.id)) return;
  if (w.appliedPhase !== phaseOf(w)) return; // the next check handles it
  busy.add(w.id);
  try {
    const { admin } = await unauthenticated.admin(shop);
    const product = await loadProduct(admin, w.productId);
    const want = !limitsOf(w) && w.appliedPhase === "open" ? "CONTINUE" : "DENY";
    const changes = product.variants.filter((v) => v.inventoryPolicy !== want).map((v) => ({ id: v.id, inventoryPolicy: want }));
    if (changes.length) await setPolicies(admin, w.productId, changes);
  } finally {
    busy.delete(w.id);
  }
}

if (!globalThis.__preorderWindowTimer && process.env.NODE_ENV !== "test") {
  const tick = () => checkWindows().catch((e) => console.error("[preorder-windows] check:", errorMessage(e)));
  globalThis.__preorderWindowTimer = setInterval(tick, TICK_MS);
  setTimeout(tick, 20 * 1000);
  kickMail();
}
