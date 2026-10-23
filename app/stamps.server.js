import crypto from "node:crypto";
import db from "./db.server";

// ---------------------------------------------------------------------------
// Stamps.com (Stamps.com/Endicia REST API "SERA") rate test, for the Debug page.
//
// Only gets rates: nothing here buys a label. Pick past shipments, choose carriers,
// and every rate request is timed, to see how quickly rates come back.
//
// Setup (Railway variables): STAMPS_CLIENT_ID, STAMPS_CLIENT_SECRET, and
// STAMPS_ENV=production once ready (staging otherwise). In the Stamps.com developer
// portal, add the redirect address <app>/stamps/callback.
// ---------------------------------------------------------------------------

export class StampsError extends Error {}

export const CARRIERS = { usps: "USPS", ups: "UPS", fedex: "FedEx", dhl_express: "DHL Express", globalpost: "GlobalPost" };
const ENVS = {
  staging: { api: "https://api.testing.stampsendicia.com/sera", signin: "https://signin.testing.stampsendicia.com", label: "Staging (test account, practice rates)" },
  production: { api: "https://api.stampsendicia.com/sera", signin: "https://signin.stampsendicia.com", label: "Production (your real account rates)" },
};
const STATE_MS = 15 * 60_000;
const REQUEST_MS = 30_000;
const MAX_SHIPMENTS = 25;

export const stampsEnv = () => (process.env.STAMPS_ENV === "production" ? "production" : "staging");
export const stampsEnvLabel = () => ENVS[stampsEnv()].label;
export const stampsConfigured = () => Boolean(process.env.STAMPS_CLIENT_ID && process.env.STAMPS_CLIENT_SECRET);
const urls = () => ENVS[stampsEnv()];
const appUrl = (request) => String(process.env.SHOPIFY_APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
export const redirectUri = (request) => `${appUrl(request)}/stamps/callback`;

// Tokens are stored encrypted (key derived from the client secret: rotating the secret means reconnecting)
const key = () => crypto.createHash("sha256").update(`stamps-tokens:${process.env.STAMPS_CLIENT_SECRET ?? ""}`).digest();
function seal(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}
function unseal(s) {
  if (!s) return null;
  try {
    const [v, iv, tag, body] = s.split(".");
    if (v !== "v1") return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms, sub-millisecond

async function connection(shop) {
  return db.stampsConnection.upsert({ where: { shop }, create: { shop, env: stampsEnv() }, update: {} });
}

export async function stampsStatus(shop, admin = null) {
  let c = await connection(shop);
  // Ship-from: the store's first active location until changed here
  if (!c.fromZip && admin) {
    try {
      const res = await admin.graphql(LOCATIONS);
      const loc = (await res.json())?.data?.locations?.nodes?.find((l) => l.isActive && l.address?.zip);
      if (loc) {
        c = await db.stampsConnection.update({
          where: { shop },
          data: { fromName: loc.name, fromLine1: loc.address.address1, fromCity: loc.address.city, fromState: loc.address.provinceCode, fromZip: loc.address.zip, fromCountry: loc.address.countryCode },
        });
      }
    } catch {
      /* typed in instead */
    }
  }
  const sameEnv = c.env === stampsEnv();
  return {
    configured: stampsConfigured(),
    env: stampsEnv(),
    envLabel: stampsEnvLabel(),
    connected: Boolean(c.refreshToken && sameEnv && unseal(c.refreshToken)),
    otherEnv: Boolean(c.refreshToken && !sameEnv),
    connectedBy: c.connectedBy,
    connectedAt: c.connectedAt?.toISOString() ?? null,
    from: { name: c.fromName ?? "", line1: c.fromLine1 ?? "", city: c.fromCity ?? "", state: c.fromState ?? "", zip: c.fromZip ?? "", country: c.fromCountry ?? "US" },
  };
}

export async function saveFrom(shop, input) {
  const t = (v, n = 80) => String(v ?? "").trim().slice(0, n) || null;
  const zip = t(input.zip, 12);
  if (!zip) throw new StampsError("The ship-from ZIP code is needed.");
  await connection(shop);
  await db.stampsConnection.update({
    where: { shop },
    data: { fromName: t(input.name), fromLine1: t(input.line1), fromCity: t(input.city), fromState: t(input.state, 3), fromZip: zip, fromCountry: (t(input.country, 2) ?? "US").toUpperCase() },
  });
}

// ---------------------------------------------------------------------------
// Connecting (OAuth 2 authorization code, in a separate tab: sign-in pages can't run inside Shopify admin)
// ---------------------------------------------------------------------------

export async function startConnect(shop, user, request) {
  if (!stampsConfigured()) throw new StampsError("Add STAMPS_CLIENT_ID and STAMPS_CLIENT_SECRET in Railway first.");
  await connection(shop);
  const state = crypto.randomBytes(24).toString("base64url");
  await db.stampsConnection.update({ where: { shop }, data: { pendingState: state, pendingBy: user?.name ?? null, pendingExpiresAt: new Date(Date.now() + STATE_MS) } });
  return { url: `${appUrl(request)}/stamps/connect?state=${encodeURIComponent(state)}` };
}

export async function authorizeUrl(state, request) {
  const c = state ? await db.stampsConnection.findUnique({ where: { pendingState: String(state) } }) : null;
  if (!c || !c.pendingExpiresAt || c.pendingExpiresAt < new Date()) throw new StampsError("This link has expired. Start again from the app's Label rate test page.");
  const q = new URLSearchParams({ response_type: "code", client_id: process.env.STAMPS_CLIENT_ID ?? "", redirect_uri: redirectUri(request), scope: "offline_access", state: String(state) });
  return `${urls().signin}/authorize?${q}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${urls().signin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: process.env.STAMPS_CLIENT_ID, client_secret: process.env.STAMPS_CLIENT_SECRET, ...body }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok || !data?.access_token) throw new StampsError(`Stamps.com sign-in failed (${res.status}): ${errorText(data, text)}`);
  return data;
}

async function saveTokens(shop, data, extra = {}) {
  const c = await db.stampsConnection.findUnique({ where: { shop } });
  const given = data.expires_in === undefined || data.expires_in === null || data.expires_in === "" ? NaN : Number(data.expires_in);
  const expires = Number.isFinite(given) ? given : 3600;
  await db.stampsConnection.update({
    where: { shop },
    data: {
      env: stampsEnv(),
      accessToken: seal(data.access_token),
      accessExpiresAt: new Date(Date.now() + (expires - 60) * 1000),
      // Keep the newest refresh token (it may rotate)
      refreshToken: data.refresh_token ? seal(data.refresh_token) : c?.refreshToken ?? null,
      ...extra,
    },
  });
}

export async function finishConnect(code, state, request) {
  const c = state ? await db.stampsConnection.findUnique({ where: { pendingState: String(state) } }) : null;
  if (!c || !c.pendingExpiresAt || c.pendingExpiresAt < new Date()) throw new StampsError("This sign-in has expired. Start again from the app's Label rate test page.");
  if (!code) throw new StampsError("Stamps.com didn't send a sign-in code.");
  const data = await tokenRequest({ grant_type: "authorization_code", code: String(code), redirect_uri: redirectUri(request) });
  if (!data.refresh_token) throw new StampsError("Stamps.com didn't return a refresh token (the offline_access scope may not be enabled for this app).");
  await saveTokens(c.shop, data, { connectedBy: c.pendingBy, connectedAt: new Date(), pendingState: null, pendingExpiresAt: null });
  return { shop: c.shop };
}

export async function disconnect(shop) {
  await connection(shop);
  await db.stampsConnection.update({ where: { shop }, data: { refreshToken: null, accessToken: null, accessExpiresAt: null, connectedBy: null, connectedAt: null } });
}

// A current access token, and how long getting it took (0 when the saved one was still good)
async function accessToken(shop) {
  const c = await db.stampsConnection.findUnique({ where: { shop } });
  if (!c?.refreshToken || c.env !== stampsEnv()) throw new StampsError("Connect a Stamps.com account first.");
  const saved = unseal(c.accessToken);
  if (saved && c.accessExpiresAt && c.accessExpiresAt > new Date()) return { token: saved, ms: 0 };
  const refresh = unseal(c.refreshToken);
  if (!refresh) throw new StampsError("The saved Stamps.com sign-in can't be read (the client secret changed?). Connect again.");
  const t0 = now();
  const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  const ms = now() - t0;
  await saveTokens(shop, data);
  return { token: data.access_token, ms };
}

function errorText(data, text) {
  const m =
    data?.error_description ??
    data?.message ??
    (Array.isArray(data?.errors) ? data.errors.map((e) => e.message ?? e.error_message ?? JSON.stringify(e)).join("; ") : null) ??
    data?.error ??
    String(text ?? "").slice(0, 300);
  return String(m || "no details").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Shipments to test with
// ---------------------------------------------------------------------------

const LOCATIONS = `#graphql
  query RateTestLocations {
    locations(first: 10) {
      nodes {
        name
        isActive
        address { address1 city provinceCode zip countryCode }
      }
    }
  }`;

const ADDRESSES = `#graphql
  query RateTestAddresses($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 phone }
      }
    }
  }`;

const pkgView = (s) =>
  s.pkgWeight != null || s.pkgLength != null
    ? { weight: s.pkgWeight, weightUnit: s.pkgWeightUnit, l: s.pkgLength, w: s.pkgWidth, h: s.pkgHeight, dimUnit: s.pkgDimUnit, box: s.pkgBox }
    : null;

export async function testShipments(shop, q = "") {
  const text = String(q ?? "").trim().replace(/^#/, "");
  const rows = await db.shipment.findMany({
    where: { shop, ...(text ? { OR: [{ orderName: { contains: text, mode: "insensitive" } }, { customerName: { contains: text, mode: "insensitive" } }] } : {}) },
    orderBy: [{ orderCreatedAt: "desc" }, { id: "desc" }],
    take: 40,
  });
  return rows.map((s) => ({
    id: s.id,
    orderName: s.orderName,
    part: s.partCount > 1 ? `${s.partIndex}/${s.partCount}` : null,
    placedAt: s.orderCreatedAt.toISOString(),
    state: s.state,
    units: s.units,
    where: [s.province, s.country].filter(Boolean).join(", "),
    method: s.shippingMethod,
    pkg: pkgView(s),
  }));
}

// ---------------------------------------------------------------------------
// The test run (in the background; the page follows its progress)
// ---------------------------------------------------------------------------

const WEIGHT = { lb: "pound", oz: "ounce", kg: "kilogram", g: "gram" };
const DIM = { in: "inch", cm: "centimeter" };
const jobs = new Map();
export const rateTestJob = (shop) => jobs.get(shop) ?? null;

function packageFor(s, def, useBench) {
  const bench = useBench ? pkgView(s) : null;
  const weight = bench?.weight ?? def.weight;
  const weightUnit = bench?.weight != null ? bench.weightUnit : def.weightUnit;
  const dims = bench?.l != null ? { l: bench.l, w: bench.w, h: bench.h, unit: bench.dimUnit } : def.l ? { l: def.l, w: def.w, h: def.h, unit: def.dimUnit } : null;
  const p = { packaging_type: "package", weight: Number(weight), weight_unit: WEIGHT[weightUnit] ?? "pound" };
  if (dims) Object.assign(p, { length: Number(dims.l), width: Number(dims.w), height: Number(dims.h), dimension_unit: DIM[dims.unit] ?? "inch" });
  return { pkg: p, source: bench?.weight != null ? "pack bench" : "test default" };
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
export function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  if (!s.length) return null;
  const r = (x) => Math.round(x);
  return { n: s.length, min: r(s[0]), median: r(pct(s, 50)), avg: r(s.reduce((a, b) => a + b, 0) / s.length), p95: r(pct(s, 95)), max: r(s[s.length - 1]) };
}

async function getRates(token, body, carrier) {
  const t0 = now();
  let res;
  let text = "";
  try {
    res = await fetch(`${urls().api}/v1/rates?carriers=${encodeURIComponent(carrier)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, ms: Math.round(now() - t0), status: null, error: e?.name === "TimeoutError" ? `No answer within ${REQUEST_MS / 1000} s` : `Couldn't reach Stamps.com: ${e?.message ?? e}` };
  }
  const ms = Math.round(now() - t0);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) return { ok: false, ms, status: res.status, error: errorText(data, text) };
  const list = Array.isArray(data) ? data : Array.isArray(data?.rates) ? data.rates : [];
  const rates = list
    .map((r) => ({
      carrier: r.carrier ?? carrier,
      service: r.service_type ?? "",
      packaging: r.packaging_type ?? null,
      total: r.shipment_cost?.total_amount != null ? Number(r.shipment_cost.total_amount) : null,
      currency: String(r.shipment_cost?.currency ?? "usd").toUpperCase(),
      days: r.estimated_delivery_days ?? null,
      deliveryDate: r.estimated_delivery_date ?? null,
      guaranteed: Boolean(r.is_guaranteed_service),
    }))
    .sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
  return { ok: true, ms, status: res.status, rates };
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (i < items.length) {
      const n = i++;
      await fn(items[n], n);
    }
  });
  await Promise.all(workers);
}

const storeDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

export async function startRateTest(shop, admin, input, user) {
  if (jobs.get(shop)?.running) throw new StampsError("A test is already running.");
  const ids = [...new Set((input.ids ?? []).map(Number).filter(Boolean))];
  if (!ids.length) throw new StampsError("Choose at least one shipment.");
  if (ids.length > MAX_SHIPMENTS) throw new StampsError(`Choose up to ${MAX_SHIPMENTS} shipments at a time.`);
  const carriers = (input.carriers ?? []).filter((c) => CARRIERS[c]);
  if (!carriers.length) throw new StampsError("Choose at least one carrier.");
  const def = {
    weight: Number(input.weight),
    weightUnit: WEIGHT[input.weightUnit] ? input.weightUnit : "lb",
    l: Number(input.l) || null,
    w: Number(input.w) || null,
    h: Number(input.h) || null,
    dimUnit: DIM[input.dimUnit] ? input.dimUnit : "in",
  };
  const useBench = input.useBench !== false;
  if (!(def.weight > 0)) throw new StampsError("Enter a test weight (used when a shipment has no weight from the pack bench).");
  if (def.l && !(def.w > 0 && def.h > 0)) throw new StampsError("Enter all three dimensions, or none.");
  const concurrency = Number(input.concurrency) === 4 ? 4 : 1;
  const c = await connection(shop);
  if (!c.fromZip) throw new StampsError("Enter the ship-from ZIP code first.");
  if (!c.refreshToken || c.env !== stampsEnv()) throw new StampsError("Connect a Stamps.com account first.");

  const job = { running: true, startedAt: new Date().toISOString(), done: 0, total: ids.length * carriers.length, by: user?.name ?? null, runId: null, error: null };
  jobs.set(shop, job);
  const work = (async () => {
    const t0 = now();
    const shipments = await db.shipment.findMany({ where: { shop, id: { in: ids } } });
    // Destinations from the orders in Shopify
    const addr = new Map();
    const orderIds = [...new Set(shipments.map((s) => s.orderId))];
    for (let i = 0; i < orderIds.length; i += 50) {
      try {
        const res = await admin.graphql(ADDRESSES, { variables: { ids: orderIds.slice(i, i + 50) } });
        for (const n of (await res.json())?.data?.nodes ?? []) if (n?.id) addr.set(n.id, n.shippingAddress ?? null);
      } catch {
        /* reported per shipment */
      }
    }
    const tok = await accessToken(shop);
    const from = { name: c.fromName ?? undefined, address_line1: c.fromLine1 ?? undefined, city: c.fromCity ?? undefined, state_province: c.fromState ?? undefined, postal_code: c.fromZip, country_code: c.fromCountry ?? "US" };
    const results = shipments
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
      .map((s) => {
        const a = addr.get(s.orderId);
        const { pkg, source } = packageFor(s, def, useBench);
        return {
          id: s.id,
          orderName: s.orderName,
          to: a ? [a.city, a.provinceCode, a.zip, a.countryCodeV2].filter(Boolean).join(" ") : null,
          international: a ? a.countryCodeV2 !== (c.fromCountry ?? "US") : null,
          package: { ...pkg, source },
          address: a,
          carriers: {},
          error: a?.zip || (a && !["US", "CA"].includes(a.countryCodeV2)) ? null : "No shipping address from Shopify (or it has no postal code)",
        };
      });
    const tasks = results.filter((r) => !r.error).flatMap((r) => carriers.map((carrier) => ({ r, carrier })));
    job.total = tasks.length;
    await pool(tasks, concurrency, async ({ r, carrier }) => {
      const a = r.address;
      const body = {
        from_address: from,
        to_address: {
          name: a.name ?? undefined,
          company_name: a.company ?? undefined,
          address_line1: a.address1 ?? undefined,
          address_line2: a.address2 ?? undefined,
          city: a.city ?? undefined,
          state_province: a.provinceCode ?? undefined,
          postal_code: a.zip ?? undefined,
          country_code: a.countryCodeV2,
          phone: a.phone ?? undefined,
        },
        package: r.package.source ? Object.fromEntries(Object.entries(r.package).filter(([k]) => k !== "source")) : r.package,
        ship_date: storeDay(),
      };
      r.carriers[carrier] = await getRates(tok.token, body, carrier);
      job.done++;
    });
    const totalMs = Math.round(now() - t0);
    // Summary
    const all = results.flatMap((r) => Object.values(r.carriers));
    const perCarrier = Object.fromEntries(
      carriers.map((k) => {
        const list = results.map((r) => r.carriers[k]).filter(Boolean);
        return [k, { requests: list.length, ok: list.filter((x) => x.ok).length, rates: list.reduce((n, x) => n + (x.rates?.length ?? 0), 0), time: stats(list.map((x) => x.ms)) }];
      }),
    );
    const summary = {
      shipments: results.length,
      skipped: results.filter((r) => r.error).length,
      requests: all.length,
      ok: all.filter((x) => x.ok).length,
      failed: all.filter((x) => !x.ok).length,
      rates: all.reduce((n, x) => n + (x.rates?.length ?? 0), 0),
      time: stats(all.map((x) => x.ms)),
      perCarrier,
      tokenMs: Math.round(tok.ms),
      totalMs,
      concurrency,
    };
    for (const r of results) delete r.address; // customer addresses aren't kept
    const run = await db.rateTestRun.create({
      data: { shop, env: stampsEnv(), by: user?.name ?? null, settings: JSON.stringify({ carriers, def, useBench, concurrency, from: { zip: c.fromZip, country: c.fromCountry } }), results: JSON.stringify(results), summary: JSON.stringify(summary) },
    });
    // Keep the last 30 runs
    const old = await db.rateTestRun.findMany({ where: { shop }, orderBy: { id: "desc" }, skip: 30, select: { id: true } });
    if (old.length) await db.rateTestRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    job.runId = run.id;
  })()
    .catch((e) => {
      job.error = e instanceof StampsError ? e.message : `The test stopped: ${e?.message ?? e}`;
      if (!(e instanceof StampsError)) console.error("[stamps] rate test:", e);
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    });
  if (process.env.NODE_ENV === "test") await work;
  return job;
}

const runView = (r, full = false) => ({
  id: r.id,
  env: r.env,
  by: r.by,
  at: r.createdAt.toISOString(),
  settings: JSON.parse(r.settings),
  summary: JSON.parse(r.summary),
  ...(full ? { results: JSON.parse(r.results) } : {}),
});
export async function listRuns(shop) {
  return (await db.rateTestRun.findMany({ where: { shop }, orderBy: { id: "desc" }, take: 30 })).map((r) => runView(r));
}
export async function getRun(shop, id) {
  const r = await db.rateTestRun.findFirst({ where: { shop, id: Number(id) } });
  if (!r) throw new StampsError("That test run couldn't be found.");
  return runView(r, true);
}

// The small page shown in the sign-in tab
export function stampsPage(message, ok) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stamps.com</title>
<style>body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:#f6f6f7;margin:0;display:grid;place-items:center;min-height:100vh}
div{background:#fff;border-radius:14px;padding:28px 32px;max-width:440px;box-shadow:0 1px 3px rgba(0,0,0,.12)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#4a4a4a;line-height:1.5}</style></head>
<body><div><h1>${ok ? "✓ Stamps.com connected" : "Stamps.com wasn't connected"}</h1><p>${esc(message)}</p></div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
