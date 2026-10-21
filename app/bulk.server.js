import { errorMessage, gql } from "./preorders.server";

// ---------------------------------------------------------------------------
// Shopify bulk queries: read thousands of records in one go (no per-request
// cost limit). Returns the parsed JSONL lines; nested connection rows carry
// __parentId. If another bulk query is already running for the app, waits
// for it and tries again.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = `#graphql
  mutation BulkRun($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

const STATUS = `#graphql
  query BulkStatus($id: ID!) {
    node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } }
  }`;

export async function runBulkQuery(admin, query, { label = "Bulk read", timeoutMs = 30 * 60 * 1000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  let id = null;
  for (;;) {
    const data = await gql(admin, RUN, { query });
    const r = data.bulkOperationRunQuery;
    const err = r?.userErrors?.[0]?.message;
    if (!err && r?.bulkOperation?.id) {
      id = r.bulkOperation.id;
      break;
    }
    // Another bulk query (e.g. the pre-order scan) is running: wait our turn
    if (err && /already in progress|in progress/i.test(err) && Date.now() < deadline) {
      onProgress?.("Waiting for another Shopify scan to finish");
      await sleep(10_000);
      continue;
    }
    throw new Error(`${label}: ${err ?? "Shopify didn't start it"}`);
  }
  for (;;) {
    await sleep(process.env.NODE_ENV === "test" ? 10 : 4000);
    const op = (await gql(admin, STATUS, { id }))?.node;
    if (op?.status === "COMPLETED") {
      onProgress?.(`Downloading ${Number(op.objectCount ?? 0).toLocaleString()} records`);
      return op.url ? download(op.url) : [];
    }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op?.status)) throw new Error(`${label} ${String(op.status).toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}`);
    if (op?.objectCount) onProgress?.(`Reading from Shopify: ${Number(op.objectCount).toLocaleString()} records so far`);
    if (Date.now() > deadline) throw new Error(`${label} took longer than ${Math.round(timeoutMs / 60000)} minutes`);
  }
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download Shopify's results (${res.status})`);
  const text = await res.text();
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`Shopify's results couldn't be read: ${errorMessage(e)}`);
    }
  }
  return out;
}
