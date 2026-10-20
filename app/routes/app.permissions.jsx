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

const cell = { padding: "10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "middle" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap" };
const muted = { color: "#616161" };
const select = { font: "inherit", padding: "4px 6px", borderRadius: "8px", border: "1px solid #c9c9c9", background: "#fff" };
const FEATURE_KEYS = Object.keys(FEATURES);
const CAP_KEYS = Object.keys(CAPABILITY_FEATURES);

// Short summary of switched-on capabilities, e.g. "Pick, Pack" or "Everything"
function capSummary(feature, caps) {
  const all = Object.keys(CAPABILITY_FEATURES[feature].caps);
  const on = all.filter((c) => caps?.includes(c));
  if (on.length === 0) return "Hidden";
  if (on.length === all.length) return "Everything";
  const short = { view: "View", batches: "Batches", pick: "Pick", pack: "Pack", ship: "Ship", override: "Override", shipOutside: "Outside batch", review: "Flag/Review", assignedOnly: "Assigned only", settings: "Settings" };
  return on.map((c) => short[c] ?? c).join(", ");
}

// A list of switches for a feature like Shipping
function CapChecklist({ feature, value, onChange, disabled }) {
  const f = CAPABILITY_FEATURES[feature];
  const caps = Array.isArray(value) ? value : [];
  const toggle = (c, on) => {
    let next = on ? [...caps, c] : caps.filter((x) => x !== c);
    // Any other switch needs View; turning View off turns everything off
    if (on && c !== "view" && !next.includes("view")) next = ["view", ...next];
    if (!on && c === "view") next = [];
    onChange([...new Set(next)]);
  };
  return (
    <details>
      <summary style={{ cursor: disabled ? "default" : "pointer", whiteSpace: "nowrap", ...(caps.length ? {} : { color: "#8a8a8a" }) }}>
        {capSummary(feature, caps)}
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "6px", minWidth: "220px" }}>
        {Object.entries(f.caps).map(([c, label]) => (
          <label key={c} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <input type="checkbox" checked={caps.includes(c)} disabled={disabled} onChange={(e) => toggle(c, e.target.checked)} />
            {label}
          </label>
        ))}
      </div>
    </details>
  );
}

function LevelSelect({ feature, value, onChange, disabled }) {
  const f = FEATURES[feature];
  return (
    <select
      aria-label={f.label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...select, ...(value === "hidden" ? { color: "#8a8a8a" } : {}) }}
    >
      {f.levels.map((l) => (
        <option key={l} value={l}>
          {f.levelLabels[l]}
        </option>
      ))}
    </select>
  );
}

function MemberRow({ m, me }) {
  const fetcher = useFetcher();
  const [access, setAccess] = useState(m.access);
  const [isAdmin, setIsAdmin] = useState(m.isAdmin);
  useEffect(() => {
    setAccess(m.access);
    setIsAdmin(m.isAdmin);
  }, [m.access, m.isAdmin]);

  const dirty = JSON.stringify(access) !== JSON.stringify(m.access) || isAdmin !== m.isAdmin;
  const saving = fetcher.state !== "idle";
  const locked = m.isOwner;

  return (
    <tr>
      <td style={cell}>
        <strong>{m.name ?? m.email ?? "Staff member"}</strong>
        {m.isOwner && <span style={{ ...muted, marginLeft: "6px" }}>· Store owner</span>}
        {m.id === me && <span style={{ ...muted, marginLeft: "6px" }}>· You</span>}
        {m.email && m.name && <div style={{ ...muted, fontSize: "12px" }}>{m.email}</div>}
        <div style={{ ...muted, fontSize: "12px" }}>Last seen {new Date(m.lastSeenAt).toLocaleDateString()}</div>
      </td>
      {FEATURE_KEYS.map((f) => (
        <td key={f} style={cell}>
          <LevelSelect feature={f} value={access[f]} disabled={locked} onChange={(v) => setAccess({ ...access, [f]: v })} />
        </td>
      ))}
      {CAP_KEYS.map((f) => (
        <td key={f} style={{ ...cell, verticalAlign: "top" }}>
          <CapChecklist feature={f} value={access[f]} disabled={locked} onChange={(v) => setAccess({ ...access, [f]: v })} />
        </td>
      ))}
      <td style={{ ...cell, textAlign: "center" }}>
        <input
          type="checkbox"
          aria-label="Can manage permissions"
          checked={isAdmin}
          disabled={locked || m.id === me}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        {!locked && (
          <s-button
            variant={dirty ? "primary" : "secondary"}
            onClick={() =>
              fetcher.submit(
                { intent: "saveMember", id: String(m.id), access: JSON.stringify(access), isAdmin: String(isAdmin) },
                { method: "post" },
              )
            }
            {...(saving ? { loading: true } : {})}
            {...(!dirty ? { disabled: true } : {})}
          >
            Save
          </s-button>
        )}
        {fetcher.data?.error && <div style={{ color: "#b42318", fontSize: "12px", marginTop: "4px" }}>{fetcher.data.error}</div>}
        {fetcher.data?.ok && !dirty && fetcher.state === "idle" && (
          <div style={{ color: "#1a5e20", fontSize: "12px", marginTop: "4px" }}>Saved</div>
        )}
      </td>
    </tr>
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
    <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", flexWrap: "wrap" }}>
      <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <span style={muted}>Email</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@yiggybean.com"
          style={{ ...select, minWidth: "220px", padding: "6px 8px" }}
        />
      </label>
      {FEATURE_KEYS.map((f) => (
        <label key={f} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={muted}>{FEATURES[f].label}</span>
          <LevelSelect feature={f} value={access[f]} onChange={(v) => setAccess({ ...access, [f]: v })} />
        </label>
      ))}
      {CAP_KEYS.map((f) => (
        <div key={f} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={muted}>{CAPABILITY_FEATURES[f].label}</span>
          <CapChecklist feature={f} value={access[f]} onChange={(v) => setAccess({ ...access, [f]: v })} />
        </div>
      ))}
      <label style={{ display: "flex", alignItems: "center", gap: "6px", paddingBottom: "6px" }}>
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        <span>Can manage permissions</span>
      </label>
      <s-button
        variant="primary"
        onClick={() =>
          fetcher.submit(
            { intent: "saveInvite", email, access: JSON.stringify(access), isAdmin: String(isAdmin) },
            { method: "post" },
          )
        }
        {...(fetcher.state !== "idle" ? { loading: true } : {})}
        {...(!email.trim() ? { disabled: true } : {})}
      >
        Add
      </s-button>
      {d?.error && d.intent === "saveInvite" && <div style={{ color: "#b42318", width: "100%" }}>{d.error}</div>}
      {d?.ok && d.intent === "saveInvite" && (
        <div style={{ color: "#1a5e20", width: "100%" }}>
          {d.updatedExisting ? "This person already uses the app; their access was updated." : "Added. Their access applies the first time they open the app."}
        </div>
      )}
    </div>
  );
}

function InviteRow({ inv }) {
  const fetcher = useFetcher();
  return (
    <tr style={{ opacity: fetcher.state !== "idle" ? 0.5 : 1 }}>
      <td style={cell}>
        {inv.email}
        <div style={{ ...muted, fontSize: "12px" }}>Hasn't opened the app yet</div>
      </td>
      {FEATURE_KEYS.map((f) => (
        <td key={f} style={{ ...cell, ...(inv.access[f] === "hidden" ? muted : {}) }}>
          {FEATURES[f].levelLabels[inv.access[f]]}
        </td>
      ))}
      {CAP_KEYS.map((f) => (
        <td key={f} style={{ ...cell, ...(inv.access[f]?.length ? {} : muted) }}>
          {capSummary(f, inv.access[f])}
        </td>
      ))}
      <td style={{ ...cell, textAlign: "center" }}>{inv.isAdmin ? "Yes" : "—"}</td>
      <td style={cell}>
        <s-button variant="tertiary" onClick={() => fetcher.submit({ intent: "removeInvite", id: String(inv.id) }, { method: "post" })}>
          Remove
        </s-button>
      </td>
    </tr>
  );
}

export default function Permissions() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Permissions" />;
  const { members, invites, me } = data;

  const headers = [
    "Staff member",
    ...FEATURE_KEYS.map((f) => FEATURES[f].label),
    ...CAP_KEYS.map((f) => CAPABILITY_FEATURES[f].label),
    "Admin",
    "",
  ];

  return (
    <s-page heading="Permissions">
      <s-section>
        <s-paragraph>
          Choose what each person can see and do. Anyone you haven't set up sees nothing from this app. People appear
          here after they first open the app or view a page it adds to Shopify admin. To give access before then, add
          them by email below.
        </s-paragraph>
        <s-paragraph>
          <span style={muted}>
            <strong>View</strong> shows a tool; <strong>View + undo</strong>, <strong>View + manage</strong> and{" "}
            <strong>View + approve</strong> also allow changes. <strong>Shipping</strong> has separate switches for each
            step (click to open the list). <strong>Admins</strong> can change these permissions. The store owner always has
            full access.
          </span>
        </s-paragraph>
      </s-section>

      <s-section heading="Staff">
        <div style={{ overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {headers.map((h, i) => (
                  <th key={i} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={m.id} m={m} me={me} />
              ))}
              {invites.map((inv) => (
                <InviteRow key={`i${inv.id}`} inv={inv} />
              ))}
            </tbody>
          </table>
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
