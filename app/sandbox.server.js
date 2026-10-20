import db from "./db.server";
import { SANDBOX_SUFFIX, getShippingSettings, isSandboxShop, logEvent, sandboxAdmin } from "./shipping.server";

// ---------------------------------------------------------------------------
// Sandbox mode for the Shipping page
//
// Each staff member can switch it on for themselves. While on, the page works
// on a copy of the hub (shipments, bins, settings, open flags) stored under
// "<shop>::sandbox", shared by everyone in sandbox. Reads from Shopify still
// work; anything that would change Shopify is skipped and listed instead.
// ---------------------------------------------------------------------------

export { isSandboxShop, sandboxAdmin };
export const sandboxShopOf = (shop) => (isSandboxShop(shop) ? shop : `${shop}${SANDBOX_SUFFIX}`);
const keyOf = (user) => String(user?.id ?? user?.email ?? user?.name ?? "staff");

export async function inSandbox(shop, user) {
  if (!user) return false;
  return Boolean(await db.sandboxUser.findUnique({ where: { shop_staffKey: { shop, staffKey: keyOf(user) } } }));
}

// The shop to read and write for this person: the sandbox copy or the real one
export async function workingShop(shop, user) {
  return (await inSandbox(shop, user)) ? sandboxShopOf(shop) : shop;
}

export async function enterSandbox(shop, user) {
  await db.sandboxUser.upsert({
    where: { shop_staffKey: { shop, staffKey: keyOf(user) } },
    create: { shop, staffKey: keyOf(user) },
    update: {},
  });
  // First time (or after a reset by someone else): make the copy
  const exists = await db.shippingSettings.findUnique({ where: { shop: sandboxShopOf(shop) } });
  if (!exists) await resetSandbox(shop, user);
}

export async function leaveSandbox(shop, user) {
  await db.sandboxUser.deleteMany({ where: { shop, staffKey: keyOf(user) } });
}

// Fresh copy of the hub as it is right now. Shipments in batches come back as Ready.
export async function resetSandbox(shop, user) {
  const sb = sandboxShopOf(shop);
  await Promise.all([
    db.shipment.deleteMany({ where: { shop: sb } }),
    db.batch.deleteMany({ where: { shop: sb } }),
    db.productBin.deleteMany({ where: { shop: sb } }),
    db.orderFlag.deleteMany({ where: { shop: sb } }),
    db.shippingEvent.deleteMany({ where: { shop: sb } }),
    db.shippingSettings.deleteMany({ where: { shop: sb } }),
    db.noticeAck.deleteMany({ where: { shop: sb } }),
  ]);

  const real = await getShippingSettings(shop);
  await db.shippingSettings.create({
    data: {
      shop: sb,
      holdMode: "off",
      lastFullSyncAt: real.lastFullSyncAt ?? new Date(),
      lastReadyRunAt: real.lastReadyRunAt,
      autoBatchEnabled: false, // the sandbox never runs on a schedule
      autoBatchTime: real.autoBatchTime,
      autoSingleItem: real.autoSingleItem,
      autoSingleMin: real.autoSingleMin,
    },
  });

  const shipments = await db.shipment.findMany({ where: { shop, state: { in: ["waiting", "ready", "batched", "packed", "labeling"] } } });
  const copy = shipments.map(({ id, createdAt, updatedAt, ...s }) => ({
    ...s,
    shop: sb,
    state: s.state === "waiting" ? "waiting" : "ready",
    readyAt: s.state === "waiting" ? null : (s.readyAt ?? new Date()),
    batchId: null,
    batchTag: null,
    tagError: null,
    appHoldId: null,
    holdError: null,
    flag: null,
    overrideAt: null,
    overrideBy: null,
    overrideReason: null,
    packed: null,
    packedAt: null,
    packedBy: null,
    packAckKey: null,
    packOverride: null,
  }));
  for (let i = 0; i < copy.length; i += 500) await db.shipment.createMany({ data: copy.slice(i, i + 500) });

  const bins = await db.productBin.findMany({ where: { shop } });
  if (bins.length) await db.productBin.createMany({ data: bins.map(({ id, updatedAt, ...b }) => ({ ...b, shop: sb })) });

  const flags = await db.orderFlag.findMany({ where: { shop, status: "open" } });
  if (flags.length) await db.orderFlag.createMany({ data: flags.map(({ id, ...f }) => ({ ...f, shop: sb })) });

  await logEvent(sb, {
    type: "sandbox_reset",
    detail: `Copied ${copy.length} shipment${copy.length === 1 ? "" : "s"}, ${bins.length} bin${bins.length === 1 ? "" : "s"} and ${flags.length} open flag${flags.length === 1 ? "" : "s"}`,
    user,
  });
  return { shipments: copy.length, bins: bins.length, flags: flags.length };
}

// For the banner: what the sandbox would have sent to Shopify, newest first
export async function sandboxSummary(shop) {
  const sb = sandboxShopOf(shop);
  const [skipped, skippedCount, reset] = await Promise.all([
    db.shippingEvent.findMany({ where: { shop: sb, type: "sandbox_skipped" }, orderBy: { id: "desc" }, take: 15 }),
    db.shippingEvent.count({ where: { shop: sb, type: "sandbox_skipped" } }),
    db.shippingEvent.findFirst({ where: { shop: sb, type: "sandbox_reset" }, orderBy: { id: "desc" } }),
  ]);
  return {
    skipped: skipped.map((e) => ({ id: e.id, detail: e.detail, at: e.createdAt.toISOString() })),
    skippedCount,
    copiedAt: reset?.createdAt.toISOString() ?? null,
    copied: reset?.detail ?? null,
  };
}
