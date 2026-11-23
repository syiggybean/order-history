import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/HistoryBlock.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.block.render').Api;
  const globalThis: { shopify: typeof shopify };
}
