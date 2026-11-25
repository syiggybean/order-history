// @ts-check

// MonkeyBean sales. Each sale made in MonkeyBean is an automatic discount
// that runs this function; Shopify starts and stops it on the sale's times.
// The sale's settings are in the discount's "config" metafield:
//   kind         "items" (off chosen items) or "order" (off the order)
//   membersOnly  only loyalty members whose tier is in `tags` get it; a member's
//                tier comes from their oh_loyalty.tier_tag metafield, which
//                MonkeyBean keeps up to date (they have to be signed in)
//   valueType    "percentage" or "fixed" ($ off each item, or off the order)
//   scope        items: "all", "collections" (the discount's input variables
//                hold the collection ids) or "products" (productIds)
//   minSubtotal  order: the cart has to come to at least this much

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  /** @type {any} */
  const config = input.discount.config?.jsonValue;
  const lines = input.cart.lines;
  if (!config || !lines.length || !(Number(config.value) > 0)) return { operations: [] };

  if (config.membersOnly) {
    const tag = input.cart.buyerIdentity?.customer?.tierTag?.value;
    if (!tag || !(config.tags ?? []).includes(tag)) return { operations: [] };
  }

  const message = String(config.message ?? "Sale");
  const value = Number(config.value);
  const classes = input.discount.discountClasses;

  if (config.kind === "order") {
    if (!classes.includes("ORDER")) return { operations: [] };
    const subtotal = lines.reduce((sum, l) => sum + Number(l.cost.subtotalAmount.amount), 0);
    if (subtotal <= 0 || subtotal < Number(config.minSubtotal ?? 0)) return { operations: [] };
    return {
      operations: [
        {
          orderDiscountsAdd: {
            candidates: [
              {
                message,
                targets: [{ orderSubtotal: { excludedCartLineIds: [] } }],
                value: config.valueType === "fixed" ? { fixedAmount: { amount: Math.min(value, subtotal) } } : { percentage: { value: Math.min(value, 100) } },
              },
            ],
            selectionStrategy: "FIRST",
          },
        },
      ],
    };
  }

  if (!classes.includes("PRODUCT")) return { operations: [] };
  const productIds = config.productIds ?? [];
  const targets = [];
  for (const l of lines) {
    const m = l.merchandise;
    if (m.__typename !== "ProductVariant") continue;
    const ok = config.scope === "collections" ? m.product.inAnyCollection : config.scope === "products" ? productIds.includes(m.product.id) : true;
    if (ok) targets.push({ cartLine: { id: l.id } });
  }
  if (!targets.length) return { operations: [] };
  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates: [
            {
              message,
              targets,
              value: config.valueType === "fixed" ? { fixedAmount: { amount: value, appliesToEachItem: true } } : { percentage: { value: Math.min(value, 100) } },
            },
          ],
          selectionStrategy: "FIRST",
        },
      },
    ],
  };
}
