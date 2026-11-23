// Tickets: change a customer's shipping address on all their open orders at once
// (e.g. "I moved, please ship everything to my new place").
//
// Open = not cancelled and not fully shipped. Orders whose label was already
// bought in MonkeyBean are locked: the label would still carry the old address.
import db from "./db.server";
import { logEvent, refreshNotices } from "./shipping.server";

export class AddressError extends Error {}

const ADDRESS_FIELDS = "firstName lastName company address1 address2 city province provinceCode zip country countryCodeV2 phone";

const OPEN_ORDERS = `#graphql
  query TicketOpenOrders($id: ID!) {
    customer(id: $id) {
      id displayName
      defaultAddress { ${ADDRESS_FIELDS} }
      orders(first: 50, reverse: true, query: "status:open") {
        nodes {
          id name createdAt cancelledAt closed displayFulfillmentStatus
          shippingAddress { ${ADDRESS_FIELDS} }
        }
      }
    }
  }`;

const UPDATE = `#graphql
  mutation TicketOrderAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id shippingAddress { ${ADDRESS_FIELDS} } }
      userErrors { field message }
    }
  }`;

// Shipped in full, or nothing left to ship
const DONE = new Set(["FULFILLED", "RESTOCKED", "PARTIALLY_RETURNED", "RETURNED"]);

const oneLine = (a) =>
  a
    ? [[a.firstName, a.lastName].filter(Boolean).join(" "), a.company, a.address1, a.address2, [a.city, a.provinceCode ?? a.province, a.zip].filter(Boolean).join(" "), a.countryCodeV2 ?? a.country]
        .filter(Boolean)
        .join(", ")
    : null;

// Form values from a Shopify address
const formOf = (a) => ({
  firstName: a?.firstName ?? "",
  lastName: a?.lastName ?? "",
  company: a?.company ?? "",
  address1: a?.address1 ?? "",
  address2: a?.address2 ?? "",
  city: a?.city ?? "",
  provinceCode: a?.provinceCode ?? "",
  zip: a?.zip ?? "",
  countryCode: a?.countryCodeV2 ?? "US",
  phone: a?.phone ?? "",
});

async function graphql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const body = await res.json();
  if (body?.errors?.length) throw new AddressError(`Shopify: ${body.errors[0].message}`);
  return body.data;
}

const validCustomer = (id) => /^gid:\/\/shopify\/Customer\/\d+$/.test(String(id ?? ""));

// The customer's open orders, which can be changed, and a starting address
export async function openOrders(shop, admin, customerId) {
  if (!validCustomer(customerId)) throw new AddressError("Find the Shopify customer first.");
  const data = await graphql(admin, OPEN_ORDERS, { id: customerId });
  const c = data?.customer;
  if (!c) throw new AddressError("That customer isn't in Shopify any more.");
  const orders = (c.orders?.nodes ?? []).filter((o) => !o.cancelledAt && !o.closed && !DONE.has(o.displayFulfillmentStatus));
  const parts = orders.length
    ? await db.shipment.findMany({ where: { shop, orderId: { in: orders.map((o) => o.id) } }, select: { orderId: true, state: true, labelStatus: true, batchId: true } })
    : [];
  const batchIds = [...new Set(parts.map((p) => p.batchId).filter(Boolean))];
  const batches = new Map((batchIds.length ? await db.batch.findMany({ where: { shop, id: { in: batchIds } } }) : []).map((b) => [b.id, b]));
  return {
    customer: { id: c.id, name: c.displayName },
    // Newest open order's address (what they used last), else their default
    start: formOf(orders[0]?.shippingAddress ?? c.defaultAddress),
    orders: orders.map((o) => {
      const mine = parts.filter((p) => p.orderId === o.id && ["waiting", "ready", "batched", "packed", "labeling"].includes(p.state));
      const label = mine.some((p) => p.labelStatus === "bought" || p.labelStatus === "buying");
      const b = mine.map((p) => batches.get(p.batchId)).find(Boolean);
      return {
        id: o.id,
        name: o.name,
        at: o.createdAt,
        fulfilled: o.displayFulfillmentStatus,
        address: oneLine(o.shippingAddress),
        noAddress: !o.shippingAddress,
        locked: label ? "A shipping label was already bought with the old address." : null,
        warning: b ? `In ${b.name ? `${b.tag} · ${b.name}` : b.tag}: reprint its packing slip.` : null,
      };
    }),
  };
}

// Clean up what staff typed; Shopify does the real checking
export function addressInput(form) {
  const v = (k, max = 255) => String(form?.[k] ?? "").trim().slice(0, max);
  const a = {
    firstName: v("firstName"),
    lastName: v("lastName"),
    company: v("company"),
    address1: v("address1"),
    address2: v("address2"),
    city: v("city"),
    provinceCode: v("provinceCode", 10).toUpperCase(),
    zip: v("zip", 20).toUpperCase(),
    countryCode: v("countryCode", 10).toUpperCase(),
    phone: v("phone", 40),
  };
  if (!a.address1) throw new AddressError("Enter the street address.");
  if (!a.city) throw new AddressError("Enter the city.");
  if (!/^[A-Z]{2}$/.test(a.countryCode)) throw new AddressError("Enter the country as a two-letter code, like US or CA.");
  if (!a.lastName && !a.firstName && !a.company) throw new AddressError("Enter a name to ship to.");
  // Empty fields are left out rather than sent as blanks
  return Object.fromEntries(Object.entries(a).filter(([, x]) => x !== ""));
}

// Change the address on the chosen orders. Each order is checked again here
// (still the customer's, still open, no label) before it's changed.
export async function changeAddresses(shop, admin, { ticketId, customerId, orderIds, address, user }) {
  const input = addressInput(address);
  const wanted = [...new Set((orderIds ?? []).map(String))];
  if (!wanted.length) throw new AddressError("Choose at least one order.");
  const current = await openOrders(shop, admin, customerId);
  const byId = new Map(current.orders.map((o) => [o.id, o]));
  const results = [];
  for (const id of wanted) {
    const o = byId.get(id);
    if (!o) {
      results.push({ id, name: null, ok: false, error: "Not one of this customer's open orders." });
      continue;
    }
    if (o.locked) {
      results.push({ id, name: o.name, ok: false, error: o.locked });
      continue;
    }
    try {
      const data = await graphql(admin, UPDATE, { input: { id, shippingAddress: input } });
      const errs = data?.orderUpdate?.userErrors ?? [];
      if (errs.length) results.push({ id, name: o.name, ok: false, error: errs.map((e) => e.message).join("; ") });
      else results.push({ id, name: o.name, ok: true, before: o.address, warning: o.warning });
    } catch (e) {
      results.push({ id, name: o.name, ok: false, error: e?.message ?? String(e) });
    }
  }
  const changed = results.filter((r) => r.ok);
  // In each order's history too
  const newLine = oneLine({ ...input, countryCodeV2: input.countryCode });
  for (const r of changed) {
    const s = await db.shipment.findFirst({ where: { shop, orderId: r.id }, orderBy: { id: "desc" }, select: { id: true } });
    await logEvent(shop, { shipmentId: s?.id ?? null, orderName: r.name, type: "address_changed", detail: `From ticket: ${r.before ?? "(none)"} → ${newLine}`, user }).catch(() => {});
  }
  // Shipping's address check (Shopify's "may be invalid" warning) reads them again
  if (changed.length) await refreshNotices(shop, admin, { orderIds: changed.map((r) => r.id) }).catch((e) => console.error("[tickets] address recheck:", e?.message ?? e));
  // What was done, on the ticket
  if (ticketId && (changed.length || results.length)) {
    const t = await db.ticket.findFirst({ where: { shop, id: Number(ticketId) } });
    if (t) {
      const lines = [
        changed.length ? `Changed the shipping address on ${changed.map((r) => r.name).join(", ")} to: ${oneLine({ ...input, countryCodeV2: input.countryCode })}` : "Tried to change shipping addresses:",
        ...changed.filter((r) => r.before).map((r) => `${r.name} was: ${r.before}`),
        ...results.filter((r) => !r.ok).map((r) => `${r.name ?? r.id} not changed: ${r.error}`),
      ];
      await db.ticketMessage.create({
        data: { shop, ticketId: t.id, kind: "note", body: lines.join("\n").slice(0, 20000), staffName: user?.name ?? null, staffId: user?.id ?? null, sentAt: new Date() },
      });
    }
  }
  return { results, changed: changed.length };
}
