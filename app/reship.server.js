// Reship: a free ($0) replacement order in Shopify for items that need to go
// out again (damaged, lost, wrong item…). It's a normal order, so it shows up
// in Shipping and is batched, packed and labelled like any other.
//
// Only staff with the Shipping "Create reship orders" permission can do this.
import db from "./db.server";
import { logEvent } from "./shipping.server";

export class ReshipError extends Error {}

// Whether the reship takes stock: a second unit leaves the shelf when the first
// was damaged, lost or defective. When the item was never sent (left out of the
// box, or the wrong item went instead) the unit counted as sold the first time is
// still on the shelf, so this one leaves stock as it is. "Other": staff choose.
export const RESHIP_REASONS = [
  { reason: "Damaged in transit", takesStock: true },
  { reason: "Lost in transit", takesStock: true },
  { reason: "Defective item", takesStock: true },
  { reason: "Item never sent (missing from box)", takesStock: false },
  { reason: "Wrong item sent", takesStock: false },
  { reason: "Other", takesStock: null },
];
const reasonDef = (r) => RESHIP_REASONS.find((x) => x.reason === r) ?? null;

const ADDRESS = "firstName lastName company address1 address2 city provinceCode zip countryCodeV2 phone";

const ORDER = `#graphql
  query ReshipOrder($id: ID!) {
    order(id: $id) {
      id name currencyCode email phone cancelledAt
      customer { id displayName }
      shippingAddress { ${ADDRESS} }
      shippingLine { title }
      lineItems(first: 250) {
        nodes { id title variantTitle sku quantity requiresShipping variant { id } image { url(transform: { maxWidth: 80 }) } }
      }
    }
  }`;

const CREATE = `#graphql
  mutation ReshipCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name }
      userErrors { field message }
    }
  }`;

async function graphql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const body = await res.json();
  if (body?.errors?.length) throw new ReshipError(`Shopify: ${body.errors[0].message}`);
  return body.data;
}

const oneLine = (a) =>
  a ? [[a.firstName, a.lastName].filter(Boolean).join(" "), a.company, a.address1, a.address2, [a.city, a.provinceCode, a.zip].filter(Boolean).join(" "), a.countryCodeV2].filter(Boolean).join(", ") : null;

const validOrder = (id) => /^gid:\/\/shopify\/Order\/\d+$/.test(String(id ?? ""));

// What can be reshipped from an order, and its earlier reships
export async function reshipInfo(shop, admin, orderId) {
  if (!validOrder(orderId)) throw new ReshipError("Which order?");
  const o = (await graphql(admin, ORDER, { id: orderId }))?.order;
  if (!o) throw new ReshipError("That order isn't in Shopify.");
  const earlier = await db.shippingEvent.findMany({ where: { shop, orderName: o.name, type: "reship_created" }, orderBy: { id: "desc" }, take: 20 });
  return {
    orderId: o.id,
    orderName: o.name,
    customer: o.customer?.displayName ?? null,
    address: oneLine(o.shippingAddress),
    hasAddress: Boolean(o.shippingAddress),
    method: o.shippingLine?.title ?? null,
    lines: o.lineItems.nodes
      .filter((l) => l.requiresShipping !== false && l.quantity > 0)
      .map((l) => ({ id: l.id, title: l.title, variantTitle: l.variantTitle, sku: l.sku, quantity: l.quantity, image: l.image?.url ?? null })),
    reasons: RESHIP_REASONS,
    earlier: earlier.map((e) => ({ at: e.createdAt.toISOString(), by: e.userName, detail: e.detail })),
  };
}

// Make the replacement order. items: [{ lineItemId, quantity }]
// takeStock: only for "Other" (true / false); the other reasons decide it
export async function createReship(shop, admin, { orderId, items, reason, note = "", notify = true, takeStock = null }, user) {
  if (!validOrder(orderId)) throw new ReshipError("Which order?");
  const why = String(reason ?? "").trim();
  const def = reasonDef(why);
  if (!def) throw new ReshipError("Choose why it's being reshipped.");
  const extra = String(note ?? "").trim().slice(0, 500);
  if (why === "Other" && !extra) throw new ReshipError("Add a note saying why it's being reshipped.");
  const takes = def.takesStock ?? (takeStock === true ? true : takeStock === false ? false : null);
  if (takes === null) throw new ReshipError("Choose whether the reship takes the items out of stock.");
  const o = (await graphql(admin, ORDER, { id: orderId }))?.order;
  if (!o) throw new ReshipError("That order isn't in Shopify.");
  if (!o.shippingAddress) throw new ReshipError(`${o.name} has no shipping address to send it to.`);

  // Only items on the order, up to the amount ordered
  const byId = new Map(o.lineItems.nodes.filter((l) => l.requiresShipping !== false).map((l) => [l.id, l]));
  const chosen = [];
  for (const it of items ?? []) {
    const l = byId.get(String(it.lineItemId));
    const q = Math.floor(Number(it.quantity));
    if (!l || !(q > 0)) continue;
    if (q > l.quantity) throw new ReshipError(`${l.title}: only ${l.quantity} on ${o.name}.`);
    chosen.push({ l, q });
  }
  if (!chosen.length) throw new ReshipError("Choose at least one item to reship.");

  // A second click, or someone else at the same moment
  const recent = await db.shippingEvent.findFirst({ where: { shop, orderName: o.name, type: "reship_created", createdAt: { gte: new Date(Date.now() - 2 * 60_000) } } });
  if (recent) throw new ReshipError(`A reship of ${o.name} was made a moment ago (${recent.detail?.split(":")[0] ?? "see its history"}). Check it before making another.`);

  const zero = { shopMoney: { amount: "0.00", currencyCode: o.currencyCode } };
  const a = o.shippingAddress;
  const shippingAddress = Object.fromEntries(
    Object.entries({
      firstName: a.firstName,
      lastName: a.lastName,
      company: a.company,
      address1: a.address1,
      address2: a.address2,
      city: a.city,
      provinceCode: a.provinceCode,
      zip: a.zip,
      countryCode: a.countryCodeV2,
      phone: a.phone,
    }).filter(([, v]) => v),
  );
  const who = user?.name ?? "Staff";
  const order = {
    currency: o.currencyCode,
    lineItems: chosen.map(({ l, q }) =>
      l.variant?.id
        ? { variantId: l.variant.id, quantity: q, priceSet: zero, requiresShipping: true }
        : { title: l.title, quantity: q, priceSet: zero, requiresShipping: true, ...(l.sku ? { sku: l.sku } : {}) },
    ),
    shippingAddress,
    shippingLines: [{ title: o.shippingLine?.title || "Reship", priceSet: zero }],
    financialStatus: "PAID",
    tags: ["Reship", `Reship of ${o.name}`],
    note: `Reship of ${o.name}: ${why}${extra ? ` (${extra})` : ""}. ${takes ? "Stock taken" : "Stock unchanged (the first one never left)"}. Created by ${who} in MonkeyBean.`,
    customAttributes: [
      { key: "Reship of", value: o.name },
      { key: "Reship reason", value: why },
      { key: "Reshipped by", value: who },
      { key: "Reship stock", value: takes ? "Taken" : "Unchanged" },
    ],
    ...(o.customer?.id ? { customer: { toAssociate: { id: o.customer.id } } } : {}),
    ...(o.email ? { email: o.email } : {}),
  };
  const data = await graphql(admin, CREATE, {
    order,
    // Stock comes off as for any order, or isn't touched at all (never sent).
    // The customer isn't sent a receipt, only (if chosen) the shipping
    // confirmation with tracking.
    options: { inventoryBehaviour: takes ? "DECREMENT_OBEYING_POLICY" : "BYPASS", sendReceipt: false, sendFulfillmentReceipt: Boolean(notify) },
  });
  const errs = data?.orderCreate?.userErrors ?? [];
  if (errs.length) throw new ReshipError(`Shopify didn't make the reship: ${errs.map((e) => e.message).join("; ")}`);
  const made = data?.orderCreate?.order;
  if (!made) throw new ReshipError("Shopify didn't make the reship.");

  await db.reship.create({
    data: {
      shop,
      orderId: made.id,
      orderName: made.name,
      originalOrderId: o.id,
      originalName: o.name,
      reason: why,
      note: extra || null,
      takesStock: takes,
      items: JSON.stringify(chosen.map(({ l, q }) => ({ lineItemId: l.id, variantId: l.variant?.id ?? null, title: l.title, variantTitle: l.variantTitle, quantity: q }))),
      createdBy: user?.name ?? null,
    },
  });
  const what = chosen.map(({ l, q }) => `${q} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join(", ");
  const stock = takes ? "stock taken" : "stock unchanged";
  await logEvent(shop, { orderName: o.name, type: "reship_created", detail: `${made.name}: ${what} · ${why}${extra ? ` (${extra})` : ""} · ${stock}`, user });
  await logEvent(shop, { orderName: made.name, type: "reship_of", detail: `Reship of ${o.name}: ${what} · ${why}${extra ? ` (${extra})` : ""} · ${stock}`, user });
  return { id: made.id, name: made.name, number: made.id.split("/").pop(), items: what, takesStock: takes };
}
