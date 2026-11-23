import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ReshipAction.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/condition/shouldRender.js' {
  const shopify: import('@shopify/ui-extensions/admin.order-details.action.should-render').Api;
  const globalThis: { shopify: typeof shopify };
}
