import db from "./db.server";
import { authenticate, unauthenticated } from "./shopify.server";
import { CAPABILITY_FEATURES, FEATURES, allows, emptyAccess, fullAccess } from "./permissions";

// ---------------------------------------------------------------------------
// Staff permissions
//
// Every staff member gets a level per feature (see permissions.js).
// Anyone not set up yet is Hidden everywhere.
// The store owner always has full access and can manage permissions.
// If nobody can manage permissions yet, the first person to open the app
// becomes a permissions admin, so the app can't lock everyone out.
// ---------------------------------------------------------------------------

const SEEN_UPDATE_MS = 5 * 60 * 1000;

function parseAccess(json) {
  const base = emptyAccess();
  try {
    const saved = json ? JSON.parse(json) : {};
    for (const f of Object.keys(FEATURES)) {
      if (FEATURES[f].levels.includes(saved[f])) base[f] = saved[f];
    }
    for (const [f, d] of Object.entries(CAPABILITY_FEATURES)) {
      if (Array.isArray(saved[f])) base[f] = saved[f].filter((c) => c in d.caps);
    }
  } catch {
    // fall back to Hidden everywhere
  }
  return base;
}

function identity(session, sessionToken) {
  const u = session?.onlineAccessInfo?.associated_user;
  const id = u?.id ?? session?.userId ?? sessionToken?.sub ?? null;
  if (!id) return null;
  const name = [u?.first_name ?? session?.firstName, u?.last_name ?? session?.lastName].filter(Boolean).join(" ");
  return {
    userId: String(id),
    name: name || null,
    email: (u?.email ?? session?.email ?? null)?.toLowerCase() ?? null,
    accountOwner: Boolean(u?.account_owner ?? session?.accountOwner),
  };
}

// Records the person and works out what they can do
async function resolveUser(shop, who) {
  let member = await db.staffMember.findUnique({ where: { shop_userId: { shop, userId: who.userId } } });

  if (!member) {
    // Access set up ahead of time by email
    const invite = who.email
      ? await db.staffInvite.findUnique({ where: { shop_email: { shop, email: who.email } } })
      : null;
    // Nobody can manage permissions yet: this person becomes the first admin
    const anyAdmin = await db.staffMember.count({ where: { shop, isAdmin: true } });
    const bootstrap = !anyAdmin && !who.accountOwner;

    member = await db.staffMember.create({
      data: {
        shop,
        userId: who.userId,
        name: who.name,
        email: who.email,
        accountOwner: who.accountOwner,
        isAdmin: who.accountOwner || bootstrap || Boolean(invite?.isAdmin),
        access: bootstrap ? JSON.stringify(fullAccess()) : invite?.access ?? JSON.stringify(emptyAccess()),
        lastSeenAt: new Date(),
      },
    });
    if (invite) await db.staffInvite.delete({ where: { id: invite.id } });
  } else if (
    Date.now() - member.lastSeenAt.getTime() > SEEN_UPDATE_MS ||
    member.name !== who.name ||
    member.email !== who.email ||
    member.accountOwner !== who.accountOwner
  ) {
    member = await db.staffMember.update({
      where: { id: member.id },
      data: { lastSeenAt: new Date(), name: who.name ?? member.name, email: who.email ?? member.email, accountOwner: who.accountOwner },
    });
  }

  const owner = member.accountOwner;
  return {
    id: member.id,
    userId: member.userId,
    name: member.name ?? member.email ?? "Staff member",
    email: member.email,
    isOwner: owner,
    isAdmin: owner || member.isAdmin,
    access: owner ? fullAccess() : parseAccess(member.access),
  };
}

export const can = (user, feature, level) => Boolean(user) && allows(user, feature, level);

// authenticate.admin + who's asking. Pass on to pages for nav and buttons.
//
// Store actions use the app's own access (as before online sessions were
// turned on), so a person's Shopify staff permissions don't change how the
// app's features behave; the levels on the Permissions page decide instead.
export async function getStaff(request) {
  const ctx = await authenticate.admin(request);
  const who = identity(ctx.session, ctx.sessionToken);
  // No staff identity (shouldn't happen in Shopify admin): treat as no access
  const user = who ? await resolveUser(ctx.session.shop, who) : null;
  const { admin } = await unauthenticated.admin(ctx.session.shop);
  return { ...ctx, admin, user };
}

// What the browser needs to show or hide things
export const publicUser = (user) =>
  user ? { name: user.name, isAdmin: user.isAdmin, isOwner: user.isOwner, access: user.access } : null;

// For loaders: returns ctx, or ctx with noAccess set (render <NoAccess />)
export async function loadWithAccess(request, feature, level = "view") {
  const ctx = await getStaff(request);
  return { ...ctx, noAccess: !can(ctx.user, feature, level) };
}

// For actions: the refusal message to return when someone lacks access
export const denied = (feature, level) => ({
  error: CAPABILITY_FEATURES[feature]
    ? `You don't have permission to do this. Ask an admin to turn on "${CAPABILITY_FEATURES[feature].caps[level] ?? level}" under ${CAPABILITY_FEATURES[feature].label}.`
    : `You don't have permission to do this. Ask an admin for "${FEATURES[feature].levelLabels[level]}" access to ${FEATURES[feature].label}.`,
  denied: true,
});

// ---------------------------------------------------------------------------
// Managing permissions (admins only)
// ---------------------------------------------------------------------------

export async function listStaff(shop) {
  const [members, invites] = await Promise.all([
    db.staffMember.findMany({ where: { shop }, orderBy: [{ accountOwner: "desc" }, { lastSeenAt: "desc" }] }),
    db.staffInvite.findMany({ where: { shop }, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      isOwner: m.accountOwner,
      isAdmin: m.accountOwner || m.isAdmin,
      access: m.accountOwner ? fullAccess() : parseAccess(m.access),
      lastSeenAt: m.lastSeenAt.toISOString(),
    })),
    invites: invites.map((i) => ({ id: i.id, email: i.email, isAdmin: i.isAdmin, access: parseAccess(i.access) })),
  };
}

function cleanAccess(input) {
  const out = emptyAccess();
  for (const f of Object.keys(FEATURES)) if (FEATURES[f].levels.includes(input?.[f])) out[f] = input[f];
  for (const [f, d] of Object.entries(CAPABILITY_FEATURES)) {
    if (Array.isArray(input?.[f])) out[f] = [...new Set(input[f].filter((c) => c in d.caps))];
  }
  return out;
}

export async function saveMember(shop, actor, memberId, { access, isAdmin }) {
  const member = await db.staffMember.findFirst({ where: { shop, id: memberId } });
  if (!member) throw new Error("Staff member not found.");
  if (member.accountOwner) throw new Error("The store owner always has full access.");
  if (member.id === actor.id && !isAdmin) throw new Error("You can't remove your own admin access.");
  return db.staffMember.update({
    where: { id: member.id },
    data: { access: JSON.stringify(cleanAccess(access)), isAdmin: Boolean(isAdmin) },
  });
}

export async function saveInvite(shop, { email, access, isAdmin }) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("Enter a valid email address.");
  const data = { access: JSON.stringify(cleanAccess(access)), isAdmin: Boolean(isAdmin) };

  // Already uses the app: update them directly
  const member = await db.staffMember.findFirst({ where: { shop, email: e } });
  if (member) {
    if (member.accountOwner) throw new Error("The store owner always has full access.");
    await db.staffMember.update({ where: { id: member.id }, data });
    return { updatedExisting: true };
  }
  await db.staffInvite.upsert({
    where: { shop_email: { shop, email: e } },
    create: { shop, email: e, ...data },
    update: data,
  });
  return { updatedExisting: false };
}

export async function removeInvite(shop, id) {
  await db.staffInvite.deleteMany({ where: { shop, id } });
}
