// Loaded before the app server starts (see "start" in package.json).
//
// Railway's proxy keeps idle connections to the app open and reuses them.
// Node closes an idle connection after 5 seconds by default, so the proxy
// sometimes sends a request down a connection Node has just closed: the
// request fails with "connection reset by peer" and the person sees a 502
// (only POSTs, such as Shipping actions and Shopify webhooks; Railway retries
// the others). Keeping idle connections open longer than Railway does stops
// that.
const http = require("node:http");

const KEEP_ALIVE_MS = 120_000;

const createServer = http.createServer;
http.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  // Must be longer than keepAliveTimeout, or Node can still drop the connection first
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;
  return server;
};
