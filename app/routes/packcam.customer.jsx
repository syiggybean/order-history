import { appUrl } from "../print.server";
import { customerClip, verifyCustomerToken } from "../packcam.server";

// The "Your packing video" block in the customer's account asks here, with its
// customer session token: is there a clip of this order for this customer?
// GET ?orderId=<id or GID>  →  { clip: null | { orderName, expiresAt, watchUrl } }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
};
const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const who = verifyCustomerToken(token);
  if (!who) return json({ error: "Sign in to your account to see this." }, 401);
  try {
    return json({ clip: await customerClip(who, new URL(request.url).searchParams.get("orderId"), appUrl(request)) });
  } catch (e) {
    console.error("[packcam] customer:", e);
    return json({ error: "The packing video couldn't be loaded." }, 500);
  }
};

// Preflight (some clients send it as OPTIONS to the action)
export const action = ({ request }) => (request.method === "OPTIONS" ? new Response(null, { status: 204, headers: CORS }) : json({ error: "Not found." }, 404));
