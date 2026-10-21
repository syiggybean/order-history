import db from "./db.server";
import { unauthenticated } from "./shopify.server";
import {
  daysUntil,
  errorMessage,
  loadCatalog,
  setReleaseDate,
  startScan,
  todayInStore,
  waitForScan,
} from "./preorders.server";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Optional but recommended: without a key, Google limits requests heavily
const API_KEY = process.env.GOOGLE_BOOKS_API_KEY || "";
const REQUEST_GAP_MS = 300; // pause between lookups to stay under Google's rate limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Penguin Random House: the publisher's own on-sale dates for every title PRH
// publishes or distributes (Seven Seas, Kodansha, Dark Horse and more).
// Checked first; titles PRH doesn't know go on to Google Books.
const PRH_KEY = process.env.PRH_API_KEY || "";
const PRH_BASE = "https://api.penguinrandomhouse.com/resources/v2/title/domains/PRH.US/titles";
const PRH_GAP_MS = 250;
export const prhEnabled = () => Boolean(PRH_KEY);

// ---------------------------------------------------------------------------
// ISBNs and dates
// ---------------------------------------------------------------------------

// Barcode → ISBN-13 or ISBN-10, or null if it doesn't look like one
export function toIsbn(barcode) {
  if (!barcode) return null;
  const s = String(barcode).replace(/[^0-9Xx]/g, "").toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) return s;
  if (/^\d{9}[\dX]$/.test(s)) return s;
  return null;
}

// Google's publishedDate can be "2027", "2027-03" or "2027-03-14"
export function parseGoogleDate(value) {
  const m = String(value ?? "").match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return null;
  if (m[3]) return { value: `${m[1]}-${m[2]}-${m[3]}`, precision: "day" };
  if (m[2]) return { value: `${m[1]}-${m[2]}`, precision: "month" };
  return { value: m[1], precision: "year" };
}

// ISBN-10 → ISBN-13 (PRH looks titles up by ISBN-13)
export function toIsbn13(isbn) {
  if (!isbn) return null;
  if (isbn.length === 13) return isbn;
  const core = `978${isbn.slice(0, 9)}`;
  const sum = [...core].reduce((t, d, i) => t + Number(d) * (i % 2 ? 3 : 1), 0);
  return `${core}${(10 - (sum % 10)) % 10}`;
}

// PRH's onsale: "2027-03-14", "2027-03-14T00:00:00" or "03/14/2027"
export function parsePrhDate(value) {
  const s = String(value ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { value: `${m[1]}-${m[2]}-${m[3]}`, precision: "day" };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { value: `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`, precision: "day" };
  return null;
}

// Does Google's date agree with ours, as far as Google's precision goes?
export function datesAgree(current, google) {
  if (!current) return false;
  return current.slice(0, google.value.length) === google.value;
}

// ---------------------------------------------------------------------------
// Google Books lookup
// ---------------------------------------------------------------------------

class QuotaError extends Error {}

async function lookupIsbn(isbn) {
  const params = new URLSearchParams({
    q: `isbn:${isbn}`,
    maxResults: "5",
    country: "US",
    fields: "items(volumeInfo(title,publishedDate,industryIdentifiers,infoLink))",
  });
  if (API_KEY) params.set("key", API_KEY);
  const url = `https://www.googleapis.com/books/v1/volumes?${params}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) throw new QuotaError("Google Books rate limit reached");
      throw new Error(`Google Books returned ${res.status}`);
    }

    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.message ?? "access denied";
      throw new QuotaError(`Google Books refused the request (${reason})`);
    }

    if (!res.ok) throw new Error(`Google Books returned ${res.status}`);

    const data = await res.json();
    const items = data.items ?? [];
    // Prefer the result that actually lists this ISBN
    const match =
      items.find((i) => i.volumeInfo?.industryIdentifiers?.some((x) => x.identifier?.replace(/-/g, "") === isbn)) ??
      items[0];
    if (!match) return null;

    const info = match.volumeInfo ?? {};
    return {
      title: info.title ?? null,
      url: info.infoLink ?? null,
      date: parseGoogleDate(info.publishedDate),
    };
  }
}

// ---------------------------------------------------------------------------
// Penguin Random House lookup
// ---------------------------------------------------------------------------

class PrhKeyError extends Error {}

// { title, url, date, source: "prh" } or null when PRH doesn't have the title
export async function lookupPrh(isbn) {
  const isbn13 = toIsbn13(isbn);
  const url = `${PRH_BASE}/${isbn13}?api_key=${encodeURIComponent(PRH_KEY)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new PrhKeyError(
        "Penguin Random House didn't accept the API key. New keys can take several days to be activated; until then dates come from Google Books.",
      );
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new Error(`Penguin Random House returned ${res.status}`);
    }
    if (!res.ok) throw new Error(`Penguin Random House returned ${res.status}`);
    const body = await res.json().catch(() => null);
    // The title may come bare or wrapped, depending on the API version
    const t = body?.data?.titles?.[0] ?? body?.titles?.[0] ?? (Array.isArray(body?.data) ? body.data[0] : null) ?? (body?.isbn ? body : null);
    if (!t) return null;
    const seo = t.seoFriendlyUrl ? String(t.seoFriendlyUrl) : null;
    return {
      title: [t.title, t.subtitle].filter(Boolean).join(": ") || null,
      url: seo ? (seo.startsWith("http") ? seo : `https://www.penguinrandomhouse.com${seo.startsWith("/") ? "" : "/"}${seo}`) : null,
      date: parsePrhDate(t.onsale),
      source: "prh",
    };
  }
}

// ---------------------------------------------------------------------------
// Review list
// ---------------------------------------------------------------------------

// Records what Google says for one product. Returns "new", "existing",
// "dismissed" or "agrees".
async function recordResult(shop, product, isbn, google) {
  const open = await db.releaseSuggestion.findMany({
    where: { shop, productId: product.id, status: { in: ["pending", "dismissed"] } },
  });

  if (datesAgree(product.release, google.date)) {
    // Dates agree now, so anything still waiting for review is out of date
    await db.releaseSuggestion.updateMany({
      where: { shop, productId: product.id, status: "pending" },
      data: { status: "superseded", resolvedAt: new Date() },
    });
    return "agrees";
  }

  const source = google.source ?? "google";
  // Already dismissed this exact date: don't ask again
  if (open.some((s) => s.status === "dismissed" && s.googleDate === google.date.value)) return "dismissed";

  const same = open.find((s) => s.status === "pending" && s.googleDate === google.date.value);
  const others = open.filter((s) => s.status === "pending" && s !== same);
  if (others.length) {
    await db.releaseSuggestion.updateMany({
      where: { id: { in: others.map((s) => s.id) } },
      data: { status: "superseded", resolvedAt: new Date() },
    });
  }

  const fields = {
    title: product.title,
    isbn,
    currentDate: product.release,
    googleTitle: google.title,
    googleUrl: google.url,
    source,
  };

  if (same) {
    await db.releaseSuggestion.update({ where: { id: same.id }, data: fields });
    return "existing";
  }

  await db.releaseSuggestion.create({
    data: {
      shop,
      productId: product.id,
      googleDate: google.date.value,
      precision: google.date.precision,
      ...fields,
    },
  });
  return "new";
}

// ---------------------------------------------------------------------------
// The check (runs in the background; the page polls for progress)
// ---------------------------------------------------------------------------

const jobs = new Map(); // shop -> progress

export const getBooksJob = (shop) => jobs.get(shop) ?? null;
const isRunning = (shop) => jobs.get(shop)?.state === "running";

// options.bulkId: reuse a finished catalog scan (the daily run passes its own)
export async function runBooksCheck(shop, { bulkId = null, source = "Manual" } = {}) {
  if (isRunning(shop)) throw new Error("A release date check is already running.");

  const job = {
    source,
    state: "running",
    step: bulkId ? "Preparing" : "Scanning catalog",
    done: 0,
    total: 0,
    newCount: 0,
    differences: 0,
    agrees: 0,
    notFound: 0,
    noDate: 0,
    fromPrh: 0,
    fromGoogle: 0,
    prhProblem: null,
    noIsbn: [], // { id, title }
    stoppedEarly: null,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(shop, job);

  try {
    const { admin } = await unauthenticated.admin(shop);
    if (!bulkId) {
      bulkId = await startScan(admin);
      await waitForScan(admin, bulkId);
    }

    // Upcoming pre-orders only: active or draft, release date after today.
    // Soonest releases first, so they get checked even if Google cuts us off.
    const today = todayInStore();
    const products = (await loadCatalog(admin, bulkId))
      .filter((p) => p.status !== "ARCHIVED" && p.release && daysUntil(today, p.release) > 0)
      .sort((a, b) => a.release.localeCompare(b.release));

    job.total = products.length;
    let usePrh = prhEnabled();
    job.step = usePrh ? "Checking Penguin Random House, then Google Books" : "Checking Google Books";

    for (const p of products) {
      const isbn = p.variants.map((v) => toIsbn(v.barcode)).find(Boolean);
      if (!isbn) {
        job.noIsbn.push({ id: p.id, title: p.title });
        job.done++;
        continue;
      }

      try {
        // The publisher first (if set up), then Google for anything PRH doesn't have
        let found = null;
        if (usePrh) {
          try {
            found = await lookupPrh(isbn);
            if (found && !found.date) found = null;
            await sleep(PRH_GAP_MS);
          } catch (e) {
            if (e instanceof PrhKeyError) {
              job.prhProblem = e.message;
              usePrh = false;
            } else {
              job.errors.push(`${p.title} (Penguin Random House): ${errorMessage(e)}`);
            }
            found = null;
          }
        }
        const google = found ?? (await lookupIsbn(isbn));
        if (found) job.fromPrh++;
        else if (google) job.fromGoogle++;
        if (!google) job.notFound++;
        else if (!google.date) job.noDate++;
        else {
          const result = await recordResult(shop, p, isbn, google);
          if (result === "agrees") job.agrees++;
          else job.differences++;
          if (result === "new") job.newCount++;
        }
      } catch (e) {
        if (e instanceof QuotaError) {
          job.stoppedEarly = `${e.message}. Checked ${job.done} of ${job.total}; the rest will be checked next time.`;
          break;
        }
        job.errors.push(`${p.title}: ${errorMessage(e)}`);
      }

      job.done++;
      await sleep(REQUEST_GAP_MS);
    }

    job.state = "done";
    job.step = "Finished";
  } catch (e) {
    job.state = "failed";
    job.step = "Stopped";
    job.errors.push(errorMessage(e));
  }
  job.finishedAt = new Date().toISOString();
  job.noIsbn.sort((a, b) => a.title.localeCompare(b.title));

  const summary =
    job.state === "failed"
      ? `Failed: ${job.errors[job.errors.length - 1]}`
      : [
          `${job.done} of ${job.total} checked`,
          `${job.newCount} new to review`,
          job.noIsbn.length ? `${job.noIsbn.length} without an ISBN` : null,
          job.fromPrh ? `${job.fromPrh} from Penguin Random House` : null,
          job.notFound ? `${job.notFound} not found` : null,
          job.prhProblem ? "PRH key not accepted" : null,
          job.stoppedEarly ? "stopped early (Google limit)" : null,
        ]
          .filter(Boolean)
          .join(", ");

  await db.preorderState.upsert({
    where: { shop },
    create: { shop, lastBooksAt: new Date(), lastBooksSummary: summary },
    update: { lastBooksAt: new Date(), lastBooksSummary: summary },
  });

  return job;
}

// Starts a check in the background and returns right away
export function startBooksCheck(shop) {
  if (isRunning(shop)) throw new Error("A release date check is already running.");
  runBooksCheck(shop).catch((e) => console.error("[books] check:", errorMessage(e)));
  return getBooksJob(shop);
}

// ---------------------------------------------------------------------------
// Approve and dismiss
// ---------------------------------------------------------------------------

// Approves suggestions one by one. Returns { approved, errors }.
export async function approveSuggestions(admin, shop, ids) {
  const suggestions = await db.releaseSuggestion.findMany({
    where: { shop, id: { in: ids }, status: "pending" },
  });

  let approved = 0;
  const errors = [];

  for (const s of suggestions) {
    if (s.precision !== "day") {
      errors.push(`${s.title}: Google only gives ${s.googleDate}, so set the exact date in the quick view.`);
      continue;
    }
    try {
      await setReleaseDate(admin, shop, s.productId, s.googleDate, "Release review");
      await db.releaseSuggestion.update({
        where: { id: s.id },
        data: { status: "approved", resolvedAt: new Date() },
      });
      approved++;
    } catch (e) {
      errors.push(`${s.title}: ${errorMessage(e)}`);
    }
  }

  return { approved, errors };
}

export async function dismissSuggestions(shop, ids) {
  const { count } = await db.releaseSuggestion.updateMany({
    where: { shop, id: { in: ids }, status: "pending" },
    data: { status: "dismissed", resolvedAt: new Date() },
  });
  return { dismissed: count };
}
