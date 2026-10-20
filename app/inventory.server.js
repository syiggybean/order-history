import db from "./db.server";
import { unauthenticated } from "./shopify.server";

// ---------------------------------------------------------------------------
// Real-time inventory log
//
// Shopify sends an "inventory level updated" notification whenever stock
// changes. Each one is written to the log straight away with the new
// quantity and the change since the last known quantity. Who made the change
// and why is filled in afterwards from Shopify's inventory history
// (detailsStatus stays "pending" until then).
// ---------------------------------------------------------------------------

const itemGid = (id) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/InventoryItem/${id}`);
const locationGid = (id) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/Location/${id}`);

// One change at a time per item and location, so quick back-to-back
// notifications don't race each other when working out the difference.
const queues = new Map();
function serial(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

// Which variant and product an inventory item belongs to (cached)
const locationNames = new Map();

const gqlError = (e) =>
  e?.body?.errors?.graphQLErrors?.map((x) => x.message).join("; ") || e?.message || String(e);

// Product and location are looked up separately, so a problem with one
// (e.g. a missing permission) doesn't block the other. When a lookup
// succeeds, earlier log entries that were missing those details are filled in.
async function describe(shop, inventoryItemId, locationId) {
  let info = await db.inventoryItemInfo.findUnique({
    where: { shop_inventoryItemId: { shop, inventoryItemId } },
  });
  let locationName = locationNames.get(locationId) ?? null;
  if (info && locationName) return { info, locationName };

  const { admin } = await unauthenticated.admin(shop);

  if (!info) {
    try {
      const res = await admin.graphql(
        `#graphql
        query ($id: ID!) {
          inventoryItem(id: $id) {
            sku
            variant { id title product { id title } }
          }
        }`,
        { variables: { id: inventoryItemId } },
      );
      const item = (await res.json()).data?.inventoryItem;
      if (item) {
        const fields = {
          variantId: item.variant?.id ?? null,
          variantTitle: item.variant?.title ?? null,
          productId: item.variant?.product?.id ?? null,
          productTitle: item.variant?.product?.title ?? null,
          sku: item.sku ?? null,
        };
        info = await db.inventoryItemInfo.upsert({
          where: { shop_inventoryItemId: { shop, inventoryItemId } },
          create: { shop, inventoryItemId, ...fields },
          update: fields,
        });
        await db.inventoryEvent.updateMany({
          where: { shop, inventoryItemId, productId: null },
          data: fields,
        });
      }
    } catch (e) {
      console.error(`[inventory] product lookup failed for ${inventoryItemId}:`, gqlError(e));
    }
  }

  if (!locationName) {
    try {
      const res = await admin.graphql(
        `#graphql
        query ($id: ID!) { location(id: $id) { name } }`,
        { variables: { id: locationId } },
      );
      locationName = (await res.json()).data?.location?.name ?? null;
      if (locationName) {
        locationNames.set(locationId, locationName);
        await db.inventoryEvent.updateMany({
          where: { shop, locationId, locationName: null },
          data: { locationName },
        });
      }
    } catch (e) {
      console.error(`[inventory] location lookup failed for ${locationId}:`, gqlError(e));
    }
  }

  return { info, locationName };
}

// Called by the webhook route for each notification
export async function recordInventoryChange(shop, webhookId, payload) {
  const inventoryItemId = itemGid(payload.inventory_item_id);
  const locationId = locationGid(payload.location_id);
  const available = Number(payload.available);
  const occurredAt = payload.updated_at ? new Date(payload.updated_at) : new Date();
  if (!Number.isFinite(available)) return;

  return serial(`${shop}|${inventoryItemId}|${locationId}`, async () => {
    // Shopify can send the same notification more than once
    if (webhookId && (await db.inventoryEvent.findUnique({ where: { webhookId } }))) return;

    const key = { shop_inventoryItemId_locationId: { shop, inventoryItemId, locationId } };
    const last = await db.inventoryLevelSnapshot.findUnique({ where: key });

    // Notifications can arrive out of order; only compare against an older one
    const inOrder = !last || last.updatedAt <= occurredAt;
    const previous = last && inOrder ? last.available : null;
    const change = previous === null ? null : available - previous;

    // Nothing actually moved (e.g. a repeat with a new ID)
    if (change === 0) return;

    let info = null;
    let locationName = null;
    try {
      ({ info, locationName } = await describe(shop, inventoryItemId, locationId));
    } catch (e) {
      console.error("[inventory] lookup failed:", gqlError(e));
    }

    try {
      await db.inventoryEvent.create({
        data: {
        shop,
        webhookId: webhookId ?? null,
        source: "live",
        inventoryItemId,
        locationId,
        locationName,
        variantId: info?.variantId ?? null,
        variantTitle: info?.variantTitle ?? null,
        productId: info?.productId ?? null,
        productTitle: info?.productTitle ?? null,
        sku: info?.sku ?? null,
          available,
          previous,
          change,
          occurredAt,
        },
      });
    } catch (e) {
      if (e?.code === "P2002") return; // same notification already recorded
      throw e;
    }

    if (inOrder) {
      await db.inventoryLevelSnapshot.upsert({
        where: key,
        create: { shop, inventoryItemId, locationId, available, updatedAt: occurredAt },
        update: { available, updatedAt: occurredAt },
      });
    }
  });
}

// Fills in product and location details on log entries recorded without them
export async function fillMissingDetails(shop) {
  const missing = await db.inventoryEvent.findMany({
    where: { shop, OR: [{ productId: null }, { locationName: null }] },
    select: { inventoryItemId: true, locationId: true },
    distinct: ["inventoryItemId", "locationId"],
    take: 500,
  });

  for (const m of missing) {
    const cached = await db.inventoryItemInfo.findUnique({
      where: { shop_inventoryItemId: { shop, inventoryItemId: m.inventoryItemId } },
    });
    if (cached) {
      const { variantId, variantTitle, productId, productTitle, sku } = cached;
      await db.inventoryEvent.updateMany({
        where: { shop, inventoryItemId: m.inventoryItemId, productId: null },
        data: { variantId, variantTitle, productId, productTitle, sku },
      });
    }
    await describe(shop, m.inventoryItemId, m.locationId);
  }

  return db.inventoryEvent.count({ where: { shop, OR: [{ productId: null }, { locationName: null }] } });
}

export async function recentInventoryEvents(shop, take = 25) {
  return db.inventoryEvent.findMany({ where: { shop }, orderBy: { occurredAt: "desc" }, take });
}
