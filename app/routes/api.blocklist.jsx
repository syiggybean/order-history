import { can, getStaff } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { BlockError, customerBlockStatus, setBlock } from "../blocklist.server";

// For the "Block customer" window in a customer's More actions menu.
//   GET  ?check=1                        should the menu item show?
//   GET  ?customerId=gid://shopify/Customer/1
//   POST { customerId, customer: bool, addresses: { key: bool }, reason }
export const loader = async ({ request }) => {
  const { admin, session, user, cors } = await getStaff(request);
  const respond = (data, status = 200) => cors(Response.json(data, { status }));
  const url = new URL(request.url);
  if (url.searchParams.has("check")) return respond({ display: can(user, "blocklist", "view") });
  if (!can(user, "blocklist", "view")) return respond({ hidden: true });
  try {
    const status = await customerBlockStatus(session.shop, admin, url.searchParams.get("customerId"));
    return respond({ ...status, canManage: can(user, "blocklist", "manage") });
  } catch (e) {
    return respond({ error: e instanceof BlockError ? e.message : errorMessage(e) });
  }
};

export const action = async ({ request }) => {
  const { admin, session, user, cors } = await getStaff(request);
  const respond = (data, status = 200) => cors(Response.json(data, { status }));
  if (!can(user, "blocklist", "manage")) return respond({ error: "You don't have permission to block or unblock customers. Ask an admin of the app." });
  let body = {};
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Bad request." }, 400);
  }
  try {
    const status = await setBlock(
      session.shop,
      admin,
      body.customerId,
      { customer: Boolean(body.customer), addresses: body.addresses ?? {}, reason: body.reason },
      user,
    );
    return respond({ ok: true, ...status, canManage: true });
  } catch (e) {
    return respond({ error: e instanceof BlockError ? e.message : errorMessage(e) });
  }
};
