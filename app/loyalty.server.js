import { randomBytes } from "node:crypto";
import db from "./db.server";
import { dayInStore, errorMessage, gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Loyalty program. Invite-only: only members added by staff (or through the
// private join link) earn, see or spend points; everyone else sees nothing.
//
// Points live in a ledger (LoyaltyEntry). The member row keeps totals for
// quick reads; recount() rebuilds them from the ledger after every change.
//   - Orders: 5 points per $ (setting), on the subtotal after
//     discounts (no shipping, tax or gift cards). Pending until the order ships
//     (or is paid, by setting); recalculated when the order is edited or
//     refunded, and taken back if it's cancelled.
//   - Bonuses: joining, birthday (once a year), following on social (once each).
//   - Rewards: points for a one-time Shopify discount code that only this
//     customer can use.
//   - VIP tiers: by spend in the last 12 months. Tiers don't change earning;
//     each member's tier goes on their Shopify customer record as a tag
//     ("VIP Gold"), so tier-only sales can target a customer segment.
//   - Points are called Yiggybeans (setting).
// ---------------------------------------------------------------------------

export class LoyaltyError extends Error {}

export const customerKey = (id) => {
  const s = String(id ?? "").split("/").pop();
  return /^\d+$/.test(s) ? s : null;
};
const customerGid = (key) => `gid://shopify/Customer/${key}`;
const json = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_TIERS = [
  { id: "bronze", name: "Bronze", threshold: 0, perks: "" },
  { id: "silver", name: "Silver", threshold: 250, perks: "Exclusive Silver sales" },
  { id: "gold", name: "Gold", threshold: 500, perks: "Exclusive Gold sales" },
];
export const DEFAULT_REWARDS = [
  { id: "r1", name: "$1 off", points: 100, amount: 1, minSubtotal: null },
  { id: "r10", name: "$10 off", points: 1000, amount: 10, minSubtotal: null },
];

export async function getLoyaltySettings(shop) {
  return db.loyaltySettings.upsert({ where: { shop }, create: { shop }, update: {} });
}

// The settings in a usable shape (lists parsed, sorted, defaults filled in)
export function programOf(st) {
  const tiers = (json(st.tiers, null) ?? DEFAULT_TIERS)
    .map((t) => ({ id: String(t.id), name: String(t.name), threshold: Number(t.threshold) || 0, perks: t.perks ?? "" }))
    .sort((a, b) => a.threshold - b.threshold);
  const rewards = (json(st.rewards, null) ?? DEFAULT_REWARDS)
    .map((r) => ({ id: String(r.id), name: String(r.name), points: Math.round(Number(r.points)) || 0, amount: Number(r.amount) || 0, minSubtotal: r.minSubtotal ? Number(r.minSubtotal) : null }))
    .filter((r) => r.points > 0 && r.amount > 0)
    .sort((a, b) => a.points - b.points);
  const socials = (json(st.socials, null) ?? [])
    .map((x) => ({ id: String(x.id), label: String(x.label), url: String(x.url), points: Math.round(Number(x.points)) || 0 }))
    .filter((x) => x.label && /^https:\/\//.test(x.url) && x.points > 0);
  return {
    enabled: st.enabled,
    programName: st.programName || "Rewards",
    rate: Number(st.pointsPerDollar) || 0,
    earnOn: st.earnOn === "paid" ? "paid" : "shipped",
    joinBonus: st.joinBonus,
    birthdayBonus: st.birthdayBonus,
    socials,
    tiers: tiers.length ? tiers : DEFAULT_TIERS,
    rewards,
    pointsName: st.pointsName || "Yiggybeans",
    pointName: st.pointName || "Yiggybean",
    tierTagPrefix: st.tierTagPrefix ?? "VIP ",
    currency: st.currency || "USD",
  };
}

export async function getProgram(shop) {
  return programOf(await getLoyaltySettings(shop));
}

const listInput = (raw, max) => {
  const v = typeof raw === "string" ? json(raw, null) : raw;
  if (!Array.isArray(v)) throw new LoyaltyError("A list couldn't be read.");
  if (v.length > max) throw new LoyaltyError(`Up to ${max} items.`);
  return v;
};
const id = () => randomBytes(4).toString("hex");

export async function saveLoyaltySettings(shop, input, user) {
  const num = (v, min, max, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new LoyaltyError(`${name} should be between ${min} and ${max}.`);
    return n;
  };
  const tiers = listInput(input.tiers, 10).map((t) => ({
    id: String(t.id || id()),
    name: String(t.name ?? "").trim().slice(0, 40),
    threshold: num(t.threshold, 0, 1000000, "Tier spend"),
    perks: String(t.perks ?? "").trim().slice(0, 200),
  }));
  if (!tiers.length) throw new LoyaltyError("Keep at least one tier.");
  if (tiers.some((t) => !t.name)) throw new LoyaltyError("Every tier needs a name.");
  if (!tiers.some((t) => t.threshold === 0)) throw new LoyaltyError("One tier needs to start at $0, so every member has a tier.");
  const rewards = listInput(input.rewards, 20).map((r) => ({
    id: String(r.id || id()),
    name: String(r.name ?? "").trim().slice(0, 60),
    points: Math.round(num(r.points, 1, 10000000, "Reward points")),
    amount: round2(num(r.amount, 0.01, 100000, "Reward amount")),
    minSubtotal: r.minSubtotal === "" || r.minSubtotal == null ? null : round2(num(r.minSubtotal, 0, 100000, "Minimum order")),
  }));
  if (rewards.some((r) => !r.name)) throw new LoyaltyError("Every reward needs a name.");
  const socials = listInput(input.socials, 10).map((x) => ({
    id: String(x.id || id()),
    label: String(x.label ?? "").trim().slice(0, 60),
    url: String(x.url ?? "").trim(),
    points: Math.round(num(x.points, 1, 100000, "Social points")),
  }));
  if (socials.some((x) => !x.label || !/^https:\/\/\S+$/.test(x.url))) throw new LoyaltyError("Each social needs a label and a link starting https://");
  const data = {
    enabled: Boolean(input.enabled),
    programName: String(input.programName ?? "").trim().slice(0, 60) || "Rewards",
    pointsPerDollar: num(input.pointsPerDollar, 0, 1000, "Points per $1"),
    earnOn: input.earnOn === "paid" ? "paid" : "shipped",
    joinBonus: Math.round(num(input.joinBonus, 0, 1000000, "Joining bonus")),
    birthdayBonus: Math.round(num(input.birthdayBonus, 0, 1000000, "Birthday bonus")),
    pointsName: String(input.pointsName ?? "").trim().slice(0, 30) || "Yiggybeans",
    pointName: String(input.pointName ?? "").trim().slice(0, 30) || "Yiggybean",
    tierTagPrefix: input.tierTagPrefix === undefined ? undefined : String(input.tierTagPrefix).replace(/,/g, "").slice(0, 30),
    tiers: JSON.stringify(tiers),
    rewards: JSON.stringify(rewards),
    socials: JSON.stringify(socials),
  };
  await getLoyaltySettings(shop);
  await db.loyaltySettings.update({ where: { shop }, data });
  console.log(`[loyalty] ${shop}: settings saved by ${user?.name ?? "staff"}`);
  // Tier names or thresholds may have moved
  const members = await db.loyaltyMember.findMany({ where: { shop, status: "active" }, select: { customerId: true } });
  for (const m of members) await recount(shop, m.customerId);
  kickTierTags(shop);
  return getProgram(shop);
}

// The shop's currency, read once (for "$5 off")
export async function ensureCurrency(shop, admin) {
  const st = await getLoyaltySettings(shop);
  if (st.currency || !admin) return st.currency || "USD";
  try {
    const data = await gql(admin, `#graphql
      query LoyaltyShopCurrency { shop { currencyCode } }`);
    const c = data?.shop?.currencyCode;
    if (c) await db.loyaltySettings.update({ where: { shop }, data: { currency: c } });
    return c || "USD";
  } catch {
    return "USD";
  }
}

export const money = (amount, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);

// ---------------------------------------------------------------------------
// Totals and tiers
// ---------------------------------------------------------------------------

export function tierFor(spend, tiers) {
  let t = tiers[0];
  for (const x of tiers) if (spend >= x.threshold) t = x;
  return t;
}

const YEAR_MS = 365 * 86400000;

// Rebuilds a member's balance, pending points, lifetime points and tier from the ledger
export async function recount(shop, customerId, now = new Date()) {
  const key = customerKey(customerId);
  const member = await db.loyaltyMember.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
  if (!member) return null;
  const program = await getProgram(shop);
  const entries = await db.loyaltyEntry.findMany({ where: { shop, customerId: key, status: { not: "void" } } });
  const points = entries.filter((e) => e.status === "available").reduce((n, e) => n + e.points, 0);
  const pending = entries.filter((e) => e.status === "pending").reduce((n, e) => n + e.points, 0);
  const lifetime = entries.filter((e) => e.status === "available" && e.points > 0 && e.kind !== "refund_reward").reduce((n, e) => n + e.points, 0);
  // Spend in the last 12 months: orders that still count
  const since = new Date(now.getTime() - YEAR_MS);
  const tierSpend = round2(
    entries.filter((e) => e.kind === "order" && e.orderedAt && e.orderedAt >= since).reduce((n, e) => n + (e.orderSubtotal ?? 0), 0),
  );
  const tier = tierFor(tierSpend, program.tiers);
  const updated = await db.loyaltyMember.update({ where: { id: member.id }, data: { points, pending, lifetime, tierSpend, tier: tier.id } });
  if (updated.status === "active" && updated.tierTag !== tierTagOf(program, tier)) kickTierTags(shop);
  return updated;
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function getMember(shop, customerId) {
  const key = customerKey(customerId);
  if (!key) return null;
  const m = await db.loyaltyMember.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
  return m && m.status === "active" ? m : null;
}

const CUSTOMER = `#graphql
  query LoyaltyCustomer($id: ID!) {
    customer(id: $id) { id displayName firstName defaultEmailAddress { emailAddress } }
  }`;

// Adds (or brings back) a member, with the joining bonus the first time
export async function addMember(shop, admin, customerId, { via = "admin", user = null } = {}) {
  const key = customerKey(customerId);
  if (!key) throw new LoyaltyError("That customer couldn't be found.");
  let info = null;
  if (admin) {
    const data = await gql(admin, CUSTOMER, { id: customerGid(key) });
    info = data?.customer;
    if (!info) throw new LoyaltyError("That customer couldn't be found in Shopify.");
  }
  const details = info
    ? { email: info.defaultEmailAddress?.emailAddress?.toLowerCase() ?? null, name: info.displayName ?? null, firstName: info.firstName ?? null }
    : {};
  const existing = await db.loyaltyMember.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
  let member;
  if (existing) {
    member = await db.loyaltyMember.update({
      where: { id: existing.id },
      data: { ...details, ...(existing.status !== "active" ? { status: "active", removedAt: null } : {}) },
    });
  } else {
    member = await db.loyaltyMember.create({ data: { shop, customerId: key, via, addedBy: user?.name ?? null, ...details } });
  }
  const program = await getProgram(shop);
  if (program.joinBonus > 0) await award(shop, key, { points: program.joinBonus, kind: "join", ref: "join", note: "Welcome bonus" });
  await recount(shop, key);
  return { member: await getMember(shop, key), added: !existing || existing.status !== "active" };
}

export async function removeMember(shop, customerId, user) {
  const key = customerKey(customerId);
  await db.loyaltyMember.updateMany({ where: { shop, customerId: key }, data: { status: "removed", removedAt: new Date() } });
  kickTierTags(shop); // takes the tier tag off
  console.log(`[loyalty] ${shop}: member ${key} removed by ${user?.name ?? "staff"}`);
}

// Adds a ledger entry once (ref makes it once-only). Returns the entry or null.
async function award(shop, customerId, { points, kind, ref = null, note = null, by = null, status = "available" }) {
  try {
    return await db.loyaltyEntry.create({
      data: { shop, customerId, points, kind, ref, note, by, status, availableAt: status === "available" ? new Date() : null },
    });
  } catch (e) {
    if (e?.code === "P2002") return null; // already given
    throw e;
  }
}

export async function adjustPoints(shop, customerId, points, note, user) {
  const key = customerKey(customerId);
  const n = Math.round(Number(points));
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 10000000) throw new LoyaltyError("Enter a number, e.g. 250 or -100.");
  const why = String(note ?? "").trim();
  if (!why) throw new LoyaltyError("Add a short reason.");
  if (!(await getMember(shop, key))) throw new LoyaltyError("That customer isn't a member.");
  await award(shop, key, { points: n, kind: "adjust", note: why.slice(0, 200), by: user?.name ?? null });
  return recount(shop, key);
}

// ---------------------------------------------------------------------------
// Join link (invite-only sign-up)
// ---------------------------------------------------------------------------

export async function setInvite(shop, { enabled, max, regenerate }) {
  const st = await getLoyaltySettings(shop);
  const data = { inviteEnabled: Boolean(enabled) };
  if (max !== undefined) data.inviteMax = max === "" || max == null ? null : Math.max(1, Math.round(Number(max)) || 1);
  if (regenerate || !st.inviteToken) {
    data.inviteToken = randomBytes(9).toString("base64url");
    data.inviteUses = 0;
  }
  return db.loyaltySettings.update({ where: { shop }, data });
}

export async function joinWithInvite(shop, admin, token, customerId) {
  const st = await getLoyaltySettings(shop);
  if (!st.inviteEnabled || !st.inviteToken || st.inviteToken !== token) return { ok: false, reason: "invalid" };
  const key = customerKey(customerId);
  if (await getMember(shop, key)) return { ok: true, already: true };
  if (st.inviteMax && st.inviteUses >= st.inviteMax) return { ok: false, reason: "full" };
  const r = await addMember(shop, admin, key, { via: "invite" });
  await db.loyaltySettings.update({ where: { shop }, data: { inviteUses: { increment: 1 } } });
  return { ok: true, member: r.member };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

// What an order earns: subtotal after discounts, without gift cards; nothing if cancelled
export function orderEarning(order, rate) {
  if (order?.cancelled_at) return { subtotal: 0, points: 0 };
  let subtotal = Number(order?.current_subtotal_price ?? order?.subtotal_price ?? 0);
  for (const li of order?.line_items ?? []) {
    if (li.gift_card) subtotal -= Number(li.price || 0) * (Number(li.current_quantity ?? li.quantity) || 0);
  }
  subtotal = Math.max(0, round2(subtotal));
  if (["refunded", "voided"].includes(order?.financial_status)) return { subtotal: 0, points: 0 };
  return { subtotal, points: Math.floor(subtotal * rate + 1e-9) };
}

const isPaid = (o) => ["paid", "partially_refunded", "partially_paid"].includes(o?.financial_status);
const isShipped = (o) => o?.fulfillment_status === "fulfilled";

// orders/create and orders/updated: keeps the order's points in line with the order
export async function syncLoyaltyOrder(shop, order) {
  const key = customerKey(order?.customer?.id);
  const orderId = order?.id ? `gid://shopify/Order/${order.id}` : null;
  if (!key || !orderId) return null;
  // A reward code used on this order
  const codes = (order.discount_codes ?? []).map((d) => String(d.code ?? "").toUpperCase()).filter(Boolean);
  if (codes.length) {
    await db.loyaltyRedemption.updateMany({
      where: { shop, code: { in: codes }, status: "issued" },
      data: { status: "used", usedAt: new Date(), orderId, orderName: order.name ?? null },
    });
  }
  const member = await db.loyaltyMember.findUnique({ where: { shop_customerId: { shop, customerId: key } } });
  const base = await db.loyaltyEntry.findFirst({ where: { shop, customerId: key, kind: "order", orderId } });
  const orderedAt = new Date(order.created_at ?? order.processed_at ?? Date.now());
  // Only orders placed while a member earn
  if (!base && (!member || member.status !== "active" || orderedAt < member.joinedAt)) return null;

  const program = await getProgram(shop);
  const { subtotal, points } = orderEarning(order, program.rate);
  const ready = program.earnOn === "paid" ? isPaid(order) : isShipped(order);

  if (!base) {
    if (points <= 0) return null;
    const entry = await award(shop, key, {
      points,
      kind: "order",
      ref: `order:${order.id}`,
      status: ready ? "available" : "pending",
      note: null,
    });
    if (entry) {
      await db.loyaltyEntry.update({
        where: { id: entry.id },
        data: { orderId, orderName: order.name ?? null, orderSubtotal: subtotal, orderedAt },
      });
    }
  } else {
    const adjustments = await db.loyaltyEntry.findMany({ where: { shop, customerId: key, kind: "order_adjust", orderId, status: { not: "void" } } });
    const adjusted = adjustments.reduce((n, e) => n + e.points, 0);
    if (base.status === "pending") {
      // Not credited yet: just change it
      await db.loyaltyEntry.update({
        where: { id: base.id },
        data: {
          points,
          orderSubtotal: subtotal,
          ...(points <= 0 ? { status: "void" } : ready ? { status: "available", availableAt: new Date() } : {}),
        },
      });
    } else if (base.status === "available") {
      const diff = points - (base.points + adjusted);
      await db.loyaltyEntry.update({ where: { id: base.id }, data: { orderSubtotal: subtotal } });
      if (diff !== 0) {
        await award(shop, key, {
          points: diff,
          kind: "order_adjust",
          ref: `order-adj:${order.id}:${order.updated_at ?? Date.now()}`,
          note: order.cancelled_at ? `${order.name} was cancelled` : diff < 0 ? `${order.name} was refunded or edited` : `${order.name} was edited`,
        }).then((e) => e && db.loyaltyEntry.update({ where: { id: e.id }, data: { orderId, orderName: order.name ?? null } }));
      }
    } else if (base.status === "void" && points > 0) {
      // Uncancelled / restored
      await db.loyaltyEntry.update({ where: { id: base.id }, data: { points, orderSubtotal: subtotal, status: ready ? "available" : "pending" } });
    }
  }

  return recount(shop, key);
}

// ---------------------------------------------------------------------------
// Bonuses
// ---------------------------------------------------------------------------

const BIRTHDAY = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export async function setBirthday(shop, customerId, mmdd, { staff = false } = {}) {
  const m = await getMember(shop, customerId);
  if (!m) throw new LoyaltyError("Only members can do this.");
  const v = String(mmdd ?? "").trim();
  if (!BIRTHDAY.test(v)) throw new LoyaltyError("Choose a month and day.");
  if (m.birthday && !staff) throw new LoyaltyError("Your birthday is already saved. Contact us if it needs changing.");
  await db.loyaltyMember.update({ where: { id: m.id }, data: { birthday: v } });
  await checkBirthdays(m.shop, new Date(), [m.customerId]);
  return getMember(shop, customerId);
}

// Gives the birthday bonus on the day (store time), once a year
export async function checkBirthdays(shop, now = new Date(), only = null) {
  const program = await getProgram(shop);
  if (!program.enabled || program.birthdayBonus <= 0) return 0;
  const today = dayInStore(now); // YYYY-MM-DD
  const year = Number(today.slice(0, 4));
  const mmdd = today.slice(5);
  // Feb 29 birthdays get theirs on Feb 28 in other years
  const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
  const days = mmdd === "02-28" && !leap ? ["02-28", "02-29"] : [mmdd];
  const due = await db.loyaltyMember.findMany({
    where: { shop, status: "active", birthday: { in: days }, ...(only ? { customerId: { in: only } } : {}), OR: [{ birthdayAwardedYear: null }, { birthdayAwardedYear: { lt: year } }] },
  });
  let n = 0;
  for (const m of due) {
    const e = await award(shop, m.customerId, { points: program.birthdayBonus, kind: "birthday", ref: `birthday:${year}`, note: "Happy birthday!" });
    await db.loyaltyMember.update({ where: { id: m.id }, data: { birthdayAwardedYear: year } });
    if (e) {
      n++;
      await recount(shop, m.customerId);
    }
  }
  return n;
}

export async function claimSocial(shop, customerId, socialId) {
  const m = await getMember(shop, customerId);
  if (!m) throw new LoyaltyError("Only members can do this.");
  const program = await getProgram(shop);
  const s = program.socials.find((x) => x.id === String(socialId));
  if (!s) throw new LoyaltyError("That isn't available anymore.");
  const e = await award(shop, m.customerId, { points: s.points, kind: "social", ref: `social:${s.id}`, note: s.label });
  await recount(shop, m.customerId);
  return { awarded: Boolean(e), points: e ? s.points : 0 };
}

// ---------------------------------------------------------------------------
// Rewards: points for a one-time discount code
// ---------------------------------------------------------------------------

const DISCOUNT_CREATE = `#graphql
  mutation LoyaltyDiscountCreate($discount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $discount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }`;

const DISCOUNT_DELETE = `#graphql
  mutation LoyaltyDiscountDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors { field message }
    }
  }`;

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newCode() {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_CHARS[b[i] % CODE_CHARS.length];
  return `MB-${s.slice(0, 4)}-${s.slice(4)}`;
}

const locks = new Map(); // one redemption at a time per customer
async function withLock(key, fn) {
  while (locks.get(key)) await locks.get(key);
  let release;
  locks.set(key, new Promise((r) => (release = r)));
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

export async function redeem(shop, admin, customerId, rewardId) {
  const key = customerKey(customerId);
  return withLock(`${shop}|${key}`, async () => {
    const m = await recount(shop, key);
    if (!m || m.status !== "active") throw new LoyaltyError("Only members can do this.");
    const program = await getProgram(shop);
    if (!program.enabled) throw new LoyaltyError("Rewards are paused right now.");
    const reward = program.rewards.find((r) => r.id === String(rewardId));
    if (!reward) throw new LoyaltyError("That reward isn't available anymore.");
    if (m.points < reward.points) throw new LoyaltyError(`You need ${(reward.points - m.points).toLocaleString()} more ${program.pointsName} for this.`);

    const code = newCode();
    const entry = await award(shop, key, { points: -reward.points, kind: "redeem", note: reward.name });
    const red = await db.loyaltyRedemption.create({
      data: { shop, customerId: key, rewardId: reward.id, rewardName: reward.name, points: reward.points, amount: reward.amount, minSubtotal: reward.minSubtotal, code, entryId: entry.id, expiresAt: null },
    });
    await db.loyaltyEntry.update({ where: { id: entry.id }, data: { ref: `redeem:${red.id}` } });
    try {
      const data = await gql(admin, DISCOUNT_CREATE, {
        discount: {
          title: `${program.programName}: ${reward.name} for ${m.email ?? `customer ${key}`}`,
          code,
          startsAt: new Date().toISOString(),
          // Never expires
          context: { customers: { add: [customerGid(key)] } },
          customerGets: { value: { discountAmount: { amount: String(reward.amount), appliesOnEachItem: false } }, items: { all: true } },
          ...(reward.minSubtotal ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: String(reward.minSubtotal) } } } : {}),
          usageLimit: 1,
          appliesOncePerCustomer: true,
          combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
        },
      });
      const errs = data?.discountCodeBasicCreate?.userErrors ?? [];
      const discountId = data?.discountCodeBasicCreate?.codeDiscountNode?.id;
      if (errs.length || !discountId) throw new Error(errs.map((e) => e.message).join("; ") || "Shopify didn't create the code.");
      await db.loyaltyRedemption.update({ where: { id: red.id }, data: { discountId } });
    } catch (e) {
      // Give the points back
      await db.loyaltyEntry.update({ where: { id: entry.id }, data: { status: "void" } });
      await db.loyaltyRedemption.update({ where: { id: red.id }, data: { status: "failed", error: errorMessage(e).slice(0, 300) } });
      await recount(shop, key);
      console.error(`[loyalty] ${shop}: discount for ${key} failed:`, errorMessage(e));
      throw new LoyaltyError(`We couldn't create your code just now. Your ${program.pointsName} are safe; please try again in a minute.`);
    }
    const after = await recount(shop, key);
    return { code, amount: reward.amount, rewardName: reward.name, points: after.points };
  });
}

// Staff: cancel an unused code and give the points back
export async function cancelRedemption(shop, admin, redemptionId, user) {
  const red = await db.loyaltyRedemption.findFirst({ where: { shop, id: Number(redemptionId) } });
  if (!red) throw new LoyaltyError("That code couldn't be found.");
  if (red.status !== "issued") throw new LoyaltyError(`That code is already ${red.status}.`);
  if (red.discountId) {
    const data = await gql(admin, DISCOUNT_DELETE, { id: red.discountId });
    const errs = data?.discountCodeDelete?.userErrors ?? [];
    if (errs.length) throw new LoyaltyError(errs.map((e) => e.message).join("; "));
  }
  await db.loyaltyRedemption.update({ where: { id: red.id }, data: { status: "cancelled" } });
  await award(shop, red.customerId, { points: red.points, kind: "refund_reward", ref: `refund:${red.id}`, note: `${red.code} cancelled`, by: user?.name ?? null });
  return recount(shop, red.customerId);
}

// ---------------------------------------------------------------------------
// What the storefront shows a member
// ---------------------------------------------------------------------------

const KIND_TEXT = {
  order: (e) => `Order ${e.orderName ?? ""}`.trim(),
  order_adjust: (e) => e.note ?? `Order ${e.orderName ?? ""} changed`,
  join: () => "Welcome bonus",
  birthday: () => "Birthday bonus",
  social: (e) => `Followed: ${e.note ?? "social"}`,
  redeem: (e) => `Redeemed: ${e.note ?? "reward"}`,
  refund_reward: (e) => e.note ?? "Reward cancelled and given back",
  adjust: (e) => e.note ?? "Adjustment",
};
export const entryText = (e) => (KIND_TEXT[e.kind] ?? (() => e.note ?? e.kind))(e);

export async function memberView(shop, customerId) {
  const m = await recount(shop, customerId);
  if (!m || m.status !== "active") return null;
  const program = await getProgram(shop);
  const [entries, codes, socialsDone] = await Promise.all([
    db.loyaltyEntry.findMany({ where: { shop, customerId: m.customerId, status: { not: "void" } }, orderBy: { createdAt: "desc" }, take: 50 }),
    db.loyaltyRedemption.findMany({ where: { shop, customerId: m.customerId, status: { in: ["issued", "used"] } }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.loyaltyEntry.findMany({ where: { shop, customerId: m.customerId, kind: "social" }, select: { ref: true } }),
  ]);
  const tier = program.tiers.find((t) => t.id === m.tier) ?? program.tiers[0];
  const next = program.tiers.find((t) => t.threshold > m.tierSpend) ?? null;
  const done = new Set(socialsDone.map((e) => e.ref));
  const now = Date.now();
  return {
    program,
    member: {
      customerId: m.customerId,
      firstName: m.firstName,
      points: m.points,
      pending: m.pending,
      lifetime: m.lifetime,
      birthday: m.birthday,
      tierSpend: m.tierSpend,
    },
    tier,
    next: next ? { ...next, toGo: round2(next.threshold - m.tierSpend) } : null,
    history: entries.map((e) => ({ at: e.createdAt.toISOString(), text: entryText(e), points: e.points, pending: e.status === "pending" })),
    codes: codes.map((c) => ({
      code: c.code,
      name: c.rewardName,
      amount: c.amount,
      minSubtotal: c.minSubtotal,
      status: c.status === "issued" && c.expiresAt && c.expiresAt.getTime() < now ? "expired" : c.status,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      usedOn: c.orderName,
    })),
    socials: program.socials.map((s) => ({ ...s, done: done.has(`social:${s.id}`) })),
  };
}

// The small payload for the header badge and "earn X points" line
export async function memberBadge(shop, customerId) {
  const m = await getMember(shop, customerId);
  if (!m) return { member: false };
  const program = await getProgram(shop);
  if (!program.enabled) return { member: false };
  const tier = program.tiers.find((t) => t.id === m.tier) ?? program.tiers[0];
  return { member: true, points: m.points, pending: m.pending, tier: tier.name, rate: program.rate, programName: program.programName, pointsName: program.pointsName, pointName: program.pointName };
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

const CUSTOMER_SEARCH = `#graphql
  query LoyaltyCustomerSearch($q: String!) {
    customers(first: 10, query: $q) {
      nodes { id displayName defaultEmailAddress { emailAddress } numberOfOrders }
    }
  }`;

export async function searchCustomers(shop, admin, q) {
  const text = String(q ?? "").trim();
  if (text.length < 2) return [];
  const data = await gql(admin, CUSTOMER_SEARCH, { q: text });
  const nodes = data?.customers?.nodes ?? [];
  const keys = nodes.map((n) => customerKey(n.id));
  const members = await db.loyaltyMember.findMany({ where: { shop, customerId: { in: keys }, status: "active" }, select: { customerId: true } });
  const isMember = new Set(members.map((m) => m.customerId));
  return nodes.map((n) => ({
    customerId: customerKey(n.id),
    name: n.displayName,
    email: n.defaultEmailAddress?.emailAddress ?? null,
    orders: Number(n.numberOfOrders ?? 0),
    member: isMember.has(customerKey(n.id)),
  }));
}

export async function listMembers(shop, { q = "", status = "active", take = 200 } = {}) {
  const text = String(q ?? "").trim();
  const rows = await db.loyaltyMember.findMany({
    where: {
      shop,
      status,
      ...(text ? { OR: [{ email: { contains: text, mode: "insensitive" } }, { name: { contains: text, mode: "insensitive" } }] } : {}),
    },
    orderBy: { joinedAt: "desc" },
    take,
  });
  return rows.map((m) => ({
    customerId: m.customerId,
    name: m.name,
    email: m.email,
    points: m.points,
    pending: m.pending,
    lifetime: m.lifetime,
    tier: m.tier,
    tierSpend: m.tierSpend,
    birthday: m.birthday,
    via: m.via,
    joinedAt: m.joinedAt.toISOString(),
  }));
}

export async function memberHistory(shop, customerId) {
  const key = customerKey(customerId);
  const [entries, codes] = await Promise.all([
    db.loyaltyEntry.findMany({ where: { shop, customerId: key }, orderBy: { createdAt: "desc" }, take: 100 }),
    db.loyaltyRedemption.findMany({ where: { shop, customerId: key }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return {
    entries: entries.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), text: entryText(e), points: e.points, status: e.status, by: e.by, kind: e.kind })),
    codes: codes.map((c) => ({ id: c.id, code: c.code, name: c.rewardName, points: c.points, status: c.status, error: c.error, createdAt: c.createdAt.toISOString(), expiresAt: c.expiresAt?.toISOString() ?? null, usedOn: c.orderName })),
  };
}

export async function recentActivity(shop, take = 100) {
  const rows = await db.loyaltyEntry.findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take });
  const keys = [...new Set(rows.map((r) => r.customerId))];
  const members = await db.loyaltyMember.findMany({ where: { shop, customerId: { in: keys } }, select: { customerId: true, name: true, email: true } });
  const who = new Map(members.map((m) => [m.customerId, m.name ?? m.email ?? m.customerId]));
  return rows.map((e) => ({ id: e.id, at: e.createdAt.toISOString(), customerId: e.customerId, who: who.get(e.customerId) ?? e.customerId, text: entryText(e), points: e.points, status: e.status, by: e.by }));
}

export async function loyaltyStats(shop) {
  const [members, sums, issued, used, codesValue] = await Promise.all([
    db.loyaltyMember.count({ where: { shop, status: "active" } }),
    db.loyaltyMember.aggregate({ where: { shop, status: "active" }, _sum: { points: true, pending: true, lifetime: true } }),
    db.loyaltyRedemption.count({ where: { shop, status: { in: ["issued", "used"] } } }),
    db.loyaltyRedemption.count({ where: { shop, status: "used" } }),
    db.loyaltyRedemption.aggregate({ where: { shop, status: "used" }, _sum: { amount: true } }),
  ]);
  return {
    members,
    points: sums._sum.points ?? 0,
    pending: sums._sum.pending ?? 0,
    lifetime: sums._sum.lifetime ?? 0,
    codesIssued: issued,
    codesUsed: used,
    discountGiven: codesValue._sum.amount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Tier tags on customers ("VIP Gold"): for tier-only sales, make a customer
// segment "customer_tags CONTAINS 'VIP Gold'" and a discount for that segment.
// ---------------------------------------------------------------------------

export const tierTagOf = (program, tier) => (tier ? `${program.tierTagPrefix}${tier.name}`.trim() : null);

const TAGS_ADD = `#graphql
  mutation LoyaltyTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;
const TAGS_REMOVE = `#graphql
  mutation LoyaltyTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

async function tagCall(admin, mutation, customerId, tag) {
  const data = await gql(admin, mutation, { id: customerGid(customerId), tags: [tag] });
  const r = data?.tagsAdd ?? data?.tagsRemove;
  if (r?.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
}

// Puts each member's tier tag on (and old ones off). Removed members lose theirs.
export async function syncTierTags(shop, admin, { limit = 200 } = {}) {
  const program = await getProgram(shop);
  const rows = await db.loyaltyMember.findMany({ where: { shop, OR: [{ status: "active" }, { tierTag: { not: null } }] } });
  let changes = 0;
  for (const m of rows) {
    if (changes >= limit) break;
    const tier = m.status === "active" ? program.tiers.find((t) => t.id === m.tier) ?? program.tiers[0] : null;
    const want = tierTagOf(program, tier);
    if (want === m.tierTag) continue;
    changes++;
    try {
      if (m.tierTag) await tagCall(admin, TAGS_REMOVE, m.customerId, m.tierTag);
      if (want) await tagCall(admin, TAGS_ADD, m.customerId, want);
      await db.loyaltyMember.update({ where: { id: m.id }, data: { tierTag: want } });
    } catch (e) {
      console.error(`[loyalty] ${shop}: tier tag for ${m.customerId}:`, errorMessage(e));
    }
  }
  return { changes, more: changes >= limit };
}

const tagTimers = new Map();
export function kickTierTags(shop, ms = 3000) {
  if (process.env.NODE_ENV === "test" || tagTimers.has(shop)) return;
  tagTimers.set(
    shop,
    setTimeout(async () => {
      tagTimers.delete(shop);
      try {
        const { unauthenticated } = await import("./shopify.server");
        const { admin } = await unauthenticated.admin(shop);
        const r = await syncTierTags(shop, admin);
        if (r.more) kickTierTags(shop, 5000);
      } catch (e) {
        console.error(`[loyalty] ${shop}: tier tags:`, errorMessage(e));
      }
    }, ms),
  );
}

// ---------------------------------------------------------------------------
// Daily: birthdays (checked hourly, given once)
// ---------------------------------------------------------------------------

const lastRecount = new Map();
async function birthdayRun() {
  const shops = await db.loyaltySettings.findMany({ where: { enabled: true }, select: { shop: true } });
  const day = dayInStore(new Date());
  for (const { shop } of shops) {
    await checkBirthdays(shop).catch((e) => console.error(`[loyalty] ${shop} birthdays:`, errorMessage(e)));
    // Once a day: tiers move as orders pass the 12-month mark
    if (lastRecount.get(shop) !== day) {
      lastRecount.set(shop, day);
      const members = await db.loyaltyMember.findMany({ where: { shop, status: "active" }, select: { customerId: true } });
      for (const m of members) await recount(shop, m.customerId).catch(() => {});
    }
  }
}
if (!globalThis.__loyaltyTimer && process.env.NODE_ENV !== "test") {
  globalThis.__loyaltyTimer = setInterval(() => birthdayRun().catch(() => {}), 60 * 60 * 1000);
  setTimeout(() => birthdayRun().catch(() => {}), 60 * 1000);
}

