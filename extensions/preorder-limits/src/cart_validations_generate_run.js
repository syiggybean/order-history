// @ts-check

// Pre-order sales limits (MonkeyBean countdowns). A limited variant carries
// how many can still be pre-ordered (oh_preorder.limit_left) and its product
// whether pre-orders are open (oh_preorder.on_sale). Anything without them
// isn't limited and passes. Stock isn't involved: the app never changes it.

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  /** @type {Map<string, { qty: number, left: number, onSale: boolean, name: string }>} */
  const limited = new Map();
  for (const line of input.cart.lines) {
    const m = line.merchandise;
    if (m.__typename !== "ProductVariant" || m.limitLeft?.value == null) continue;
    const had = limited.get(m.id);
    if (had) {
      had.qty += line.quantity;
      continue;
    }
    const left = Math.max(0, parseInt(m.limitLeft.value, 10) || 0);
    const variant = m.title && m.title !== "Default Title" ? ` (${m.title})` : "";
    limited.set(m.id, { qty: line.quantity, left, onSale: m.product.onSale?.value === "true", name: `${m.product.title}${variant}` });
  }

  const errors = [];
  for (const x of limited.values()) {
    if (!x.onSale) errors.push({ message: `${x.name} isn't open for pre-order right now.`, target: "$.cart" });
    else if (x.left === 0) errors.push({ message: `${x.name} is sold out for pre-order.`, target: "$.cart" });
    else if (x.qty > x.left) errors.push({ message: `Only ${x.left} more of ${x.name} can be pre-ordered. Lower the quantity to continue.`, target: "$.cart" });
  }
  return { operations: errors.length ? [{ validationAdd: { errors } }] : [] };
}
