import { randomUUID } from "node:crypto";
import db from "./db.server";
import { getChange, itemNames } from "./inventory-history.server";
import { UNDO_URI_PREFIX, requestLiveSync } from "./inventory-sync.server";

// ---------------------------------------------------------------------------
// Undoing a stock change
//
// An undo is a new adjustment of the opposite amount to "available" stock at
// the same location, so Shopify's own history stays complete. Every attempt
// is logged in InventoryUndo with who did it and what happened.
// ---------------------------------------------------------------------------

export class UndoError extends Error {}

async function currentAvailable(admin, inventoryItemId, locationId) {
  const res = await admin.graphql(
    `#graphql
    query ($item: ID!, $location: ID!) {
      inventoryItem(id: $item) {
        inventoryLevel(locationId: $location) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }`,
    { variables: { item: inventoryItemId, location: locationId } },
  );
  const body = await res.json();
  if (body.errors?.length) throw new UndoError(body.errors[0].message);
  const level = body.data?.inventoryItem?.inventoryLevel;
  if (!level) throw new UndoError("This item isn't stocked at that location anymore.");
  return level.quantities.find((q) => q.name === "available")?.quantity ?? 0;
}

async function adjust(admin, { undoId, inventoryItemId, locationId, delta, from }) {
  const res = await admin.graphql(
    `#graphql
    mutation Undo($input: InventoryAdjustQuantitiesInput!, $key: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
        inventoryAdjustmentGroup { id createdAt }
        userErrors { field message code }
      }
    }`,
    {
      variables: {
        key: randomUUID(),
        input: {
          name: "available",
          reason: "correction",
          referenceDocumentUri: `${UNDO_URI_PREFIX}${undoId}`,
          changes: [{ delta, inventoryItemId, locationId, changeFromQuantity: from }],
        },
      },
    },
  );
  const body = await res.json();
  if (body.errors?.length) return { error: body.errors[0].message };
  const out = body.data?.inventoryAdjustQuantities;
  const err = out?.userErrors?.[0];
  if (err) {
    const stale = err.code === "CHANGE_FROM_QUANTITY_STALE" || /stale|changed/i.test(err.message);
    return { error: err.message, stale };
  }
  return { group: out?.inventoryAdjustmentGroup ?? null };
}

// What an undo would do, for the confirmation step
export async function previewUndo(shop, admin, key) {
  const change = await checkUndoable(shop, key);
  const current = await currentAvailable(admin, change.inventoryItemId, locationOf(key));
  const delta = -change.available;
  return { key, delta, current, after: current + delta };
}

const locationOf = (key) => String(key).split("|")[2];

async function checkUndoable(shop, key) {
  const change = await getChange(shop, key);
  if (!change) throw new UndoError("That change couldn't be found.");
  if (change.isUndo) throw new UndoError("An undo can't be undone. Make a new adjustment in Shopify instead.");
  if (change.undoneBy) throw new UndoError(`This change was already undone by ${change.undoneBy.name}.`);
  if (!change.undoable) throw new UndoError("This kind of change can't be undone here.");
  const inProgress = await db.inventoryUndo.findFirst({
    where: { shop, originalKey: key, status: "pending", createdAt: { gte: new Date(Date.now() - 2 * 60 * 1000) } },
  });
  if (inProgress) throw new UndoError("An undo for this change is already in progress.");
  return change;
}

// Reverses one change. user: { userId, name }
export async function undoChange(shop, admin, user, key) {
  const change = await checkUndoable(shop, key);
  const locationId = locationOf(key);
  const delta = -change.available;

  const undo = await db.inventoryUndo.create({
    data: {
      shop,
      originalKey: key,
      originalAt: new Date(change.at),
      originalWho: change.who,
      originalReason: change.reasonLabel,
      inventoryItemId: change.inventoryItemId,
      locationId,
      productId: change.productId,
      delta,
      userId: user.userId,
      userName: user.name,
    },
  });

  try {
    let before = await currentAvailable(admin, change.inventoryItemId, locationId);
    let result = await adjust(admin, { undoId: undo.id, inventoryItemId: change.inventoryItemId, locationId, delta, from: before });
    if (result.stale) {
      // Stock moved between reading and writing (e.g. an order came in); try once more
      before = await currentAvailable(admin, change.inventoryItemId, locationId);
      result = await adjust(admin, { undoId: undo.id, inventoryItemId: change.inventoryItemId, locationId, delta, from: before });
    }
    if (result.error) throw new UndoError(result.error);

    const at = result.group?.createdAt ? new Date(result.group.createdAt) : new Date();
    await db.$transaction([
      db.inventoryUndo.update({
        where: { id: undo.id },
        data: {
          status: "applied",
          quantityBefore: before,
          quantityAfter: before + delta,
          shopifyGroupId: result.group?.id ?? null,
        },
      }),
      // Placeholder so the undo shows in the history right away. Replaced by
      // Shopify's own record when the history sync picks it up.
      db.inventoryAdjustment.create({
        data: {
          shop,
          adjustmentId: `undo-${undo.id}`,
          groupId: `undo-${undo.id}`,
          occurredAt: at,
          inventoryItemId: change.inventoryItemId,
          productId: change.productId,
          locationId,
          locationName: change.location,
          state: "available",
          change: delta,
          reason: "correction",
          staffName: user.name,
          referenceUri: `${UNDO_URI_PREFIX}${undo.id}`,
        },
      }),
    ]);
    requestLiveSync(shop).catch(() => {});
    return { id: undo.id, delta, before, after: before + delta };
  } catch (e) {
    await db.inventoryUndo.update({
      where: { id: undo.id },
      data: { status: "failed", error: String(e.message ?? e).slice(0, 500) },
    });
    throw e instanceof UndoError ? e : new UndoError(`Shopify didn't accept the undo: ${e.message ?? e}`);
  }
}

// Undos logged before reasons used Shopify admin's wording
const OLD_LABELS = {
  Shrinkage: "Theft or loss",
  "Stock count": "Count",
  Promotion: "Promotion or donation",
  Restock: "Return restock",
  "Manual adjustment": "Manually adjusted",
  Reserved: "Reservation created",
  "Reservation released": "Reservation deleted",
};

// The undo log, newest first, for the app page
export async function listUndos(shop, { page = 1, pageSize = 10 } = {}) {
  const rows = await db.inventoryUndo.findMany({
    where: { shop, status: { in: ["applied", "failed"] } },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
  });
  const shown = rows.slice(0, pageSize);
  const names = await itemNames(shop, shown.map((u) => u.inventoryItemId));
  return {
    page,
    hasMore: rows.length > pageSize,
    undos: shown.map((u) => ({
      id: u.id,
      at: u.createdAt.toISOString(),
      by: u.userName ?? "Staff member",
      item: names.get(u.inventoryItemId)?.name ?? "Unknown item",
      sku: names.get(u.inventoryItemId)?.sku ?? null,
      inventoryItemId: u.inventoryItemId,
      delta: u.delta,
      before: u.quantityBefore,
      after: u.quantityAfter,
      original: {
        at: u.originalAt?.toISOString() ?? null,
        who: u.originalWho,
        reason: OLD_LABELS[u.originalReason] ?? u.originalReason,
      },
      status: u.status,
      error: u.error,
    })),
  };
}
