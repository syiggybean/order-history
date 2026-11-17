import { inflateRawSync } from "node:zlib";
import db from "./db.server";
import { errorMessage, gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Milestone (b2b.mile-stone.jp): suggestions from invoiced items
//
// Signs in with MILESTONE_EMAIL / MILESTONE_PASSWORD (Railway variables; the
// login is Milestone's B2B account), reads the Excel copy of each invoice in
// the chosen period, and suggests the items the shop doesn't sell yet (no
// variant with that JAN code as its barcode or SKU). Each suggestion can be
// created in Shopify as a draft product: title, maker as vendor, JAN as
// barcode, price and cost from the yen prices, and Milestone's photos.
// ---------------------------------------------------------------------------

export class MilestoneError extends Error {}

const BASE = "https://b2b.mile-stone.jp";
const INVOICES = `${BASE}/my/invoice/`;
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
// Product codes are 11 digits; the spreadsheet stores them as numbers, so
// leading zeros are lost ("81933777" is 00081933777)
export const padCode = (c) => {
  const s = String(c ?? "").trim();
  return /^\d{1,11}$/.test(s) ? s.padStart(11, "0") : s;
};
// Excel day number → "2026-11-13"
const excelDay = (v) => {
  const n = Number(v);
  if (!(n > 20000)) return dayOf(v);
  return new Date(Math.round((Math.floor(n) - 25569) * 86400000)).toISOString().slice(0, 10);
};

// The invoice list: [{ id, number, day }] for the Excel copies, plus the
// other years the page links to
export function parseInvoiceList(html) {
  const h = String(html);
  const invoices = [];
  for (const m of h.matchAll(/<a href="view\?invoice_id=(\d+)"[^>]*>((?:(?!<\/a>)[\s\S])*)<\/a>/g)) {
    const text = decode(m[2]);
    if (!/\[excel\]/i.test(text)) continue;
    const no = text.match(/Invoice No\.\s*([^\s(]+)/i);
    const day = text.match(/\((\d{4}\/\d{1,2}\/\d{1,2})\)/);
    invoices.push({ id: m[1], number: no ? no[1] : `#${m[1]}`, day: day ? dayOf(day[1]) : null });
  }
  const years = [...new Set([...h.matchAll(/href="\?year=(\d{4})"/g)].map((m) => Number(m[1])))];
  return { invoices, years };
}

// A minimal .xlsx reader: the files we need out of the zip
export function unzip(buf) {
  const b = Buffer.from(buf);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new MilestoneError("The invoice file isn't a spreadsheet.");
  const count = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) break;
    const method = b.readUInt16LE(p + 10);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const at = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    const start = at + 30 + b.readUInt16LE(at + 26) + b.readUInt16LE(at + 28);
    const data = b.subarray(start, start + size);
    if (method === 0 || method === 8) files[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xmlText = (s) =>
  String(s ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

// The sheet as rows of { column letter: value }
function sheetRows(files) {
  const sheetName = Object.keys(files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n)) ?? Object.keys(files).find((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  if (!sheetName) throw new MilestoneError("The invoice spreadsheet has no sheet.");
  const shared = [...String(files["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlText([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const rows = [];
  for (const r of files[sheetName].matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      const inline = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      let val = null;
      if (/t="s"/.test(c[2]) && v) val = shared[Number(v[1])] ?? null;
      else if (/t="inlineStr"/.test(c[2]) && inline) val = xmlText(inline[1]);
      else if (v) val = xmlText(v[1]);
      if (val != null && String(val).trim() !== "") row[c[1]] = String(val).trim();
    }
    rows.push(row);
  }
  return rows;
}

// One invoice: its number, date and product lines (fees, bank charges and
// refunds have no JAN code and are left out)
export function parseInvoice(buf) {
  const rows = sheetRows(unzip(buf));
  const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  let number = null;
  let day = null;
  let cols = null;
  const lines = [];
  for (const row of rows) {
    const keys = Object.keys(row);
    for (let i = 0; i < keys.length; i++) {
      const label = flat(row[keys[i]]);
      const next = row[keys[i + 1]];
      if (label === "INVOICE NO.:" && next) number = next;
      if (label === "INVOICE DATE:" && next) day = excelDay(next);
    }
    if (!cols) {
      const find = (re) => keys.find((k) => re.test(flat(row[k])));
      const jan = find(/^JAN ?CODE$/);
      if (jan) cols = { code: find(/^PRODUCT ?CODE$/), jan, title: find(/^DESCRIPTION$/), qty: find(/^QUANTITY$/), price: find(/^UNIT ?PRICE$/) };
      continue;
    }
    const jan = String(row[cols.jan] ?? "").replace(/\D/g, "");
    if (!/^\d{8,14}$/.test(jan)) continue;
    const code = padCode(row[cols.code]);
    lines.push({
      msCode: code || jan,
      jan,
      title: row[cols.title] ?? "",
      quantity: Number(row[cols.qty]) || 0,
      wholesaleYen: row[cols.price] != null ? Number(row[cols.price]) : null,
    });
  }
  if (!cols) throw new MilestoneError("Couldn't find the item list in the invoice spreadsheet.");
  return { number, day, lines };
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
  const maker = h.match(/<a href="\/en\/search\/0\/maker_id=\d+\/"[^>]*>([\s\S]*?)<\/a>/);
  return {
    // The product's own heading (the page has others, like the "Working days" calendar)
    title:
      decode((h.match(/<h2[^>]*class="[^"]*text-24px[^"]*"[^>]*>([\s\S]*?)<\/h2>/) || [])[1] ?? "") ||
      decode((h.match(/Product detail information\s*:\s*([^<]+)</) || [])[1] ?? "") ||
      null,
    retailYen: yen(dd(h, "Retail Price")),
    // "75% 1,350yen": the yen amount is the last number
    wholesaleYen: wholesale ? yen(decode(wholesale).replace(/^\s*\d+%/, "")) : null,
    inStockDay: dayOf(dd(h, "In-stock Date")),
    release: decode(dd(h, "Release Date")) || null,
    category: category ? decode(category[1]) : null,
    copyright: copyright ? decode(copyright[1]) : null,
    maker: maker ? decode(maker[1]) || null : null,
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

async function getPage(fetcher, jar, url, binary = false) {
  const res = await fetcher(url, { headers: { Cookie: cookieHeader(jar), "User-Agent": UA }, redirect: "manual" });
  cookiesFrom(res, jar);
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "";
    if (/login/.test(to)) throw new MilestoneError("Milestone signed the app out. Try again.");
    return getPage(fetcher, jar, new URL(to, url).toString(), binary);
  }
  if (!res.ok) throw new MilestoneError(`Milestone's site answered ${res.status} for ${new URL(url).pathname}.`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
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

// Today's yen → dollar rate: the European Central Bank's (via Frankfurter),
// or open.er-api.com if that's down. Neither needs a key.
export async function liveYenRate(fetcher = fetch) {
  const get = async (url) => {
    const res = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  };
  try {
    const d = await get("https://api.frankfurter.app/latest?from=JPY&to=USD");
    if (d?.rates?.USD > 0) return { rate: d.rates.USD, date: d.date ?? null, source: "European Central Bank" };
  } catch {
    // try the other one
  }
  try {
    const d = await get("https://open.er-api.com/v6/latest/JPY");
    if (d?.rates?.USD > 0) return { rate: d.rates.USD, date: d.time_last_update_utc ? new Date(d.time_last_update_utc).toISOString().slice(0, 10) : null, source: "ExchangeRate-API" };
  } catch {
    // neither answered
  }
  return null;
}

// How far back to read invoices
export const RANGES = { "3": "Last 3 months", "12": "Last 12 months", all: "All invoices" };
const sinceDay = (range, now = new Date()) => {
  if (range === "all") return null;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - (Number(range) || 3));
  return d.toISOString().slice(0, 10);
};

// The Excel invoices in the period, newest first
async function invoicesSince(fetcher, jar, since) {
  const first = parseInvoiceList(await getPage(fetcher, jar, INVOICES));
  const all = [...first.invoices];
  const fromYear = since ? Number(since.slice(0, 4)) : 0;
  for (const y of first.years.filter((y) => y >= fromYear)) {
    all.push(...parseInvoiceList(await getPage(fetcher, jar, `${INVOICES}?year=${y}`)).invoices);
  }
  const seen = new Set();
  return all
    .filter((x) => !seen.has(x.id) && seen.add(x.id))
    .filter((x) => !since || !x.day || x.day >= since)
    .sort((a, b) => (b.day ?? "").localeCompare(a.day ?? ""));
}

// Each item invoiced in the period, grouped by product code, with what the
// shop has, what was created or dismissed before, and the details of the new ones
export async function suggestions(shop, admin, { fetcher = fetch, range = "3", now = new Date() } = {}) {
  const settings = await getSettings(shop);
  const jar = await login(fetcher);
  const since = sinceDay(range, now);
  const invoices = await invoicesSince(fetcher, jar, since);
  const unread = [];
  const byCode = new Map();
  for (let i = 0; i < invoices.length; i += 4) {
    const part = invoices.slice(i, i + 4);
    const read = await Promise.all(
      part.map(async (inv) => {
        try {
          return { inv, data: parseInvoice(await getPage(fetcher, jar, `${INVOICES}view?invoice_id=${inv.id}`, true)) };
        } catch (e) {
          unread.push({ number: inv.number, error: e instanceof MilestoneError ? e.message : errorMessage(e) });
          return null;
        }
      }),
    );
    for (const r of read.filter(Boolean)) {
      const number = r.data.number ?? r.inv.number;
      const day = r.inv.day ?? r.data.day;
      for (const line of r.data.lines) {
        const had = byCode.get(line.msCode);
        if (had) {
          had.quantity += line.quantity;
          if (!had.invoices.some((v) => v.number === number)) had.invoices.push({ number, day });
          if ((day ?? "") > (had.invoiceDay ?? "")) {
            had.invoiceDay = day;
            if (line.wholesaleYen != null) had.wholesaleYen = line.wholesaleYen;
          }
        } else byCode.set(line.msCode, { ...line, maker: null, invoiceDay: day, invoices: [{ number, day }] });
      }
    }
  }
  const items = [...byCode.values()];
  const [shopHas, marked] = await Promise.all([
    items.length ? inShop(admin, items.flatMap((x) => [x.jan, x.msCode])) : new Map(),
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
  // Details (maker, prices, photos) for the ones to suggest, a few at a time
  const todo = items.filter((x) => x.status === "new");
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(
      todo.slice(i, i + 4).map(async (x) => {
        try {
          x.details = parseProduct(await getPage(fetcher, jar, `${BASE}/en/products/${encodeURIComponent(x.msCode)}`));
          x.maker = x.details.maker;
        } catch (e) {
          x.details = null;
          x.detailsError = errorMessage(e);
        }
      }),
    );
  }
  // Today's rate; the last one fetched if the rate services don't answer
  const live = await liveYenRate(fetcher);
  if (live) await db.milestoneSettings.update({ where: { shop }, data: { yenRate: live.rate } });
  const rate = live?.rate ?? settings.yenRate ?? null;
  const markup = settings.markupPercent;
  for (const x of items) {
    const retail = x.details?.retailYen ?? null;
    // The invoice price is what was actually paid
    const wholesale = x.wholesaleYen ?? x.details?.wholesaleYen ?? null;
    x.suggestedCost = rate && wholesale ? money(wholesale * rate) : null;
    x.suggestedPrice = markup != null ? priceFromCost(x.suggestedCost, markup) : rate && retail ? money(retail * rate) : null;
  }
  const order = { new: 0, dismissed: 1, created: 2, inShop: 3 };
  items.sort((a, b) => order[a.status] - order[b.status] || (b.invoiceDay ?? "").localeCompare(a.invoiceDay ?? "") || a.title.localeCompare(b.title));
  await db.milestoneSettings.update({ where: { shop }, data: { lastRunAt: new Date() } });
  return {
    items,
    range: RANGES[range] ? range : "3",
    since,
    invoiceCount: invoices.length - unread.length,
    unread,
    yenRate: rate,
    markupPercent: markup ?? null,
    rateSource: live ? live.source : rate ? "last rate fetched (the rate services didn't answer)" : null,
    rateDate: live?.date ?? null,
    checkedAt: new Date().toISOString(),
  };
}

// Price = cost plus the markup
export const priceFromCost = (cost, markup) => (cost == null || markup == null || !(Number(cost) > 0) ? null : money(Number(cost) * (1 + Number(markup) / 100)));

export async function saveMarkup(shop, value) {
  const raw = String(value ?? "").replace(/%/g, "").trim();
  const m = raw === "" ? null : Number(raw);
  if (m != null && !(Number.isFinite(m) && m >= 0 && m <= 10000)) throw new MilestoneError("Enter the markup as a percentage, for example 100.");
  await getSettings(shop);
  await db.milestoneSettings.update({ where: { shop }, data: { markupPercent: m } });
  return m;
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
