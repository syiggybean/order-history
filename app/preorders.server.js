import db from "./db.server";
import { unauthenticated } from "./shopify.server";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const TIME_ZONE = "America/Los_Angeles";
export const NAMESPACE = "app-ibp-book";
export const KEY = "publication_date";
export const DAILY_HOUR = 6; // daily run starts at 6 AM store time

// Longest window first. A product gets the first tier its release date
// qualifies for. Anything under 30 days (or already released) gets no GT tag
// and goes to the General profile.
export const TIERS = [
  { minDays: 180, tag: "GT180Days" },
  { minDays: 120, tag: "GT120Days" },
  { minDays: 90, tag: "GT90Days" },
  { minDays: 60, tag: "GT60Days" },
  { minDays: 30, tag: "GT30Days" },
];

// Old GT tags that should be removed if a product still has them
const LEGACY_TAGS = [];

const ALL_GT_TAGS = [...TIERS.map((t) => t.tag), ...LEGACY_TAGS];
const isGtTag = (tag) => ALL_GT_TAGS.some((g) => g.toLowerCase() === tag.toLowerCase());

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const hourFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour: "numeric",
  hourCycle: "h23",
});

export const todayInStore = () => dayFormatter.format(new Date());
export const dayInStore = (date) => dayFormatter.format(date);
const hourInStore = () => Number(hourFormatter.format(new Date()));

// Turns a metafield value into "YYYY-MM-DD", or null if it isn't a date
export function toDay(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  return isNaN(d) ? null : dayFormatter.format(d);
}

export function daysUntil(today, day) {
  const [y1, m1, d1] = today.split("-").map(Number);
  const [y2, m2, d2] = day.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export const tierFor = (days) => TIERS.find((t) => days >= t.minDays) ?? null;

// ---------------------------------------------------------------------------
// Product page template: a product whose release date is still to come (or
// that has a pre-order countdown) uses the theme's "preorder" template, where
// the countdown blocks live. Released products go back to the default
// template. Products on any other custom template are left alone.
// ---------------------------------------------------------------------------

export const PREORDER_TEMPLATE = "preorder";
export const templateName = (suffix) => (suffix ? `product.${suffix}` : "Default product");

// p: { release, templateSuffix } → null (fine), { conflict } or { from, to }
export function templatePlan(p, today, inCountdown = false) {
  const current = p.templateSuffix ?? "";
  const want = (p.release && p.release > today) || inCountdown ? PREORDER_TEMPLATE : "";
  if (current === want) return null;
  if (want === PREORDER_TEMPLATE && current !== "") return { conflict: current };
  if (want === "" && current !== PREORDER_TEMPLATE) return null;
  return { from: current, to: want };
}

// Products with countdown times set (they need the preorder template too)
export async function countdownProductIds(shop) {
  const rows = await db.preorderWindow.findMany({
    // Finished ones (closed, kept selling) are back to normal product pages
    where: { shop, OR: [{ opensAt: { not: null } }, { closesAt: { not: null } }], NOT: { keepSelling: true, appliedPhase: "closed" } },
    select: { productId: true },
  });
  return new Set(rows.map((r) => r.productId));
}

// ---------------------------------------------------------------------------
// GraphQL helpers (retry when Shopify asks us to slow down)
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(admin, query, variables) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await admin.graphql(query, variables ? { variables } : undefined);
      const json = await res.json();
      return json.data;
    } catch (e) {
      const errs = e?.body?.errors?.graphQLErrors ?? [];
      const throttled =
        errs.some((x) => x?.extensions?.code === "THROTTLED") || /throttl/i.test(e?.message ?? "");
      if (throttled && attempt < 6) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

function checkUserErrors(result, label) {
  const errs = result?.userErrors ?? [];
  if (errs.length) throw new Error(`${label}: ${errs.map((e) => e.message).join("; ")}`);
}

export const errorMessage = (e) =>
  e?.body?.errors?.graphQLErrors?.map((x) => x.message).join("; ") || e?.message || String(e);

// ---------------------------------------------------------------------------
// Shipping profiles
// ---------------------------------------------------------------------------

export async function loadProfiles(admin) {
  const data = await gql(
    admin,
    `#graphql
    query {
      deliveryProfiles(first: 50) {
        nodes { id name default }
      }
    }`,
  );
  const nodes = data.deliveryProfiles.nodes;
  const generalNode = nodes.find((p) => p.default);

  // Match "GT30Days", "GT 30 Days", "GT30" etc. (but not "GT300")
  const tiers = TIERS.map((t) => {
    const n = t.tag.match(/\d+/)[0];
    const re = new RegExp(`gt${n}(?!\\d)`, "i");
    const match = nodes.find((p) => !p.default && re.test(p.name.replace(/[^a-z0-9]/gi, "")));
    return { tag: t.tag, minDays: t.minDays, profile: match ? { id: match.id, name: match.name } : null };
  });

  return {
    general: generalNode ? { id: generalNode.id, name: generalNode.name } : null,
    tiers,
    names: Object.fromEntries(nodes.map((p) => [p.id, p.name])),
    missing: [
      ...(generalNode ? [] : ["General"]),
      ...tiers.filter((t) => !t.profile).map((t) => t.tag),
    ],
  };
}

// ---------------------------------------------------------------------------
// The rules for one product. Returns the change needed, or a reason it was
// skipped. Used by full scans, the daily run and product-edit updates alike.
//
// product: { id, title, status, tags, release ("YYYY-MM-DD" or null),
//            variants: [{ id, profileId }] }
// ---------------------------------------------------------------------------

function planForProduct(p, profiles, today, countdown = new Set()) {
  if (p.status === "ARCHIVED") return { skip: "archived" };

  const t = templatePlan(p, today, countdown.has(p.id));
  const tpl = t && !t.conflict ? t : null;
  const templateConflict = t?.conflict ?? null;
  const templateFields = {
    templateChange: Boolean(tpl),
    fromTemplate: tpl ? templateName(tpl.from) : null,
    toTemplate: tpl ? templateName(tpl.to) : null,
    templateSuffix: tpl ? tpl.to : null,
  };

  const currentGt = p.tags.filter(isGtTag);
  if (!p.release) {
    const out = currentGt.length ? { skip: "noRelease", tags: currentGt } : { skip: "noRelease" };
    if (templateConflict) out.templateConflict = templateConflict;
    if (tpl) {
      // No release date, but the template still needs changing (e.g. countdown added or removed)
      out.change = {
        id: p.id,
        title: p.title,
        release: null,
        days: null,
        tagChange: false,
        fromTag: currentGt.length ? currentGt.join(", ") : null,
        toTag: currentGt.length ? currentGt.join(", ") : null,
        add: [],
        remove: [],
        fromProfile: null,
        toProfile: null,
        toProfileId: null,
        moveVariantIds: [],
        ...templateFields,
      };
    }
    return out;
  }

  const days = daysUntil(today, p.release);
  const want = tierFor(days)?.tag ?? null;
  const remove = currentGt.filter((t) => t !== want);
  const add = want && !currentGt.includes(want) ? [want] : [];

  const tierProfile = (tag) => profiles.tiers.find((t) => t.tag === tag)?.profile ?? null;
  const gtProfileIds = new Set(profiles.tiers.filter((t) => t.profile).map((t) => t.profile.id));
  const nameOf = (id) => (id ? profiles.names[id] ?? "Other profile" : "No profile");

  // Where should it ship from? A GT tier goes to its GT profile. With no tier,
  // it goes to General only if it's leaving pre-order (losing a GT tag or
  // sitting in a GT profile). Products in other custom profiles are left alone.
  let target = null;
  if (want) {
    target = tierProfile(want);
  } else if (remove.length || p.variants.some((v) => gtProfileIds.has(v.profileId))) {
    target = profiles.general;
  }

  const moveVariantIds = target ? p.variants.filter((v) => v.profileId !== target.id).map((v) => v.id) : [];
  if (!add.length && !remove.length && !moveVariantIds.length && !tpl) return { change: null, templateConflict };

  return {
    templateConflict,
    change: {
      id: p.id,
      title: p.title,
      release: p.release,
      days,
      tagChange: Boolean(add.length || remove.length),
      fromTag: currentGt.length ? currentGt.join(", ") : null,
      toTag: want,
      add,
      remove,
      fromProfile: [...new Set(p.variants.map((v) => nameOf(v.profileId)))].join(", "),
      toProfile: moveVariantIds.length ? target.name : null,
      toProfileId: moveVariantIds.length ? target.id : null,
      moveVariantIds,
      ...templateFields,
    },
  };
}

// ---------------------------------------------------------------------------
// Catalog scan (bulk operation, handles thousands of products)
// ---------------------------------------------------------------------------

const BULK_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        status
        tags
        templateSuffix
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
        variants {
          edges {
            node {
              id
              barcode
              deliveryProfile { id }
            }
          }
        }
      }
    }
  }
}`;

export async function startScan(admin) {
  const data = await gql(
    admin,
    `#graphql
    mutation ($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`,
    { query: BULK_QUERY },
  );
  checkUserErrors(data.bulkOperationRunQuery, "Couldn't start the catalog scan");
  return data.bulkOperationRunQuery.bulkOperation.id;
}

export async function scanStatus(admin, bulkId) {
  const data = await gql(
    admin,
    `#graphql
    query ($id: ID!) {
      node(id: $id) {
        ... on BulkOperation { status errorCode objectCount url }
      }
    }`,
    { id: bulkId },
  );
  return data.node;
}

async function downloadProducts(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download scan results (${res.status})`);
  const text = await res.text();

  const products = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.__parentId) {
      products.get(obj.__parentId)?.variants.push({
        id: obj.id,
        barcode: obj.barcode ?? null,
        profileId: obj.deliveryProfile?.id ?? null,
      });
    } else {
      products.set(obj.id, {
        id: obj.id,
        title: obj.title,
        status: obj.status,
        tags: obj.tags ?? [],
        templateSuffix: obj.templateSuffix ?? "",
        release: toDay(obj.metafield?.value),
        variants: [],
      });
    }
  }
  return [...products.values()];
}

// Every product from a finished catalog scan
export async function loadCatalog(admin, bulkId) {
  const op = await scanStatus(admin, bulkId);
  if (op?.status !== "COMPLETED") throw new Error("The catalog scan isn't finished yet.");
  return op.url ? downloadProducts(op.url) : [];
}

// Waits for a catalog scan to finish (up to 30 minutes)
export async function waitForScan(admin, bulkId) {
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    await sleep(5000);
    const op = await scanStatus(admin, bulkId);
    if (op?.status === "COMPLETED") return;
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op?.status)) throw new Error(`Catalog scan ${op.status.toLowerCase()}`);
    if (Date.now() > deadline) throw new Error("Catalog scan took longer than 30 minutes");
  }
}

// Works out what should change across the catalog. Nothing is written here.
// shop: to include products with pre-order countdowns
export async function buildPlan(admin, bulkId, profiles, shop = null) {
  const products = await loadCatalog(admin, bulkId);
  const today = todayInStore();
  const countdown = shop ? await countdownProductIds(shop) : new Set();

  const changes = [];
  const noRelease = []; // has a GT tag but no release date, left alone
  const otherTemplate = []; // should be on the preorder template, but uses its own
  let withRelease = 0;
  let archived = 0;

  for (const p of products) {
    const result = planForProduct(p, profiles, today, countdown);
    if (result.skip === "archived") {
      archived++;
      continue;
    }
    if (result.templateConflict) otherTemplate.push({ id: p.id, title: p.title, template: templateName(result.templateConflict) });
    if (result.skip === "noRelease") {
      if (result.tags) noRelease.push({ id: p.id, title: p.title, tags: result.tags });
      if (result.change) changes.push(result.change);
      continue;
    }
    withRelease++;
    if (result.change) changes.push(result.change);
  }

  changes.sort((a, b) => a.title.localeCompare(b.title));
  noRelease.sort((a, b) => a.title.localeCompare(b.title));
  otherTemplate.sort((a, b) => a.title.localeCompare(b.title));

  return { today, scanned: products.length, archived, withRelease, changes, noRelease, otherTemplate };
}

// ---------------------------------------------------------------------------
// Applying changes
// ---------------------------------------------------------------------------

const TAGS_REMOVE = `#graphql
  mutation ($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { message } }
  }`;

const TAGS_ADD = `#graphql
  mutation ($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { message } }
  }`;

const PROFILE_ASSOCIATE = `#graphql
  mutation ($id: ID!, $variants: [ID!]!) {
    deliveryProfileUpdate(id: $id, profile: { variantsToAssociate: $variants }) {
      userErrors { field message }
    }
  }`;

const TEMPLATE_SET = `#graphql
  mutation TemplateSet($product: ProductUpdateInput!) {
    productUpdate(product: $product) { userErrors { field message } }
  }`;

const newJob = (source) => ({
  source,
  state: "running",
  step: "Preparing",
  done: 0,
  total: 0,
  retagged: 0,
  moved: 0,
  templated: 0,
  byProfile: {}, // profile name -> products moved in
  errors: [],
  failedIds: [], // products with at least one change that didn't go through
  onlyIds: null, // a selection, or null for everything
  templatesOnly: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
});

// Applies a list of changes, updating `job` as it goes, and writes one
// activity entry per product. `source` is shown in the activity log.
async function applyChanges(admin, shop, changes, source, job) {
  const results = new Map(changes.map((c) => [c.id, { change: c, tagDone: false, moveDone: false, templateDone: false }]));

  // 1. Tags
  const tagChanges = changes.filter((c) => c.tagChange);
  job.total = tagChanges.length;
  job.step = "Updating tags";

  for (const c of tagChanges) {
    try {
      if (c.remove.length) {
        const d = await gql(admin, TAGS_REMOVE, { id: c.id, tags: c.remove });
        checkUserErrors(d.tagsRemove, "Removing tags");
      }
      if (c.add.length) {
        const d = await gql(admin, TAGS_ADD, { id: c.id, tags: c.add });
        checkUserErrors(d.tagsAdd, "Adding tags");
      }
      results.get(c.id).tagDone = true;
      job.retagged++;
    } catch (e) {
      job.errors.push(`${c.title} (tags): ${errorMessage(e)}`);
      job.failedIds.push(c.id);
    }
    job.done++;
  }

  // 2. Shipping profiles, grouped by destination, ~100 variants per call
  job.step = "Updating shipping profiles";
  const byTarget = new Map();
  for (const c of changes) {
    if (!c.moveVariantIds.length) continue;
    if (!byTarget.has(c.toProfileId)) byTarget.set(c.toProfileId, []);
    byTarget.get(c.toProfileId).push(c);
  }

  for (const [profileId, list] of byTarget) {
    let batch = [];
    let count = 0;

    const flush = async () => {
      if (!batch.length) return;
      const name = batch[0].toProfile;
      try {
        const d = await gql(admin, PROFILE_ASSOCIATE, {
          id: profileId,
          variants: batch.flatMap((c) => c.moveVariantIds),
        });
        checkUserErrors(d.deliveryProfileUpdate, `Moving to ${name}`);
        for (const c of batch) results.get(c.id).moveDone = true;
        job.moved += batch.length;
        job.byProfile[name] = (job.byProfile[name] ?? 0) + batch.length;
      } catch (e) {
        job.errors.push(`${name}: ${errorMessage(e)} (${batch.map((c) => c.title).join(", ")})`);
        job.failedIds.push(...batch.map((c) => c.id));
      }
      batch = [];
      count = 0;
    };

    for (const c of list) {
      if (count + c.moveVariantIds.length > 100) await flush();
      batch.push(c);
      count += c.moveVariantIds.length;
    }
    await flush();
  }

  // 3. Product page template
  job.step = "Updating product templates";
  for (const c of changes.filter((x) => x.templateChange)) {
    try {
      const d = await gql(admin, TEMPLATE_SET, { product: { id: c.id, templateSuffix: c.templateSuffix ?? "" } });
      checkUserErrors(d.productUpdate, "Changing the template");
      results.get(c.id).templateDone = true;
      job.templated++;
    } catch (e) {
      job.errors.push(`${c.title} (template): ${errorMessage(e)}`);
      job.failedIds.push(c.id);
    }
  }

  // 4. One activity entry per product, describing what actually happened
  const entries = [];
  for (const { change: c, tagDone, moveDone, templateDone } of results.values()) {
    if (!tagDone && !moveDone && !templateDone) continue;
    const parts = [];
    if (c.tagChange) parts.push(`Tag: ${c.fromTag ?? "none"} → ${c.toTag ?? "none"}${tagDone ? "" : " (failed)"}`);
    if (c.moveVariantIds.length) parts.push(`Shipping: ${c.fromProfile} → ${c.toProfile}${moveDone ? "" : " (failed)"}`);
    if (c.templateChange) parts.push(`Template: ${c.fromTemplate} → ${c.toTemplate}${templateDone ? "" : " (failed)"}`);
    entries.push({
      shop,
      productId: c.id,
      title: c.title,
      action: source,
      detail: parts.join(" · "),
      release: c.release,
    });
  }
  if (entries.length) await db.preorderLog.createMany({ data: entries });
}

// ---------------------------------------------------------------------------
// Full runs (Apply button and the daily run). Progress is kept in memory so the
// page can show it; only one full run per shop at a time.
// ---------------------------------------------------------------------------

const jobs = new Map(); // shop -> progress

export const getJob = (shop) => jobs.get(shop) ?? null;
const isRunning = (shop) => jobs.get(shop)?.state === "running";

async function runApply(shop, bulkId, job) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const profiles = await loadProfiles(admin);
    if (profiles.missing.length) throw new Error(`Missing shipping profiles: ${profiles.missing.join(", ")}`);

    const plan = await buildPlan(admin, bulkId, profiles, shop);
    let changes = plan.changes;
    if (job.onlyIds) {
      const only = new Set(job.onlyIds);
      changes = changes.filter((c) => only.has(c.id));
    }
    // Templates only: leave the tags and shipping profiles for another time
    if (job.templatesOnly) {
      changes = changes
        .filter((c) => c.templateChange)
        .map((c) => ({ ...c, tagChange: false, add: [], remove: [], moveVariantIds: [], toProfile: null, toProfileId: null }));
    }
    job.failedIds = [];
    await applyChanges(admin, shop, changes, job.source, job);
    job.failedIds = [...new Set(job.failedIds)];

    job.state = "done";
    job.step = "Finished";
  } catch (e) {
    job.state = "failed";
    job.step = "Stopped";
    job.errors.push(errorMessage(e));
  }
  job.finishedAt = new Date().toISOString();
  return job;
}

// Apply buttons: start in the background and return right away.
// onlyIds: just these products (one row, or a selection); templatesOnly: just the template part
export function startApply(shop, bulkId, { onlyIds = null, templatesOnly = false } = {}) {
  if (isRunning(shop)) throw new Error("Changes are already being applied.");
  if (onlyIds && !onlyIds.length) throw new Error("Select at least one product.");
  const job = newJob(onlyIds ? (onlyIds.length === 1 ? "Manual (one product)" : "Manual (selected)") : "Manual");
  job.onlyIds = onlyIds ? [...new Set(onlyIds.map(String))] : null;
  job.templatesOnly = Boolean(templatesOnly);
  jobs.set(shop, job);
  runApply(shop, bulkId, job);
  return job;
}

// ---------------------------------------------------------------------------
// Single product (product created or edited in Shopify)
// ---------------------------------------------------------------------------

const PRODUCT_QUERY = `#graphql
  query ($id: ID!) {
    product(id: $id) {
      id
      title
      status
      tags
      templateSuffix
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
      variants(first: 250) {
        nodes { id deliveryProfile { id } }
      }
    }
  }`;

const inFlight = new Set(); // product IDs being synced right now

// Returns { status: "busy" | "missing" | "unchanged" | "updated", errors? }
export async function syncProduct(shop, productId, source = "Product edit") {
  // A full run is already handling every product; its own tag edits also
  // trigger product-edit notifications, which we can safely ignore.
  if (isRunning(shop) || inFlight.has(productId)) return { status: "busy" };
  inFlight.add(productId);

  try {
    const { admin } = await unauthenticated.admin(shop);
    const data = await gql(admin, PRODUCT_QUERY, { id: productId });
    const p = data?.product;
    if (!p) return { status: "missing" };

    const profiles = await loadProfiles(admin);
    if (profiles.missing.length) {
      console.warn(`[preorders] skipped ${p.title}: missing shipping profiles ${profiles.missing.join(", ")}`);
      return { status: "missing" };
    }

    const product = {
      id: p.id,
      title: p.title,
      status: p.status,
      tags: p.tags ?? [],
      templateSuffix: p.templateSuffix ?? "",
      release: toDay(p.metafield?.value),
      variants: p.variants.nodes.map((v) => ({ id: v.id, profileId: v.deliveryProfile?.id ?? null })),
    };

    const { change } = planForProduct(product, profiles, todayInStore(), await countdownProductIds(shop));
    if (!change) return { status: "unchanged" };

    const job = newJob(source);
    await applyChanges(admin, shop, [change], source, job);
    if (job.errors.length) console.error(`[preorders] ${source.toLowerCase()}:`, job.errors.join(" | "));
    return { status: "updated", errors: job.errors };
  } finally {
    inFlight.delete(productId);
  }
}

// Just the template, for a product added to or taken out of the countdown
// group (works even when the GT shipping profiles aren't set up)
const TEMPLATE_QUERY = `#graphql
  query ProductTemplate($id: ID!) {
    product(id: $id) {
      id
      title
      status
      templateSuffix
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
    }
  }`;

export async function syncTemplate(shop, admin, productId, source = "Pre-order countdown") {
  const p = (await gql(admin, TEMPLATE_QUERY, { id: productId }))?.product;
  if (!p || p.status === "ARCHIVED") return { status: "missing" };
  const release = toDay(p.metafield?.value);
  const t = templatePlan({ release, templateSuffix: p.templateSuffix ?? "" }, todayInStore(), (await countdownProductIds(shop)).has(p.id));
  if (!t) return { status: "unchanged" };
  if (t.conflict) return { status: "otherTemplate", template: templateName(t.conflict) };
  const d = await gql(admin, TEMPLATE_SET, { product: { id: p.id, templateSuffix: t.to } });
  checkUserErrors(d.productUpdate, "Changing the template");
  await db.preorderLog.create({
    data: { shop, productId: p.id, title: p.title, action: source, detail: `Template: ${templateName(t.from)} → ${templateName(t.to)}`, release },
  });
  return { status: "updated", template: templateName(t.to) };
}

// Products on another custom template that should show the countdown: move
// them to the preorder template on request (one, a selection, or all listed)
export async function switchToPreorderTemplate(shop, admin, productIds, user = null) {
  const ids = [...new Set((productIds ?? []).map(String))].filter((id) => /^gid:\/\/shopify\/Product\/\d+$/.test(id));
  if (!ids.length) throw new Error("Select at least one product.");
  if (ids.length > 250) throw new Error("Switch up to 250 products at a time.");
  const switched = [];
  const failed = [];
  for (const id of ids) {
    try {
      const p = (await gql(admin, TEMPLATE_QUERY, { id }))?.product;
      if (!p) throw new Error("not found");
      if ((p.templateSuffix ?? "") === PREORDER_TEMPLATE) {
        switched.push(id);
        continue;
      }
      const d = await gql(admin, TEMPLATE_SET, { product: { id, templateSuffix: PREORDER_TEMPLATE } });
      checkUserErrors(d.productUpdate, "Changing the template");
      await db.preorderLog.create({
        data: {
          shop,
          productId: id,
          title: p.title,
          action: user?.name ? `Manual (${user.name})` : "Manual",
          detail: `Template: ${templateName(p.templateSuffix)} → ${templateName(PREORDER_TEMPLATE)}`,
          release: toDay(p.metafield?.value),
        },
      });
      switched.push(id);
    } catch (e) {
      failed.push({ id, error: errorMessage(e) });
    }
  }
  return { switched, failed };
}

// ---------------------------------------------------------------------------
// Quick view: product details and release date edits from the Pre-orders page
// ---------------------------------------------------------------------------

const DETAILS_QUERY = `#graphql
  query ($id: ID!) {
    product(id: $id) {
      id
      legacyResourceId
      title
      status
      tags
      templateSuffix
      onlineStoreUrl
      onlineStorePreviewUrl
      featuredMedia { preview { image { url(transform: { maxWidth: 200 }) } } }
      metafield(namespace: "${NAMESPACE}", key: "${KEY}") { type value }
      variants(first: 250) {
        nodes { id title deliveryProfile { id name } }
      }
    }
  }`;

export async function getProductDetails(admin, productId, shop = null) {
  const data = await gql(admin, DETAILS_QUERY, { id: productId });
  const p = data?.product;
  if (!p) return null;

  const profiles = await loadProfiles(admin);
  const release = toDay(p.metafield?.value);
  const today = todayInStore();
  const inCountdown = shop ? (await countdownProductIds(shop)).has(p.id) : false;
  const days = release ? daysUntil(today, release) : null;
  const tier = days === null ? null : tierFor(days);
  const expectedProfile = tier
    ? profiles.tiers.find((t) => t.tag === tier.tag)?.profile?.name ?? null
    : profiles.general?.name ?? null;

  return {
    id: p.id,
    legacyId: p.legacyResourceId,
    title: p.title,
    status: p.status,
    image: p.featuredMedia?.preview?.image?.url ?? null,
    tags: p.tags ?? [],
    gtTags: (p.tags ?? []).filter(isGtTag),
    release,
    releaseType: p.metafield?.type ?? null,
    days,
    expectedTag: release ? tier?.tag ?? null : undefined,
    expectedProfile: release ? expectedProfile : undefined,
    profiles: [...new Set(p.variants.nodes.map((v) => v.deliveryProfile?.name ?? "No profile"))],
    // Live page when it's on the online store; otherwise Shopify's preview link
    storeUrl: p.onlineStoreUrl ?? p.onlineStorePreviewUrl ?? null,
    storePreview: !p.onlineStoreUrl && Boolean(p.onlineStorePreviewUrl),
    template: templateName(p.templateSuffix),
    expectedTemplate: (() => {
      const t = templatePlan({ release, templateSuffix: p.templateSuffix ?? "" }, today, inCountdown);
      if (!t) return templateName(p.templateSuffix);
      return t.conflict ? `${templateName(t.conflict)} (its own template, left alone)` : templateName(t.to);
    })(),
  };
}

const METAFIELD_SET = `#graphql
  mutation ($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }`;

// Saves a new release date, logs it, then applies the tag/profile rules.
// `source` is shown in the activity log.
export async function setReleaseDate(admin, shop, productId, day, source = "Quick view") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Enter a date as YYYY-MM-DD.");

  const before = await getProductDetails(admin, productId, shop);
  if (!before) throw new Error("Product not found.");
  if (before.release === day) return { details: before, sync: { status: "unchanged" } };

  // Keep whatever type the metafield already uses
  const type = before.releaseType ?? "date";
  const value = type === "date_time" ? `${day}T12:00:00Z` : day;

  const d = await gql(admin, METAFIELD_SET, {
    metafields: [{ ownerId: productId, namespace: NAMESPACE, key: KEY, type, value }],
  });
  checkUserErrors(d.metafieldsSet, "Saving the release date");

  await db.preorderLog.create({
    data: {
      shop,
      productId,
      title: before.title,
      action: source,
      detail: `Release date: ${before.release ?? "none"} → ${day}`,
      release: day,
    },
  });

  const sync = await syncProduct(shop, productId, source);
  const details = await getProductDetails(admin, productId, shop);
  return { details, sync };
}

// ---------------------------------------------------------------------------
// Daily run: every morning at DAILY_HOUR, scan the catalog and apply changes.
// Checked every 15 minutes, so it also catches up if the app was restarting.
// ---------------------------------------------------------------------------

async function runDaily(shop) {
  const job = newJob("Daily run");
  job.step = "Scanning catalog";
  jobs.set(shop, job);

  let bulkId = null;
  try {
    const { admin } = await unauthenticated.admin(shop);
    bulkId = await startScan(admin);
    await waitForScan(admin, bulkId);
    await runApply(shop, bulkId, job);
  } catch (e) {
    job.state = "failed";
    job.step = "Stopped";
    job.errors.push(errorMessage(e));
    job.finishedAt = new Date().toISOString();
  }

  const summary =
    job.state === "failed"
      ? `Failed: ${job.errors[job.errors.length - 1]}`
      : `${job.retagged} retagged, ${job.moved} moved${job.errors.length ? `, ${job.errors.length} problems` : ""}`;

  await db.preorderState.update({
    where: { shop },
    data: {
      lastDailyAt: new Date(),
      lastDailySummary: summary,
      // A failed run is retried on the next check (15 minutes later)
      ...(job.state === "failed" ? { lastDailyRun: null } : {}),
    },
  });

  // Then check Google Books for release date changes, reusing the same scan
  // (loaded here rather than at the top, because books.server imports this file)
  if (job.state !== "failed" && bulkId) {
    const { runBooksCheck } = await import("./books.server");
    await runBooksCheck(shop, { bulkId, source: "Daily run" }).catch((e) =>
      console.error("[books] daily check:", errorMessage(e)),
    );
  }
}

async function dailyTick() {
  if (hourInStore() < DAILY_HOUR) return;
  const today = todayInStore();

  const sessions = await db.session.findMany({ where: { isOnline: false }, select: { shop: true } });
  for (const shop of new Set(sessions.map((s) => s.shop))) {
    if (isRunning(shop)) continue;
    const state = await db.preorderState.findUnique({ where: { shop } });
    if (state?.lastDailyRun === today) continue;

    // Claim today's run before starting, so it only happens once
    await db.preorderState.upsert({
      where: { shop },
      create: { shop, lastDailyRun: today },
      update: { lastDailyRun: today },
    });
    runDaily(shop).catch((e) => console.error("[preorders] daily run:", errorMessage(e)));
  }
}

export async function getDailyState(shop) {
  return db.preorderState.findUnique({ where: { shop } });
}

if (!globalThis.__preorderScheduler) {
  const tick = () => dailyTick().catch((e) => console.error("[preorders] scheduler:", errorMessage(e)));
  globalThis.__preorderScheduler = setInterval(tick, 15 * 60 * 1000);
  setTimeout(tick, 60 * 1000); // first check a minute after startup
}
