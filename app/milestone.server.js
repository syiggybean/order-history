import db from "./db.server";
import { errorMessage, gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Milestone (b2b.mile-stone.jp): suggestions from "View What's Arrived"
//
// Signs in with MILESTONE_EMAIL / MILESTONE_PASSWORD (Railway variables; the
// login is Milestone's B2B account), reads the arrived list, and suggests the
// items the shop doesn't sell yet (no variant with that JAN code as its
// barcode or SKU). Each suggestion can be created in Shopify as a draft
// product: title, maker as vendor, JAN as barcode, price and cost from the
// yen prices, and Milestone's photos.
// ---------------------------------------------------------------------------

export class MilestoneError extends Error {}

const BASE = "https://b2b.mile-stone.jp";
const ARRIVED = `${BASE}/my/order/?stock_status=view`;
// Milestone's own login page sends this fixed header with its API calls (it's in their public JavaScript)
const SITE_API_AUTH = "Basic dGVzdDp0ZXN0";
// Like a normal browser visit: some sites only start a session for one
const BROWSER = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const UA = BROWSER["User-Agent"];

// ---------------------------------------------------------------------------
// Reading the site
// ---------------------------------------------------------------------------

const decode = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
const yen = (s) => {
  const m = String(s ?? "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};
// "2026/10/5" → "2026-10-05"
export const dayOf = (s) => {
  const m = String(s ?? "").match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};
const cell = (row, cls) => {
  const m = row.match(new RegExp(`<td[^>]*class="[^"]*-${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`));
  return m ? m[1] : "";
};

// The arrived list: one row per item ordered
export function parseArrived(html) {
  const tables = [...String(html).matchAll(/<table[^>]*stock-arrived-list__table[^>]*>([\s\S]*?)<\/table>/g)];
  const rows = [];
  for (const t of tables) {
    for (const m of t[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const r = m[1];
      if (!/<td/.test(r)) continue;
      const nameCell = cell(r, "product-name");
      const title = decode((nameCell.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] ?? "");
      const msCode = decode(cell(r, "ms-code"));
      if (!msCode || !title) continue;
      rows.push({
        orderDay: dayOf(cell(r, "order-date")),
        msCode,
        jan: decode(cell(r, "jan-code")) || null,
        maker: decode(cell(r, "manufacturer")) || null,
        title,
        quantity: yen(cell(r, "quantity")) ?? 0,
        wholesaleYen: yen(cell(r, "price")),
      });
    }
  }
  return rows;
}

const dd = (html, label) => {
  const m = html.match(new RegExp(`<dt>\\s*${label}\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`, "i"));
  return m ? m[1] : null;
};

// One product page: prices, dates, category and photos
export function parseProduct(html) {
  const h = String(html);
  const wholesale = dd(h, "Wholesale Price");
  const images = [...new Set([...h.matchAll(/href="(https:\/\/b2b\.mile-stone\.jp\/p\/img\/[^"]+?\.(?:jpe?g|png|webp))"/gi)].map((m) => m[1]))].filter(
    (u) => !/_\d+x\d+\./.test(u),
  );
  const category = h.match(/<span class="p-4px border[^"]*">([^<]+)<\/span>\s*<\/div>\s*<h2/);
  const copyright = h.match(/<p class="mt-8px break-all text-center">([\s\S]*?)<\/p>/);
  return {
    title: decode((h.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1] ?? "") || null,
    retailYen: yen(dd(h, "Retail Price")),
    // "75% 1,350yen": the yen amount is the last number
    wholesaleYen: wholesale ? yen(decode(wholesale).replace(/^\s*\d+%/, "")) : null,
    inStockDay: dayOf(dd(h, "In-stock Date")),
    release: decode(dd(h, "Release Date")) || null,
    category: category ? decode(category[1]) : null,
    copyright: copyright ? decode(copyright[1]) : null,
    images,
  };
}

// ---------------------------------------------------------------------------
// Signing in (cookies by hand: just plack_session, the site's session)
// ---------------------------------------------------------------------------

const cookiesFrom = (res, jar = {}) => {
  // One header per cookie; older runtimes join them with commas
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : String(res.headers.get("set-cookie") ?? "")
          .split(/,(?=\s*[A-Za-z0-9_.-]+=)/)
          .filter(Boolean);
  for (const c of list) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
};
const cookieHeader = (jar) =>
  Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

export async function login(fetcher = fetch) {
  const account = process.env.MILESTONE_EMAIL;
  const password = process.env.MILESTONE_PASSWORD;
  if (!account || !password) throw new MilestoneError("The Milestone login isn't set up. Add MILESTONE_EMAIL and MILESTONE_PASSWORD in Railway.");
  // A session first: the login is tied to it. Visit like a browser would,
  // following redirects and keeping every cookie along the way.
  const jar = {};
  const seen = [];
  for (const start of [`${BASE}/en/v1/login/`, `${BASE}/en/`, `${BASE}/`]) {
    let url = start;
    for (let hop = 0; hop < 5 && url; hop++) {
      const res = await fetcher(url, { headers: { ...BROWSER, ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) }, redirect: "manual" });
      cookiesFrom(res, jar);
      seen.push(`${new URL(url).pathname} ${res.status}`);
      const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      url = to ? new URL(to, url).toString() : null;
    }
    if (jar.plack_session) break;
  }
  const call = async () => {
    const res = await fetcher(`${BASE}/p/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: SITE_API_AUTH,
        Origin: BASE,
        Referer: `${BASE}/en/v1/login/`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": UA,
        ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "User.login", params: { account, password, ...(jar.plack_session ? { sid: jar.plack_session } : {}) } }),
    });
    cookiesFrom(res, jar);
    seen.push(`login ${res.status}`);
    return res.json().catch(() => null);
  };
  // No session cookie yet: the login call may start one, then try again with it
  let body = await call();
  if (!body?.result?.login && jar.plack_session && !body?.result) body = await call();
  if (!jar.plack_session) throw new MilestoneError(`Milestone's site didn't start a session (${seen.join(", ")}). Try again in a moment.`);
  if (!body?.result?.login) {
    if (body?.error) throw new MilestoneError(`Milestone refused the login: ${body.error.message ?? JSON.stringify(body.error)}`);
    throw new MilestoneError("Milestone didn't accept the login. Check MILESTONE_EMAIL and MILESTONE_PASSWORD in Railway.");
  }
  return jar;
}

async function getPage(fetcher, jar, url) {
  const res = await fetcher(url, { headers: { Cookie: cookieHeader(jar), "User-Agent": UA }, redirect: "manual" });
  cookiesFrom(res, jar);
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "";
    if (/login/.test(to)) throw new MilestoneError("Milestone signed the app out. Try again.");
    return getPage(fetcher, jar, new URL(to, BASE).toString());
  }
  if (!res.ok) throw new MilestoneError(`Milestone's site answered ${res.status} for ${new URL(url).pathname}.`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Matching against the shop
// ---------------------------------------------------------------------------

const VARIANTS = `#graphql
  query ($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes { barcode sku product { id title status } }
    }
  }`;

// JAN / product code → the shop product that already has it
async function inShop(admin, codes) {
  const found = new Map();
  const list = [...new Set(codes.filter(Boolean))];
  for (let i = 0; i < list.length; i += 20) {
    const part = list.slice(i, i + 20);
    const query = part.map((c) => `barcode:${c} OR sku:${c}`).join(" OR ");
    const data = await gql(admin, VARIANTS, { query });
    for (const v of data?.productVariants?.nodes ?? []) {
      for (const c of part) {
        if (v.barcode === c || v.sku === c) found.set(c, { productId: v.product.id, title: v.product.title, status: v.product.status });
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export async function getSettings(shop) {
  return db.milestoneSettings.upsert({ where: { shop }, create: { shop }, update: {} });
}

export async function saveRate(shop, rate) {
  const r = Number(rate);
  if (!(r > 0 && r < 1)) throw new MilestoneError("Enter how many dollars one yen is, for example 0.0067.");
  await getSettings(shop);
  return db.milestoneSettings.update({ where: { shop }, data: { yenRate: r } });
}

const money = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Everything on "View What's Arrived", grouped by product code, with what the
// shop has, what was created or dismissed before, and the details of the new ones
export async function suggestions(shop, admin, { fetcher = fetch } = {}) {
  const settings = await getSettings(shop);
  const jar = await login(fetcher);
  const rows = parseArrived(await getPage(fetcher, jar, ARRIVED));
  const byCode = new Map();
  for (const r of rows) {
    const had = byCode.get(r.msCode);
    if (had) {
      had.quantity += r.quantity;
      if (r.orderDay > had.orderDay) had.orderDay = r.orderDay;
    } else byCode.set(r.msCode, { ...r });
  }
  const items = [...byCode.values()];
  const [shopHas, marked] = await Promise.all([
    inShop(admin, items.flatMap((x) => [x.jan, x.msCode])),
    db.milestoneItem.findMany({ where: { shop, msCode: { in: items.map((x) => x.msCode) } } }),
  ]);
  const markOf = new Map(marked.map((m) => [m.msCode, m]));
  for (const x of items) {
    const has = shopHas.get(x.jan) ?? shopHas.get(x.msCode) ?? null;
    const m = markOf.get(x.msCode);
    x.inShop = has;
    x.status = has ? "inShop" : m?.status === "created" && m.productId ? "created" : m?.status === "dismissed" ? "dismissed" : "new";
    x.productId = has?.productId ?? m?.productId ?? null;
    x.markedBy = m?.by ?? null;
  }
  // Details (prices, photos) for the ones to suggest, a few at a time
  const todo = items.filter((x) => x.status === "new");
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(
      todo.slice(i, i + 4).map(async (x) => {
        try {
          x.details = parseProduct(await getPage(fetcher, jar, `${BASE}/en/products/${encodeURIComponent(x.msCode)}`));
        } catch (e) {
          x.details = null;
          x.detailsError = errorMessage(e);
        }
      }),
    );
  }
  const rate = settings.yenRate ?? null;
  for (const x of items) {
    const retail = x.details?.retailYen ?? null;
    const wholesale = x.details?.wholesaleYen ?? x.wholesaleYen;
    x.suggestedPrice = rate && retail ? money(retail * rate) : null;
    x.suggestedCost = rate && wholesale ? money(wholesale * rate) : null;
  }
  const order = { new: 0, dismissed: 1, created: 2, inShop: 3 };
  items.sort((a, b) => order[a.status] - order[b.status] || (b.orderDay ?? "").localeCompare(a.orderDay ?? "") || a.title.localeCompare(b.title));
  await db.milestoneSettings.update({ where: { shop }, data: { lastRunAt: new Date() } });
  return { items, yenRate: rate, checkedAt: new Date().toISOString() };
}

export async function dismiss(shop, msCodes, user, undo = false) {
  for (const msCode of msCodes) {
    if (undo) {
      await db.milestoneItem.deleteMany({ where: { shop, msCode, status: "dismissed" } });
      continue;
    }
    await db.milestoneItem.upsert({
      where: { shop_msCode: { shop, msCode } },
      create: { shop, msCode, status: "dismissed", by: user?.name ?? null },
      update: { status: "dismissed", by: user?.name ?? null },
    });
  }
}

// ---------------------------------------------------------------------------
// Creating draft products
// ---------------------------------------------------------------------------

const PRODUCT_SET = `#graphql
  mutation ($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id title }
      userErrors { field message code }
    }
  }`;

// items: [{ msCode, jan, title, maker, category, price, cost, sku, images }]
export async function createDrafts(shop, admin, items, user) {
  const results = [];
  for (const x of items) {
    const title = String(x.title ?? "").trim();
    const price = Number(x.price);
    try {
      if (!title) throw new MilestoneError("It needs a title.");
      if (!(price > 0)) throw new MilestoneError("Enter a price.");
      // Not twice: the shop may have it now
      const has = (await inShop(admin, [x.jan, x.msCode])).values().next().value;
      if (has) throw new MilestoneError(`The shop already has it: ${has.title}`);
      const cost = Number(x.cost);
      const input = {
        title,
        status: "DRAFT",
        vendor: x.maker || undefined,
        productType: x.category || undefined,
        tags: ["Milestone"],
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [
          {
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            price: price.toFixed(2),
            barcode: x.jan || undefined,
            sku: String(x.sku ?? "").trim() || undefined,
            inventoryItem: { tracked: true, ...(cost > 0 ? { cost: cost.toFixed(2) } : {}) },
          },
        ],
        files: (x.images ?? []).slice(0, 10).map((u) => ({ originalSource: u, contentType: "IMAGE", alt: title })),
      };
      const data = await gql(admin, PRODUCT_SET, { input });
      const errs = data?.productSet?.userErrors ?? [];
      if (errs.length || !data?.productSet?.product) throw new MilestoneError(errs.map((e) => e.message).join("; ") || "Shopify didn't create it.");
      const product = data.productSet.product;
      await db.milestoneItem.upsert({
        where: { shop_msCode: { shop, msCode: x.msCode } },
        create: { shop, msCode: x.msCode, status: "created", productId: product.id, by: user?.name ?? null },
        update: { status: "created", productId: product.id, by: user?.name ?? null },
      });
      results.push({ msCode: x.msCode, ok: true, productId: product.id, title: product.title });
    } catch (e) {
      results.push({ msCode: x.msCode, ok: false, error: e instanceof MilestoneError ? e.message : errorMessage(e) });
    }
  }
  return results;
}
