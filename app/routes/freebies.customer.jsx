import { verifyCustomerToken } from "../packcam.server";
import { customerGifts } from "../freebies.server";

// The "Free gift" block in the customer's account asks here, with its customer
// session token: which free gifts came with this order of theirs?
// GET ?orderId=<id or GID>  →  { gifts: [{ title, description, imageUrl, quantity }] }

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
    return json({ gifts: await customerGifts(who, new URL(request.url).searchParams.get("orderId")) });
  } catch (e) {
    console.error("[freebies] customer:", e);
    return json({ error: "The free gift couldn't be loaded." }, 500);
  }
};

export const action = ({ request }) => (request.method === "OPTIONS" ? new Response(null, { status: 204, headers: CORS }) : json({ error: "Not found." }, 404));
