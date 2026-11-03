import { batchAllowed, batchLock, finishPicking, pickList, scanPick, setPicked } from "../batches.server";
import { CameraError, pickPhoneSession } from "../camera.server";
import { can } from "../permissions.server";
import { ShippingError } from "../shipping.server";

// Picking on a phone (POST, JSON). Every request carries the link's secret ("k");
// there's no Shopify sign-in on the phone, it acts as the person who made the link.
//   { k, intent: "state" }                  the pick list (polled)
//   { k, intent: "scan", code }             a barcode (camera or a Bluetooth scanner)
//   { k, intent: "set", key, qty }          a count set by hand
//   { k, intent: "finish", force }          done picking

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export const loader = () => json({ ok: false, error: "Not found." }, 404);

export const action = async ({ request }) => {
  if (!/application\/json/i.test(request.headers.get("content-type") ?? "")) return json({ ok: false, error: "Bad request." }, 415);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Bad request." }, 400);
  }
  try {
    const { shop, batchId, user } = await pickPhoneSession(String(body?.k ?? ""));
    // "Only their assigned batches"
    if (can(user, "shipping", "assignedOnly") && !user.isOwner && !user.isAdmin && !(await batchAllowed(shop, batchId, user.id)))
      return json({ ok: false, error: "That batch isn't assigned to you any more." }, 403);
    const lock = await batchLock(shop, batchId, user, { early: can(user, "shipping", "pickEarly") });
    if (body.intent === "state") {
      const list = await pickList(shop, batchId);
      if (!list) return json({ ok: false, error: "That batch couldn't be found.", expired: true }, 404);
      return json({ ok: true, userName: user.name, lock: lock?.pick ?? null, ...list });
    }
    if (lock?.pick) return json({ ok: false, error: lock.pick, locked: true });
    if (body.intent === "scan") return json(await scanPick(shop, batchId, String(body.code ?? "").slice(0, 200), user));
    if (body.intent === "set") return json({ ok: true, ...(await setPicked(shop, batchId, String(body.key ?? ""), body.qty)) });
    if (body.intent === "finish") return json(await finishPicking(shop, batchId, user, { force: Boolean(body.force) }));
    return json({ ok: false, error: "Unknown request." }, 400);
  } catch (e) {
    if (e instanceof CameraError) return json({ ok: false, error: e.message, expired: true }, 400);
    if (e instanceof ShippingError) return json({ ok: false, error: e.message });
    console.error("[pick-mobile]", e);
    return json({ ok: false, error: "Something went wrong. Try again." }, 500);
  }
};
