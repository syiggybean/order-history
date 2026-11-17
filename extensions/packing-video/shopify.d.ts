import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/OrderStatusBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.customer-information.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/FreeGiftBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/customer-account.order-status.cart-line-list.render-after').Api;
  const globalThis: { shopify: typeof shopify };
}
