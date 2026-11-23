import { can, getStaff } from "../permissions.server";
import { NoteError, addNote, deleteNote, editNote, listNotes } from "../product-notes.server";

// Internal notes card on product pages in Shopify admin.
//   GET ?productId=gid://shopify/Product/1        the notes
//   POST { intent: "add", productId, body } | { intent: "edit", id, body } | { intent: "delete", id }
// Any staff member can read them; anyone with Stock access can write them.

export const loader = async ({ request }) => {
  const { session, user, cors } = await getStaff(request);
  const respond = (data) => cors(Response.json(data));
  if (!user) return respond({ hidden: true });
  try {
    const productId = new URL(request.url).searchParams.get("productId");
    return respond({ notes: await listNotes(session.shop, productId, user), canWrite: can(user, "stock", "view") });
  } catch (e) {
    if (e instanceof NoteError) return respond({ error: e.message });
    console.error("[product-notes]", e);
    return respond({ error: "Something went wrong. Please try again." });
  }
};

export const action = async ({ request }) => {
  const { session, user, cors } = await getStaff(request);
  const respond = (data, status = 200) => cors(Response.json(data, { status }));
  if (!can(user, "stock", "view")) return respond({ error: "You need Stock access to write product notes. Ask an admin." }, 403);
  let body;
  try {
    body = await request.json();
  } catch {
    return respond({ error: "Bad request." }, 400);
  }
  try {
    if (body?.intent === "add") return respond({ note: await addNote(session.shop, body.productId, body.body, user) });
    if (body?.intent === "edit") return respond({ note: await editNote(session.shop, body.id, body.body, user) });
    if (body?.intent === "delete") {
      await deleteNote(session.shop, body.id, user);
      return respond({ deleted: true });
    }
  } catch (e) {
    if (e instanceof NoteError) return respond({ error: e.message });
    console.error("[product-notes]", e);
    return respond({ error: "Something went wrong. Please try again." }, 500);
  }
  return respond({ error: "Unknown request." }, 400);
};
