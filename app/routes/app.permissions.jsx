import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getStaff, listStaff, removeInvite, saveInvite, saveMember } from "../permissions.server";
import { CAPABILITY_FEATURES, FEATURES, emptyAccess } from "../permissions";
import { NoAccess } from "../components/NoAccess";

export const loader = async ({ request }) => {
  const { session, user } = await getStaff(request);
  if (!user?.isAdmin) return { noAccess: true };
  return { me: user.id, ...(await listStaff(session.shop)) };
};

export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  if (!user?.isAdmin) return { error: "Only app admins can change permissions." };
  const form = await request.formData();
  const intent = form.get("intent");
  const access = JSON.parse(String(form.get("access") ?? "{}"));
  const isAdmin = form.get("isAdmin") === "true";

  try {
    if (intent === "saveMember") {
      await saveMember(session.shop, user, Number(form.get("id")), { access, isAdmin });
      return { ok: true, intent, id: Number(form.get("id")) };
    }
    if (intent === "saveInvite") {
      const r = await saveInvite(session.shop, { email: form.get("email"), access, isAdmin });
      return { ok: true, intent, ...r };
    }
    if (intent === "removeInvite") {
      await removeInvite(session.shop, Number(form.get("id")));
      return { ok: true, intent };
    }
  } catch (e) {
    return { intent, error: e?.message ?? String(e) };
  }
  return { error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const muted = { color: "#616161" };
const small = { fontSize: "12px", color: "#616161" };
const inputStyle = { font: "inherit", padding: "6px 8px", borderRadius: "8px", border: "1px solid #c9c9c9", background: "#fff" };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", fontSize: "13px", color: "#005bd3", cursor: "pointer" };

// Every feature, A–Z (like the app's menu)
const ALL = [
  ...Object.entries(FEATURES).map(([key, f]) => ({ key, label: f.label, kind: "level" })),
  ...Object.entries(CAPABILITY_FEATURES).map(([key, f]) => ({ key, label: f.label, kind: "caps" })),
].sort((a, b) => a.label.localeCompare(b.label));

// "View + undo" → "Undo"
const levelName = (feature, level) => {
  const t = FEATURES[feature].levelLabels[level];
  if (level === "view") return t;
  const s = t.replace(/^View \+ /, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// What someone can do in a feature, in a few words (null = nothing)
function featureSummary(key, kind, value) {
  if (kind === "level") {
    if (!value || value === "hidden") return null;
    return levelName(key, value);
  }
  const all = Object.keys(CAPABILITY_FEATURES[key].caps);
  const on = all.filter((c) => value?.includes(c));
  if (!on.length) return null;
  if (on.length === all.length) return "Everything";
  const short = { view: "View", batches: "Batches", pick: "Pick", pack: "Pack", ship: "Ship", override: "Override", shipOutside: "Outside batch", review: "Flag/Review", assignedOnly: "Assigned only", settings: "Settings", generate: "Create/edit", email: "Email", export: "Export", importLinnworks: "Linnworks import" };
  return on.map((c) => short[c] ?? c).join(", ");
}

function Summary({ access, isAdmin }) {
  const parts = ALL.map((f) => ({ ...f, text: featureSummary(f.key, f.kind, access[f.key]) })).filter((f) => f.text);
  if (!parts.length && !isAdmin) return <span style={small}>No access</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
      {isAdmin && <Chip strong>Admin</Chip>}
      {parts.map((f) => (
        <Chip key={f.key}>
          {f.label}
          {f.text !== "View" ? `: ${f.text}` : ""}
        </Chip>
      ))}
    </span>
  );
}
function Chip({ children, strong = false }) {
  return (
    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: "999px", fontSize: "12px", background: strong ? "#303030" : "#f1f1f1", color: strong ? "#fff" : "#303030", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

// One feature's checkboxes. Levels build on each other (ticking "Manage" ticks "View";
// unticking "View" clears the feature). Shipping and Purchase orders have separate switches.
function FeatureBoxes({ f, value, onChange, disabled }) {
  if (f.kind === "level") {
    const levels = FEATURES[f.key].levels;
    const rank = Math.max(0, levels.indexOf(value));
    return levels.slice(1).map((l, i) => {
      const r = i + 1;
      return (
        <label key={l} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <input type="checkbox" checked={rank >= r} disabled={disabled} onChange={(e) => onChange(e.target.checked ? l : levels[r - 1])} aria-label={`${f.label}: ${levelName(f.key, l)}`} />
          {levelName(f.key, l)}
        </label>
      );
    });
  }
  const caps = Array.isArray(value) ? value : [];
  const toggle = (c, on) => {
    let next = on ? [...caps, c] : caps.filter((x) => x !== c);
    if (on && c !== "view" && !next.includes("view")) next = ["view", ...next];
    if (!on && c === "view") next = [];
    onChange([...new Set(next)]);
  };
  return Object.entries(CAPABILITY_FEATURES[f.key].caps).map(([c, label]) => (
    <label key={c} style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
      <input type="checkbox" checked={caps.includes(c)} disabled={disabled} onChange={(e) => toggle(c, e.target.checked)} aria-label={`${f.label}: ${label}`} style={{ marginTop: "3px" }} />
      {label}
    </label>
  ));
}

const everything = () => ({
  ...Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, f.levels[f.levels.length - 1]])),
  ...Object.fromEntries(Object.entries(CAPABILITY_FEATURES).map(([k, f]) => [k, Object.keys(f.caps).filter((c) => c !== "assignedOnly")])),
});

function AccessEditor({ access, onChange, isAdmin, onAdmin, adminLocked, disabled }) {
  return (
    <div>
      {!disabled && (
        <div style={{ display: "flex", gap: "12px", marginBottom: "8px", fontSize: "13px" }}>
          <span style={small}>Quick set:</span>
          <button type="button" style={linkBtn} onClick={() => onChange(everything())}>
            Everything
          </button>
          <button type="button" style={linkBtn} onClick={() => onChange(emptyAccess())}>
            Nothing
          </button>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "8px", alignItems: "start" }}>
        {ALL.map((f) => {
          const on = Boolean(featureSummary(f.key, f.kind, access[f.key]));
          return (
            <fieldset key={f.key} style={{ margin: 0, border: `1px solid ${on ? "#b9d2f5" : "#e3e3e3"}`, background: on ? "#f7faff" : "#fff", borderRadius: "10px", padding: "8px 10px", display: "grid", gap: "4px", alignContent: "start", fontSize: "13px" }}>
              <legend style={{ fontWeight: 600, padding: "0 4px" }}>{f.label}</legend>
              <FeatureBoxes f={f} value={access[f.key]} disabled={disabled} onChange={(v) => onChange({ ...access, [f.key]: v })} />
            </fieldset>
          );
        })}
        <fieldset style={{ margin: 0, border: `1px solid ${isAdmin ? "#303030" : "#e3e3e3"}`, borderRadius: "10px", padding: "8px 10px", display: "grid", gap: "4px", alignContent: "start", fontSize: "13px" }}>
          <legend style={{ fontWeight: 600, padding: "0 4px" }}>Admin</legend>
          <label style={{ display: "flex", gap: "6px", alignItems: "flex-start" }}>
            <input type="checkbox" checked={isAdmin} disabled={disabled || adminLocked} onChange={(e) => onAdmin(e.target.checked)} aria-label="Can manage permissions" style={{ marginTop: "3px" }} />
            Can manage permissions
          </label>
          {adminLocked && !disabled && <span style={small}>You can't remove your own admin access.</span>}
        </fieldset>
      </div>
    </div>
  );
}

// One person: summary line; Edit opens their checkboxes
function Person({ title, subtitle, access: saved, isAdmin: savedAdmin, locked, isMe, onSave, saving, result, onRemove, open, onToggle }) {
  const [access, setAccess] = useState(saved);
  const [isAdmin, setIsAdmin] = useState(savedAdmin);
  useEffect(() => {
    setAccess(saved);
    setIsAdmin(savedAdmin);
  }, [saved, savedAdmin]);
  const dirty = JSON.stringify(access) !== JSON.stringify(saved) || isAdmin !== savedAdmin;
  return (
    <div style={{ borderBottom: "1px solid #ebebeb", padding: "10px 4px" }}>
      <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: "200px", flex: "0 0 220px" }}>
          <strong>{title}</strong>
          {subtitle}
        </div>
        <div style={{ flex: 1, minWidth: "240px", paddingTop: "2px" }}>
          <Summary access={open ? access : saved} isAdmin={open ? isAdmin : savedAdmin} />
        </div>
        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          {locked ? (
            <span style={small}>Full access, always</span>
          ) : (
            <s-button variant={open ? "tertiary" : "secondary"} onClick={onToggle}>
              {open ? "Close" : "Edit"}
            </s-button>
          )}
          {onRemove && (
            <s-button variant="tertiary" tone="critical" onClick={onRemove}>
              Remove
            </s-button>
          )}
        </div>
      </div>
      {open && !locked && (
        <div style={{ marginTop: "10px" }}>
          <AccessEditor access={access} onChange={setAccess} isAdmin={isAdmin} onAdmin={setIsAdmin} adminLocked={isMe} />
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "10px" }}>
            <s-button variant="primary" onClick={() => onSave(access, isAdmin)} {...(saving ? { loading: true } : {})} {...(!dirty ? { disabled: true } : {})}>
              Save
            </s-button>
            {dirty && (
              <s-button
                variant="tertiary"
                onClick={() => {
                  setAccess(saved);
                  setIsAdmin(savedAdmin);
                }}
              >
                Undo changes
              </s-button>
            )}
            {result?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{result.error}</span>}
            {result?.ok && !dirty && !saving && <span style={{ color: "#1a5e20", fontSize: "13px" }}>Saved</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function MemberRow({ m, me, open, onToggle }) {
  const fetcher = useFetcher();
  return (
    <Person
      title={m.name ?? m.email ?? "Staff member"}
      subtitle={
        <>
          {(m.isOwner || m.id === me) && <span style={{ ...small, marginLeft: "6px" }}>{[m.isOwner && "Store owner", m.id === me && "You"].filter(Boolean).join(" · ")}</span>}
          {m.email && m.name && <div style={small}>{m.email}</div>}
          <div style={small}>Last seen {new Date(m.lastSeenAt).toLocaleDateString()}</div>
        </>
      }
      access={m.access}
      isAdmin={m.isAdmin}
      locked={m.isOwner}
      isMe={m.id === me}
      open={open}
      onToggle={onToggle}
      saving={fetcher.state !== "idle"}
      result={fetcher.state === "idle" ? fetcher.data : null}
      onSave={(access, isAdmin) => fetcher.submit({ intent: "saveMember", id: String(m.id), access: JSON.stringify(access), isAdmin: String(isAdmin) }, { method: "post" })}
    />
  );
}

function InviteRow({ inv, open, onToggle }) {
  const fetcher = useFetcher();
  const remover = useFetcher();
  if (remover.state !== "idle" || remover.data?.ok) return null;
  return (
    <Person
      title={inv.email}
      subtitle={<div style={small}>Hasn't opened the app yet</div>}
      access={inv.access}
      isAdmin={inv.isAdmin}
      open={open}
      onToggle={onToggle}
      saving={fetcher.state !== "idle"}
      result={fetcher.state === "idle" ? fetcher.data : null}
      onSave={(access, isAdmin) => fetcher.submit({ intent: "saveInvite", email: inv.email, access: JSON.stringify(access), isAdmin: String(isAdmin) }, { method: "post" })}
      onRemove={() => remover.submit({ intent: "removeInvite", id: String(inv.id) }, { method: "post" })}
    />
  );
}

function InviteForm() {
  const fetcher = useFetcher();
  const [email, setEmail] = useState("");
  const [access, setAccess] = useState(emptyAccess());
  const [isAdmin, setIsAdmin] = useState(false);
  const d = fetcher.data;
  useEffect(() => {
    if (d?.ok && d.intent === "saveInvite") {
      setEmail("");
      setAccess(emptyAccess());
      setIsAdmin(false);
    }
  }, [d]);
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      <label style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <span style={muted}>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@yiggybean.com" aria-label="Email" style={{ ...inputStyle, minWidth: "260px" }} />
      </label>
      <AccessEditor access={access} onChange={setAccess} isAdmin={isAdmin} onAdmin={setIsAdmin} />
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <s-button
          variant="primary"
          onClick={() => fetcher.submit({ intent: "saveInvite", email, access: JSON.stringify(access), isAdmin: String(isAdmin) }, { method: "post" })}
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
          {...(!email.trim() ? { disabled: true } : {})}
        >
          Add
        </s-button>
        {d?.error && d.intent === "saveInvite" && <span style={{ color: "#b42318" }}>{d.error}</span>}
        {d?.ok && d.intent === "saveInvite" && (
          <span style={{ color: "#1a5e20" }}>{d.updatedExisting ? "This person already uses the app; their access was updated." : "Added. Their access applies the first time they open the app."}</span>
        )}
      </div>
    </div>
  );
}

export default function Permissions() {
  const data = useLoaderData();
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState("");
  if (data.noAccess) return <NoAccess feature="Permissions" />;
  const { members, invites, me } = data;
  const match = (...t) => !q.trim() || t.some((x) => String(x ?? "").toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (key) => setOpen(open === key ? null : key);

  return (
    <s-page heading="Permissions">
      <s-section>
        <s-paragraph>
          Choose what each person can see and do. Anyone you haven't set up sees nothing from this app. People appear here after they first open the app or
          view a page it adds to Shopify admin. To give access before then, add them by email below.
        </s-paragraph>
        <s-paragraph>
          <span style={muted}>
            Choose <strong>Edit</strong> next to someone and tick what they can do. Ticking a higher level (like <strong>Manage</strong>) also ticks{" "}
            <strong>View</strong>; unticking View turns that feature off. <strong>Admins</strong> can change these permissions. The store owner always has full
            access.
          </span>
        </s-paragraph>
      </s-section>

      <s-section heading={`Staff (${members.length + invites.length})`}>
        {members.length + invites.length > 6 && (
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find someone" aria-label="Find someone" style={{ ...inputStyle, width: "260px", marginBottom: "6px" }} />
        )}
        <div>
          {members
            .filter((m) => match(m.name, m.email))
            .map((m) => (
              <MemberRow key={m.id} m={m} me={me} open={open === `m${m.id}`} onToggle={() => toggle(`m${m.id}`)} />
            ))}
          {invites
            .filter((inv) => match(inv.email))
            .map((inv) => (
              <InviteRow key={`i${inv.id}`} inv={inv} open={open === `i${inv.id}`} onToggle={() => toggle(`i${inv.id}`)} />
            ))}
        </div>
      </s-section>

      <s-section heading="Add someone by email">
        <s-paragraph>
          <span style={muted}>Use the email they sign in to Shopify with.</span>
        </s-paragraph>
        <InviteForm />
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
