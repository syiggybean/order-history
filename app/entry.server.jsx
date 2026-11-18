import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

// Unexpected errors in any page's loader or action: logged with the page (no
// query string, which can hold sign-in tokens), so a 500 or 502 can be traced
export function handleError(error, { request }) {
  if (request.signal.aborted) return; // the person left the page
  let path = "";
  try {
    path = new URL(request.url).pathname;
  } catch {
    // keep going
  }
  console.error(`[error] ${request.method} ${path}:`, error?.stack ?? error);
}

// Anything that slips past every handler: logged instead of lost
if (!globalThis.__ohProcessLogging) {
  globalThis.__ohProcessLogging = true;
  process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason?.stack ?? reason));
}

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
