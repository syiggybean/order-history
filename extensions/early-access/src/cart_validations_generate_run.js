// @ts-check

// Early access (MonkeyBean sales). A product in an early-access sale carries
// oh_sales.early_access, which MonkeyBean changes as the sale goes on:
//   { phase: "locked",  tiers, opens }   nobody can buy it yet
//   { phase: "members", tags, tiers, opens }
//                                        only members whose tier is in `tags`
//                                        (their oh_loyalty.tier_tag metafield)
// When it opens to everyone MonkeyBean removes the metafield. Products without
// it pass.

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const tag = input.cart.buyerIdentity?.customer?.tierTag?.value ?? null;
  const seen = new Set();
  const errors = [];
  for (const line of input.cart.lines) {
    const m = line.merchandise;
    if (m.__typename !== "ProductVariant" || seen.has(m.product.id)) continue;
    seen.add(m.product.id);
    /** @type {any} */
    const ea = m.product.earlyAccess?.jsonValue;
    if (!ea || typeof ea !== "object") continue;
    if (ea.phase === "locked") {
      errors.push({ message: `${m.product.title} isn't available yet.${ea.opens ? ` It opens ${ea.opens}.` : ""}`, target: "$.cart" });
    } else if (ea.phase === "members" && !(tag && (ea.tags ?? []).includes(tag))) {
      const who = ea.tiers ? `${ea.tiers} members` : "members";
      errors.push({ message: `${m.product.title} is early access for ${who} right now. Sign in if you're one.${ea.opens ? ` It opens to everyone ${ea.opens}.` : ""}`, target: "$.cart" });
    }
  }
  return { operations: errors.length ? [{ validationAdd: { errors } }] : [] };
}
