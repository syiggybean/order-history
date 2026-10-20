import { randomBytes } from "node:crypto";
import db from "./db.server";
import { deliverQueued, mailFrom, sendNow } from "./mailer.server";

// ---------------------------------------------------------------------------
// Pre-order notification emails: sign-ups, sending, open/click tracking and
// the orders that come from them.
// ---------------------------------------------------------------------------

const STORE_TZ = "America/Los_Angeles";
const PINK = "#FBACBB";
const MATCH_DAYS = 14; // an order counts for an email sent within this many days
export const REF_ATTRIBUTE = "_oh_ref"; // cart attribute set when arriving from an email

const newToken = () => randomBytes(18).toString("base64url");
const appUrl = () => (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");

export class NotifyError extends Error {}

// Test emails are logged like real ones but left out of every total
export const TEST_KIND = "test";
const REAL = { kind: { not: TEST_KIND } };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(shop) {
  return db.preorderSettings.upsert({ where: { shop }, create: { shop }, update: {} });
}

export async function saveSettings(shop, input) {
  const n = (v, min, max, fallback) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
  };
  const current = await getSettings(shop);
  return db.preorderSettings.update({
    where: { shop },
    data: {
      restockThreshold: n(input.restockThreshold, 0, 100000, current.restockThreshold),
      reminderHours: n(input.reminderHours, 0, 24 * 14, current.reminderHours),
      fromName: input.fromName != null ? String(input.fromName).trim().slice(0, 80) || null : current.fromName,
      ...(input.locationId !== undefined ? { locationId: input.locationId || null } : {}),
    },
  });
}

// The store's web address, for links in emails
export async function storeUrl(shop, admin) {
  const s = await getSettings(shop);
  if (s.storeUrl) return s.storeUrl;
  let url = `https://${shop}`;
  try {
    const res = await admin.graphql(`#graphql
      { shop { primaryDomain { url } } }`);
    url = (await res.json()).data?.shop?.primaryDomain?.url ?? url;
  } catch {
    // fall back to the myshopify address
  }
  await db.preorderSettings.update({ where: { shop }, data: { storeUrl: url } });
  return url;
}

// ---------------------------------------------------------------------------
// Sign-ups
// ---------------------------------------------------------------------------

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s.]{2,}$/;

export async function subscribe(shop, { productId, email, customerId }) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(e)) throw new NotifyError("Please enter a valid email address.");
  const window = await db.preorderWindow.findUnique({ where: { shop_productId: { shop, productId } } });
  if (!window) throw new NotifyError("Sign-ups aren't open for this product.");
  const existing = await db.notifySubscriber.findUnique({ where: { shop_productId_email: { shop, productId, email: e } } });
  if (existing) {
    // Signing up again turns emails back on
    if (existing.unsubscribedAt || existing.purchasedAt) {
      await db.notifySubscriber.update({ where: { id: existing.id }, data: { unsubscribedAt: null, purchasedAt: null } });
    }
    return { already: !existing.unsubscribedAt && !existing.purchasedAt };
  }
  await db.notifySubscriber.create({
    data: { shop, productId, email: e, customerId: customerId ? String(customerId) : null, token: newToken() },
  });
  return { already: false };
}

export async function unsubscribe(token) {
  const sub = await db.notifySubscriber.findUnique({ where: { token } });
  if (!sub) return null;
  // Stop every pre-order email to this address from this store
  await db.notifySubscriber.updateMany({
    where: { shop: sub.shop, email: sub.email, unsubscribedAt: null },
    data: { unsubscribedAt: new Date() },
  });
  await db.emailSend.updateMany({ where: { shop: sub.shop, email: sub.email, status: "queued" }, data: { status: "skipped" } });
  // Wishlist emails go to the same address, so they stop too
  await db.wishlistCustomer.updateMany({
    where: { shop: sub.shop, email: sub.email, emailsOn: true },
    data: { emailsOn: false, emailsSetAt: new Date() },
  });
  return sub;
}

// ---------------------------------------------------------------------------
// Wishlists: customers who saved a product get its emails too
// ---------------------------------------------------------------------------

export const WISHLIST_SOURCE = "wishlist";
export const RESTOCK_KIND = "back_in_stock";

// Adds everyone with the product on their wishlist (and wishlist emails on)
// as a subscriber, so they get the same emails as people who signed up.
// Nobody who unsubscribed after their last "emails on" is added back.
// Returns the email addresses of those wishlisters.
export async function addWishlistSubscribers(shop, productId) {
  const items = await db.wishlistItem.findMany({ where: { shop, productId }, select: { customerId: true } });
  if (!items.length) return [];
  const customers = await db.wishlistCustomer.findMany({
    where: { shop, customerId: { in: items.map((i) => i.customerId) }, emailsOn: true, email: { not: null } },
  });
  const byEmail = new Map();
  for (const c of customers) {
    const e = String(c.email).trim().toLowerCase();
    if (EMAIL.test(e)) byEmail.set(e, c);
  }
  if (!byEmail.size) return [];
  const rows = await db.notifySubscriber.findMany({ where: { shop, email: { in: [...byEmail.keys()] } } });
  const have = new Set(rows.filter((r) => r.productId === productId).map((r) => r.email));
  const optedOut = new Set(
    rows
      .filter((r) => r.unsubscribedAt && r.unsubscribedAt >= (byEmail.get(r.email).emailsSetAt ?? byEmail.get(r.email).createdAt))
      .map((r) => r.email),
  );
  const emails = [...byEmail.keys()].filter((e) => !optedOut.has(e));
  const add = emails.filter((e) => !have.has(e));
  if (add.length) {
    await db.notifySubscriber.createMany({
      data: add.map((e) => ({ shop, productId, email: e, customerId: byEmail.get(e).customerId, token: newToken(), source: WISHLIST_SOURCE })),
      skipDuplicates: true,
    });
  }
  return emails;
}

async function wishlistPreorderEmailsOn(shop) {
  const s = await db.wishlistSettings.findUnique({ where: { shop } });
  return s ? s.preorderEmails : true;
}

// ---------------------------------------------------------------------------
// Campaigns: one batch of emails about one product
//   kind: opened | reopened | closing (pre-order windows)
//         back_in_stock (wishlist; no window)
// ---------------------------------------------------------------------------

// Queues emails to everyone signed up for the product who hasn't bought it
// or unsubscribed. dedupeKey stops the same email going out twice.
// onlyEmails limits it to those addresses (back-in-stock goes to wishlisters only).
export async function createCampaign(shop, { window = null, productId = null, kind, dedupeKey, product, productUrl, onlyEmails = null }) {
  const pid = window?.productId ?? productId;
  if (kind !== TEST_KIND && kind !== RESTOCK_KIND && (await wishlistPreorderEmailsOn(shop))) {
    await addWishlistSubscribers(shop, pid);
  }
  const recipients = await db.notifySubscriber.findMany({
    where: {
      shop,
      productId: pid,
      unsubscribedAt: null,
      purchasedAt: null,
      ...(onlyEmails ? { email: { in: onlyEmails } } : {}),
    },
  });
  let campaign;
  try {
    campaign = await db.emailCampaign.create({
      data: {
        shop,
        windowId: window?.id ?? 0,
        productId: pid,
        kind,
        dedupeKey,
        title: product?.title ?? window?.title,
        imageUrl: product?.largeImageUrl ?? product?.imageUrl ?? window?.imageUrl,
        productUrl,
        closesAt: window?.closesAt ?? null,
        recipients: recipients.length,
      },
    });
  } catch (e) {
    if (e?.code === "P2002") return null; // already sent
    throw e;
  }
  if (recipients.length) {
    await db.emailSend.createMany({
      data: recipients.map((r) => ({
        shop,
        campaignId: campaign.id,
        subscriberId: r.id,
        productId: pid,
        email: r.email,
        kind,
        token: newToken(),
      })),
    });
    kickMail();
  }
  return campaign;
}

// ---------------------------------------------------------------------------
// The emails
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const whenText = (date) =>
  new Date(date).toLocaleString("en-US", {
    timeZone: STORE_TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

export function emailContent(kind, campaign, fromWishlist = false) {
  const title = campaign.title ?? "your pre-order";
  const closes = campaign.closesAt ? whenText(campaign.closesAt) : null;
  if (kind === RESTOCK_KIND)
    return {
      subject: `Back in stock: ${title}`,
      heading: "Back in stock",
      body: `Good news: ${title}, from your wishlist, is back in stock. Popular items can go quickly, so don't wait too long.`,
      button: "Shop now",
    };
  if (kind === "opened")
    return {
      subject: `Pre-orders are open: ${title}`,
      heading: "Pre-orders are open",
      body: fromWishlist
        ? `Something on your wishlist is ready: ${title} is now available to pre-order.${closes ? ` Pre-orders close ${closes}.` : ""}`
        : `You asked us to let you know, so here it is: ${title} is now available to pre-order.${closes ? ` Pre-orders close ${closes}.` : ""}`,
      button: "Pre-order now",
    };
  if (kind === "reopened")
    return {
      subject: `${title} is back for pre-order`,
      heading: "More are available",
      body: `Good news: we've added more ${title} for pre-order. They went quickly last time, so don't wait too long.${closes ? ` Pre-orders close ${closes}.` : ""}`,
      button: "Pre-order now",
    };
  return {
    subject: `Last chance: ${title} pre-orders close soon`,
    heading: "Pre-orders close soon",
    body: `Pre-orders for ${title} close ${closes ?? "soon"}. If you'd like one, now's the time.`,
    button: "Pre-order before it closes",
  };
}

// Builds one email. Returns null if it shouldn't go out anymore.
export async function renderEmail(send) {
  const isTest = send.kind === TEST_KIND;
  const [campaign, sub] = await Promise.all([
    db.emailCampaign.findUnique({ where: { id: send.campaignId } }),
    isTest ? null : db.notifySubscriber.findUnique({ where: { id: send.subscriberId } }),
  ]);
  if (!campaign || (!isTest && (!sub || sub.unsubscribedAt || sub.purchasedAt))) return null;
  const settings = await getSettings(send.shop);
  const fromWishlist = sub?.source === WISHLIST_SOURCE;
  const c = emailContent(isTest ? "opened" : send.kind, campaign, fromWishlist);
  if (isTest) c.subject = `[Test] ${c.subject}`;
  const base = appUrl();
  const click = `${base}/t/c/${send.token}`;
  const pixel = `${base}/t/o/${send.token}.gif`;
  // A test has nobody to unsubscribe; the link shows "isn't valid anymore"
  const unsub = `${base}/t/u/${sub?.token ?? "test"}`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;">
<tr><td style="background:${PINK};padding:18px 24px;font-size:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#1a1a1a;">${esc(c.heading)}</td></tr>
${campaign.imageUrl ? `<tr><td align="center" style="padding:24px 24px 0;"><a href="${click}"><img src="${esc(campaign.imageUrl)}" alt="${esc(campaign.title)}" width="280" style="display:block;width:280px;max-width:100%;height:auto;border-radius:8px;border:0;"></a></td></tr>` : ""}
<tr><td style="padding:22px 28px 6px;font-size:20px;font-weight:700;line-height:1.3;">${esc(campaign.title)}</td></tr>
<tr><td style="padding:0 28px 22px;font-size:15px;line-height:1.55;color:#333;">${esc(c.body)}</td></tr>
<tr><td style="padding:0 28px 30px;"><a href="${click}" style="display:inline-block;background:#1a1a1a;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 26px;border-radius:999px;">${esc(c.button)}</a></td></tr>
<tr><td style="padding:16px 28px 22px;border-top:1px solid #eee;font-size:12px;line-height:1.5;color:#777;">${fromWishlist ? `You're getting this because ${esc(campaign.title)} is on your wishlist.` : `You're getting this because you asked to be told about ${esc(campaign.title)}.`} <a href="${unsub}" style="color:#777;">Unsubscribe</a></td></tr>
</table></td></tr></table>
<img src="${pixel}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">
</body></html>`;

  const text = `${c.heading}\n\n${campaign.title}\n\n${c.body}\n\n${c.button}: ${click}\n\nUnsubscribe: ${unsub}\n`;

  return {
    from: mailFrom(settings.fromName),
    subject: c.subject,
    html,
    text,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// A test email to a staff member. It's built exactly like a real one (picture,
// tracked links, open pixel) and logged under Recent emails as "Test", but it
// never counts towards the dashboard's totals or order credit.
export async function sendTestEmail(shop, to, admin = null) {
  const email = String(to ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new NotifyError("Enter an email address to send the test to.");
  // Use a real product from the group when there is one, so the test looks real
  const w = await db.preorderWindow.findFirst({ where: { shop }, orderBy: { updatedAt: "desc" } });
  const base = (admin ? await storeUrl(shop, admin) : (await getSettings(shop)).storeUrl) ?? `https://${shop}`;
  const campaign = await db.emailCampaign.create({
    data: {
      shop,
      windowId: w?.id ?? 0,
      productId: w?.productId ?? "test",
      kind: TEST_KIND,
      dedupeKey: `test:${newToken()}`,
      title: w?.title ?? "Example product",
      imageUrl: w?.imageUrl ?? null,
      productUrl: w?.handle ? `${base.replace(/\/$/, "")}/products/${w.handle}` : base,
      closesAt: w?.closesAt ?? new Date(Date.now() + 3 * 86400000),
      recipients: 1,
    },
  });
  // "sending" keeps the regular queue from picking it up as well
  const send = await db.emailSend.create({
    data: { shop, campaignId: campaign.id, subscriberId: 0, productId: campaign.productId, email, kind: TEST_KIND, token: newToken(), status: "sending" },
  });
  try {
    const message = await renderEmail(send);
    await sendNow({ ...message, to: email });
    await db.emailSend.update({ where: { id: send.id }, data: { status: "sent", sentAt: new Date(), attempts: 1 } });
  } catch (e) {
    await db.emailSend.update({ where: { id: send.id }, data: { status: "failed", attempts: 1, error: String(e?.message ?? e).slice(0, 500) } });
    throw e;
  }
}

export function kickMail() {
  deliverQueued(renderEmail).catch((e) => console.error("[mail] send failed:", e?.message ?? e));
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export async function recordOpen(token) {
  const send = await db.emailSend.findUnique({ where: { token } });
  if (!send) return;
  await db.emailSend.update({
    where: { id: send.id },
    data: { opens: { increment: 1 }, ...(send.openedAt ? {} : { openedAt: new Date() }) },
  });
}

// Returns where to send the person
export async function recordClick(token) {
  const send = await db.emailSend.findUnique({ where: { token } });
  if (!send) return null;
  const campaign = await db.emailCampaign.findUnique({ where: { id: send.campaignId } });
  await db.emailSend.update({
    where: { id: send.id },
    data: {
      clicks: { increment: 1 },
      ...(send.clickedAt ? {} : { clickedAt: new Date() }),
      // A click means it was opened, even if images were blocked
      ...(send.openedAt ? {} : { openedAt: new Date() }),
    },
  });
  if (!campaign?.productUrl) return null;
  const url = new URL(campaign.productUrl);
  url.searchParams.set("oh_ref", token);
  url.searchParams.set("utm_source", send.kind === RESTOCK_KIND ? "wishlist-email" : "preorder-email");
  url.searchParams.set("utm_medium", "email");
  url.searchParams.set("utm_campaign", send.kind);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Orders: sales of countdown products, and which came from an email
// ---------------------------------------------------------------------------

const gid = (type, id) => (id ? `gid://shopify/${type}/${id}` : null);

export async function recordOrder(shop, order) {
  const orderId = gid("Order", order?.id);
  if (!orderId) return;
  const email = String(order.email ?? order.contact_email ?? order.customer?.email ?? "").toLowerCase() || null;
  const currency = order.currency ?? order.presentment_currency ?? null;

  // Units and revenue per product in this order
  const byProduct = new Map();
  for (const li of order.line_items ?? []) {
    const pid = gid("Product", li.product_id);
    if (!pid) continue;
    const qty = Number(li.quantity) || 0;
    const revenue = qty * Number(li.price || 0) - Number(li.total_discount || 0);
    const cur = byProduct.get(pid) ?? { units: 0, revenue: 0 };
    byProduct.set(pid, { units: cur.units + qty, revenue: cur.revenue + revenue });
  }
  if (!byProduct.size) return;

  const windows = await db.preorderWindow.findMany({ where: { shop, productId: { in: [...byProduct.keys()] } } });
  if (!windows.length) return;

  const ref = (order.note_attributes ?? []).find((a) => a?.name === REF_ATTRIBUTE)?.value ?? null;
  const refFound = ref ? await db.emailSend.findUnique({ where: { token: String(ref) } }) : null;
  const refSend = refFound?.kind === TEST_KIND ? null : refFound;
  const since = new Date(Date.now() - MATCH_DAYS * 24 * 3600 * 1000);

  for (const w of windows) {
    const { units, revenue } = byProduct.get(w.productId);
    await db.preorderSale.createMany({
      data: [{ shop, productId: w.productId, orderId, units, revenue, currency }],
      skipDuplicates: true,
    });

    // Bought it: no more emails about this product
    if (email) {
      await db.notifySubscriber.updateMany({
        where: { shop, productId: w.productId, email, purchasedAt: null },
        data: { purchasedAt: new Date() },
      });
    }

    // Came from an email?
    let send = refSend && refSend.shop === shop && refSend.productId === w.productId ? refSend : null;
    let method = send ? "click" : null;
    if (!send && email) {
      send = await db.emailSend.findFirst({
        where: { shop, productId: w.productId, email, ...REAL, status: "sent", sentAt: { gte: since } },
        orderBy: { sentAt: "desc" },
      });
      method = send ? "email" : null;
    }
    if (send) {
      await db.emailConversion.createMany({
        data: [
          {
            shop,
            sendId: send.id,
            subscriberId: send.subscriberId,
            productId: w.productId,
            orderId,
            orderName: order.name ?? null,
            orderTotal: Number(order.total_price || 0),
            productRevenue: revenue,
            currency,
            method,
          },
        ],
        skipDuplicates: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Numbers for the dashboard
// ---------------------------------------------------------------------------

export async function metricsFor(shop, productIds) {
  const where = { shop, productId: { in: productIds } };
  const [subs, sent, opened, clicked, conv, sales] = await Promise.all([
    db.notifySubscriber.groupBy({ by: ["productId"], where: { ...where, unsubscribedAt: null }, _count: { _all: true } }),
    db.emailSend.groupBy({ by: ["productId"], where: { ...where, ...REAL, status: "sent" }, _count: { _all: true } }),
    db.emailSend.groupBy({ by: ["productId"], where: { ...where, ...REAL, openedAt: { not: null } }, _count: { _all: true } }),
    db.emailSend.groupBy({ by: ["productId"], where: { ...where, ...REAL, clickedAt: { not: null } }, _count: { _all: true } }),
    db.emailConversion.groupBy({
      by: ["productId"],
      where,
      _count: { _all: true },
      _sum: { productRevenue: true, orderTotal: true },
    }),
    db.preorderSale.groupBy({ by: ["productId"], where, _sum: { units: true, revenue: true }, _count: { _all: true } }),
  ]);
  const out = Object.fromEntries(
    productIds.map((p) => [
      p,
      { signups: 0, sent: 0, opened: 0, clicked: 0, orders: 0, emailRevenue: 0, orderTotal: 0, units: 0, revenue: 0, salesOrders: 0 },
    ]),
  );
  for (const r of subs) out[r.productId].signups = r._count._all;
  for (const r of sent) out[r.productId].sent = r._count._all;
  for (const r of opened) out[r.productId].opened = r._count._all;
  for (const r of clicked) out[r.productId].clicked = r._count._all;
  for (const r of conv) {
    out[r.productId].orders = r._count._all;
    out[r.productId].emailRevenue = r._sum.productRevenue ?? 0;
    out[r.productId].orderTotal = r._sum.orderTotal ?? 0;
  }
  for (const r of sales) {
    out[r.productId].units = r._sum.units ?? 0;
    out[r.productId].revenue = r._sum.revenue ?? 0;
    out[r.productId].salesOrders = r._count._all;
  }
  return out;
}

export async function recentSends(shop, take = 25) {
  const rows = await db.emailSend.findMany({ where: { shop }, orderBy: { id: "desc" }, take });
  const campaigns = await db.emailCampaign.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.campaignId))] } } });
  const titles = new Map(campaigns.map((c) => [c.id, c.title]));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    kind: r.kind,
    title: titles.get(r.campaignId) ?? null,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    sentAt: r.sentAt?.toISOString() ?? null,
    openedAt: r.openedAt?.toISOString() ?? null,
    clickedAt: r.clickedAt?.toISOString() ?? null,
  }));
}

// Send waiting emails every minute
if (!globalThis.__preorderMailTimer && process.env.NODE_ENV !== "test") {
  globalThis.__preorderMailTimer = setInterval(kickMail, 60 * 1000);
  setTimeout(kickMail, 30 * 1000);
}
