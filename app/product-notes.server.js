// Internal notes on products: what staff should know about an item (fragile,
// ships separately, supplier quirks…). Shown on the product's page in Shopify
// admin. Needs the Product notes permission (read, or read + write); authors and
// admins can edit or delete a note.
import db from "./db.server";

export class NoteError extends Error {}

const MAX = 2000;
const validProduct = (id) => /^gid:\/\/shopify\/Product\/\d+$/.test(String(id ?? ""));
const mine = (n, user) => Boolean(user) && (user.isAdmin || user.isOwner || (n.createdById != null && n.createdById === user.id) || (n.createdById == null && n.createdBy === user.name));

const view = (n, user) => ({
  id: n.id,
  body: n.body,
  by: n.createdBy,
  at: n.createdAt.toISOString(),
  editedBy: n.editedBy,
  editedAt: n.editedAt?.toISOString() ?? null,
  canChange: mine(n, user),
});

export async function listNotes(shop, productId, user) {
  if (!validProduct(productId)) throw new NoteError("Which product?");
  const notes = await db.productNote.findMany({ where: { shop, productId }, orderBy: { id: "desc" } });
  return notes.map((n) => view(n, user));
}

const clean = (body) => {
  const t = String(body ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) throw new NoteError("Write the note first.");
  if (t.length > MAX) throw new NoteError(`Notes can be up to ${MAX} characters.`);
  return t;
};

export async function addNote(shop, productId, body, user) {
  if (!validProduct(productId)) throw new NoteError("Which product?");
  const n = await db.productNote.create({ data: { shop, productId, body: clean(body), createdBy: user?.name ?? null, createdById: user?.id ?? null } });
  return view(n, user);
}

async function ownNote(shop, id, user) {
  const n = await db.productNote.findFirst({ where: { shop, id: Number(id) } });
  if (!n) throw new NoteError("That note isn't there anymore.");
  if (!mine(n, user)) throw new NoteError("Only the person who wrote a note, or an admin, can change it.");
  return n;
}

export async function editNote(shop, id, body, user) {
  const n = await ownNote(shop, id, user);
  const saved = await db.productNote.update({ where: { id: n.id }, data: { body: clean(body), editedAt: new Date(), editedBy: user?.name ?? null } });
  return view(saved, user);
}

export async function deleteNote(shop, id, user) {
  const n = await ownNote(shop, id, user);
  await db.productNote.delete({ where: { id: n.id } });
}
