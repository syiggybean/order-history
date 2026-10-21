import db from "./db.server";
import { errorMessage, gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Block list: customers who may not shop, and shipping addresses that may not
// receive orders.
//
// - Blocking a customer puts BLOCK_TAG on them in Shopify. The theme's
//   "Blocked customer" app embed reads that tag in Liquid: a red banner on
//   every page, no buy buttons, no cart, and the cart page sends them to an
//   error page.
// - Their shipping addresses are blocked too, unless unticked. Addresses are
//   matched on street + postcode + country, so a new account or guest
//   checkout to the same place is still caught.
// - Shopify doesn't let this app stop a checkout on your plan, so any order
//   that still gets through from a blocked customer or to a blocked address
//   is put on hold, tagged and flagged for review.
// ---------------------------------------------------------------------------

export const BLOCK_TAG = "Blocked from shopping";
export const ORDER_TAG = "Blocked customer";
export const HOLD_HANDLE = "oh-blocked";
export const FLAG_REASON = "Blocked customer or address";

export class BlockError extends Error {}

export const customerKey = (id) => {
  const s = String(id ?? "").split("/").pop();
  return /^\d+$/.test(s) ? s : null;
};
const customerGid = (key) => `gid://shopify/Customer/${key}`;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const STREET_WORDS = {
  street: "st", st: "st", avenue: "ave", av: "ave", ave: "ave", road: "rd", rd: "rd", drive: "dr", dr: "dr",
  boulevard: "blvd", blvd: "blvd", lane: "ln", ln: "ln", court: "ct", ct: "ct", place: "pl", pl: "pl",
  terrace: "ter", parkway: "pkwy", highway: "hwy", circle: "cir", square: "sq", suite: "ste",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  apartment: "apt", unit: "unit",
};

// "12 Elm Street." / "12 elm st" -> "12 elm st"
export function normStreet(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,#'"]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(" ");
}

// One key per place: street, postcode (US: first 5 digits) and country
export function addressKey(a) {
  if (!a) return null;
  const country = String(a.countryCodeV2 ?? a.country_code ?? a.countryCode ?? "").toUpperCase();
  const street = normStreet(a.address1);
  let zip = String(a.zip ?? "").toUpperCase().replace(/\s+/g, "");
  if (country === "US") zip = zip.slice(0, 5);
  if (!street || !zip) return null;
  return `${street}|${zip}|${country.toLowerCase()}`;
}

export function addressText(a) {
  if (!a) return "";
  return [
    [a.address1, a.address2].filter(Boolean).join(", "),
    [a.city, a.provinceCode ?? a.province_code ?? a.province, a.zip].filter(Boolean).join(" "),
    a.countryCodeV2 ?? a.country_code ?? a.country,
  ]
    .filter(Boolean)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Reading a customer
// ---------------------------------------------------------------------------

const CUSTOMER = `#graphql
  query BlockCustomer($id: ID!) {
    customer(id: $id) {
      id
      displayName
      tags
      defaultEmailAddress { emailAddress }
      addressesV2(first: 25) {
        nodes { address1 address2 city province provinceCode zip countryCodeV2 }
      }
    }
  }`;

async function readCustomer(admin, key) {
  const data = await gql(admin, CUSTOMER, { id: customerGid(key) });
  const c = data?.customer;
  if (!c) throw new BlockError("That customer couldn't be found.");
  const seen = new Set();
  const addresses = [];
  for (const a of c.addressesV2?.nodes ?? []) {
    const k = addressKey(a);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    addresses.push({ key: k, display: addressText(a) });
  }
  return { name: c.displayName, email: c.defaultEmailAddress?.emailAddress ?? null, tags: c.tags ?? [], addresses };
}

// Everything the admin "Block customer" window needs
export async function customerBlockStatus(shop, admin, customerId) {
  const key = customerKey(customerId);
  if (!key) throw new BlockError("Which customer?");
  const c = await readCustomer(admin, key);
  const record = await db.blockedCustomer.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
  // Their addresses, plus any address blocked from their record that isn't on it anymore
  const blockedRows = await db.blockedAddress.findMany({
    where: { shop, OR: [{ key: { in: c.addresses.map((a) => a.key) } }, { customerId: key }] },
  });
  const byKey = new Map(blockedRows.map((r) => [r.key, r]));
  const addresses = c.addresses.map((a) => ({ ...a, blocked: Boolean(byKey.get(a.key)?.blocked) }));
  for (const r of blockedRows) {
    if (!c.addresses.some((a) => a.key === r.key)) addresses.push({ key: r.key, display: r.display, blocked: r.blocked, removed: true });
  }
  return {
    customerId: key,
    name: c.name,
    email: c.email,
    blocked: Boolean(record?.blocked),
    known: Boolean(record),
    reason: record?.reason ?? null,
    blockedBy: record?.blockedBy ?? null,
    blockedAt: record?.blockedAt?.toISOString() ?? null,
    addresses,
  };
}

// ---------------------------------------------------------------------------
// Blocking and unblocking
// ---------------------------------------------------------------------------

const TAGS_ADD = `#graphql
  mutation BlockTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;
const TAGS_REMOVE = `#graphql
  mutation BlockTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

async function tag(admin, mutation, id, t) {
  const data = await gql(admin, mutation, { id, tags: [t] });
  const r = data?.tagsAdd ?? data?.tagsRemove;
  if (r?.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
}

// Sets the customer and each of their addresses to blocked or not.
//   want = { customer: true|false, addresses: { [key]: true|false }, reason }
export async function setBlock(shop, admin, customerId, want, user) {
  const key = customerKey(customerId);
  if (!key) throw new BlockError("Which customer?");
  const c = await readCustomer(admin, key);
  const by = user?.name ?? null;
  const now = new Date();
  const reason = want.reason === undefined ? undefined : String(want.reason ?? "").trim().slice(0, 500) || null;

  // The customer
  const existing = await db.blockedCustomer.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
  const blockCustomer = Boolean(want.customer);
  if (blockCustomer || existing) {
    const changing = !existing || existing.blocked !== blockCustomer;
    await db.blockedCustomer.upsert({
      where: { shop_customerId: { shop, customerId: key } },
      create: { shop, customerId: key, name: c.name, email: c.email, blocked: blockCustomer, reason: reason ?? null, blockedBy: by },
      update: {
        name: c.name,
        email: c.email,
        blocked: blockCustomer,
        ...(reason !== undefined ? { reason } : {}),
        ...(changing && blockCustomer ? { blockedBy: by, blockedAt: now, unblockedBy: null, unblockedAt: null } : {}),
        ...(changing && !blockCustomer ? { unblockedBy: by, unblockedAt: now } : {}),
      },
    });
    // The tag the theme looks for
    try {
      const has = c.tags.includes(BLOCK_TAG);
      if (blockCustomer && !has) await tag(admin, TAGS_ADD, customerGid(key), BLOCK_TAG);
      if (!blockCustomer && has) await tag(admin, TAGS_REMOVE, customerGid(key), BLOCK_TAG);
      await db.blockedCustomer.update({ where: { shop_customerId: { shop, customerId: key } }, data: { tagged: blockCustomer, tagError: null } });
    } catch (e) {
      await db.blockedCustomer.update({ where: { shop_customerId: { shop, customerId: key } }, data: { tagError: errorMessage(e).slice(0, 300) } });
      throw new BlockError(`Saved, but Shopify didn't take the "${BLOCK_TAG}" tag: ${errorMessage(e)}. Try again.`);
    }
  }

  // Addresses (theirs, plus any blocked earlier from their record)
  const known = new Map(c.addresses.map((a) => [a.key, a.display]));
  const rows = await db.blockedAddress.findMany({ where: { shop, customerId: key } });
  for (const r of rows) if (!known.has(r.key)) known.set(r.key, r.display);
  for (const [k, on] of Object.entries(want.addresses ?? {})) {
    if (!known.has(k)) continue;
    const row = await db.blockedAddress.findUnique({ where: { shop_key: { shop, key: k } } });
    if (on) {
      if (row?.blocked) continue;
      await db.blockedAddress.upsert({
        where: { shop_key: { shop, key: k } },
        create: { shop, key: k, display: known.get(k), customerId: key, blockedBy: by },
        update: { blocked: true, blockedBy: by, blockedAt: now, unblockedBy: null, unblockedAt: null, customerId: row?.customerId ?? key },
      });
    } else if (row?.blocked) {
      await db.blockedAddress.update({ where: { id: row.id }, data: { blocked: false, unblockedBy: by, unblockedAt: now } });
    }
  }
  console.log(`[blocklist] ${shop}: ${key} ${blockCustomer ? "blocked" : "not blocked"} by ${by ?? "staff"}`);
  return customerBlockStatus(shop, admin, key);
}

// Unblocking from the app's list (no customer read needed for addresses)
export async function unblockAddress(shop, id, user) {
  const row = await db.blockedAddress.findFirst({ where: { shop, id: Number(id) } });
  if (!row) throw new BlockError("That address couldn't be found.");
  await db.blockedAddress.update({ where: { id: row.id }, data: { blocked: false, unblockedBy: user?.name ?? null, unblockedAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Orders that get through anyway (orders/create)
// ---------------------------------------------------------------------------

const ORDER_FOS = `#graphql
  query BlockOrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) { nodes { id status } }
    }
  }`;
const HOLD = `#graphql
  mutation BlockHold($id: ID!, $hold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
      fulfillmentHold { id }
      userErrors { field message }
    }
  }`;

// Is this order from a blocked customer, or going to a blocked address?
export async function blockReasons(shop, order) {
  const why = [];
  const key = customerKey(order?.customer?.id);
  if (key) {
    const c = await db.blockedCustomer.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
    if (c?.blocked) why.push("customer");
  }
  const ak = addressKey(order?.shipping_address);
  if (ak) {
    const a = await db.blockedAddress.findUnique({ where: { shop_key: { shop, key: ak } } });
    if (a?.blocked) why.push("address");
  }
  return why;
}

export async function checkOrder(shop, admin, order) {
  const orderId = order?.id ? `gid://shopify/Order/${order.id}` : null;
  if (!orderId) return null;
  const why = await blockReasons(shop, order);
  if (!why.length) return null;
  let rec;
  try {
    rec = await db.blockedOrder.create({ data: { shop, orderId, orderName: order.name ?? null, customerId: customerKey(order?.customer?.id), why: why.join(",") } });
  } catch (e) {
    if (e?.code === "P2002") return null; // already handled (webhook retry)
    throw e;
  }
  const text = why.length === 2 ? "a blocked customer, shipping to a blocked address" : why[0] === "customer" ? "a blocked customer" : "a blocked shipping address";
  // Flag it for the team (Shipping → Review); auto-batching leaves flagged orders alone
  await db.orderFlag.create({
    data: { shop, orderId, orderName: order.name ?? orderId, reason: FLAG_REASON, note: `Placed by ${text}. Check before shipping, or cancel and refund.`, createdBy: "MonkeyBean" },
  });
  // Tag the order and hold it in Shopify so it can't be shipped by mistake
  const errors = [];
  try {
    await tag(admin, TAGS_ADD, orderId, ORDER_TAG);
  } catch (e) {
    errors.push(`tag: ${errorMessage(e)}`);
  }
  let held = false;
  try {
    const data = await gql(admin, ORDER_FOS, { id: orderId });
    for (const fo of data?.order?.fulfillmentOrders?.nodes ?? []) {
      if (!["OPEN", "SCHEDULED", "IN_PROGRESS"].includes(fo.status)) continue;
      const r = await gql(admin, HOLD, {
        id: fo.id,
        hold: { reason: "OTHER", reasonNotes: `Blocked: ${text} (MonkeyBean)`, handle: HOLD_HANDLE, notifyMerchant: true },
      });
      const errs = r?.fulfillmentOrderHold?.userErrors ?? [];
      if (errs.length) errors.push(errs.map((x) => x.message).join("; "));
      else held = true;
    }
  } catch (e) {
    errors.push(`hold: ${errorMessage(e)}`);
  }
  await db.blockedOrder.update({ where: { id: rec.id }, data: { held, error: errors.join(" · ").slice(0, 500) || null } });
  console.log(`[blocklist] ${shop}: ${order.name} caught (${why.join(", ")})${held ? ", on hold" : ""}`);
  return { why, held };
}

// ---------------------------------------------------------------------------
// The app's Blocked customers page
// ---------------------------------------------------------------------------

export async function blockList(shop) {
  const [customers, addresses, orders] = await Promise.all([
    db.blockedCustomer.findMany({ where: { shop }, orderBy: { blockedAt: "desc" }, take: 500 }),
    db.blockedAddress.findMany({ where: { shop }, orderBy: { blockedAt: "desc" }, take: 1000 }),
    db.blockedOrder.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const names = new Map(customers.map((c) => [c.customerId, c.name ?? c.email ?? `Customer ${c.customerId}`]));
  return {
    customers: customers.map((c) => ({
      customerId: c.customerId,
      name: c.name,
      email: c.email,
      blocked: c.blocked,
      reason: c.reason,
      blockedBy: c.blockedBy,
      blockedAt: c.blockedAt.toISOString(),
      unblockedBy: c.unblockedBy,
      unblockedAt: c.unblockedAt?.toISOString() ?? null,
      tagError: c.tagError,
      addresses: addresses.filter((a) => a.customerId === c.customerId).map((a) => ({ id: a.id, display: a.display, blocked: a.blocked })),
    })),
    addresses: addresses.map((a) => ({
      id: a.id,
      display: a.display,
      blocked: a.blocked,
      customerId: a.customerId,
      customerName: a.customerId ? names.get(a.customerId) ?? null : null,
      blockedBy: a.blockedBy,
      blockedAt: a.blockedAt.toISOString(),
    })),
    orders: orders.map((o) => ({ id: o.id, orderId: o.orderId, orderName: o.orderName, why: o.why, held: o.held, error: o.error, at: o.createdAt.toISOString() })),
  };
}
