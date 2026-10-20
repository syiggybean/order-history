import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { storeUrl } from "../preorder-notify.server";
import {
  LoyaltyError,
  addMember,
  adjustPoints,
  cancelRedemption,
  ensureCurrency,
  getLoyaltySettings,
  listMembers,
  loyaltyStats,
  memberHistory,
  programOf,
  recentActivity,
  removeMember,
  saveLoyaltySettings,
  searchCustomers,
  setBirthday,
  setInvite,
} from "../loyalty.server";

const TABS = ["members", "activity", "settings"];

export const loader = async ({ request }) => {
  const { admin, session, user, noAccess } = await loadWithAccess(request, "loyalty", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const params = new URL(request.url).searchParams;
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : "members";
  await ensureCurrency(shop, admin);
  const st = await getLoyaltySettings(shop);
  const [stats, members, activity, base] = await Promise.all([
    loyaltyStats(shop),
    tab === "members" ? listMembers(shop, { q: params.get("q") ?? "" }) : null,
    tab === "activity" ? recentActivity(shop, 150) : null,
    storeUrl(shop, admin).catch(() => `https://${shop}`),
  ]);
  const handle = shop.replace(/\.myshopify\.com$/, "");
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return {
    tab,
    stats,
    members,
    activity,
    program: programOf(st),
    invite: {
      enabled: st.inviteEnabled,
      url: st.inviteToken ? `${base.replace(/\/$/, "")}/apps/purchase-history/rewards/join/${st.inviteToken}` : null,
      max: st.inviteMax,
      uses: st.inviteUses,
    },
    rewardsUrl: `${base.replace(/\/$/, "")}/apps/purchase-history/rewards`,
    shopAdmin: `https://admin.shopify.com/store/${handle}`,
    embedUrl: `https://admin.shopify.com/store/${handle}/themes/current/editor?context=apps${apiKey ? `&activateAppId=${apiKey}/loyalty-embed` : ""}`,
    canManage: can(user, "loyalty", "manage"),
  };
};

const NEEDS = { search: "view", history: "view", add: "manage", remove: "manage", adjust: "manage", cancelCode: "manage", invite: "manage", settings: "manage", birthday: "manage" };

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const need = NEEDS[intent];
  if (!need) return { intent, error: "Unknown action" };
  if (!can(user, "loyalty", need)) return { intent, ...denied("loyalty", need) };
  const shop = session.shop;
  const customerId = String(form.get("customerId") ?? "");
  try {
    if (intent === "search") return { intent, results: await searchCustomers(shop, admin, form.get("q")) };
    if (intent === "history") return { intent, customerId, ...(await memberHistory(shop, customerId)) };
    if (intent === "add") {
      const r = await addMember(shop, admin, customerId, { via: "admin", user });
      return { intent, ok: true, customerId, added: r.added, name: r.member?.name ?? r.member?.email };
    }
    if (intent === "remove") {
      await removeMember(shop, customerId, user);
      return { intent, ok: true, customerId };
    }
    if (intent === "adjust") {
      await adjustPoints(shop, customerId, form.get("points"), form.get("note"), user);
      return { intent, ok: true, customerId };
    }
    if (intent === "birthday") {
      await setBirthday(shop, customerId, form.get("birthday"), { staff: true });
      return { intent, ok: true, customerId };
    }
    if (intent === "cancelCode") {
      await cancelRedemption(shop, admin, form.get("redemptionId"), user);
      return { intent, ok: true, customerId, ...(await memberHistory(shop, customerId)) };
    }
    if (intent === "invite") {
      await setInvite(shop, { enabled: form.get("enabled") === "1", max: form.get("max") ?? undefined, regenerate: form.get("regenerate") === "1" });
      return { intent, ok: true };
    }
    if (intent === "settings") {
      await saveLoyaltySettings(
        shop,
        {
          enabled: form.get("enabled") === "1",
          programName: form.get("programName"),
          pointsPerDollar: form.get("pointsPerDollar"),
          earnOn: form.get("earnOn"),
          joinBonus: form.get("joinBonus"),
          birthdayBonus: form.get("birthdayBonus"),
          pointsName: form.get("pointsName"),
          pointName: form.get("pointName"),
          tierTagPrefix: form.get("tierTagPrefix"),
          tiers: form.get("tiers"),
          rewards: form.get("rewards"),
          socials: form.get("socials"),
        },
        user,
      );
      return { intent, ok: true };
    }
  } catch (e) {
    if (e instanceof LoyaltyError) return { intent, customerId, error: e.message };
    console.error(`[loyalty] ${intent}:`, errorMessage(e));
    return { intent, customerId, error: errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap" };
const num = { ...cell, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const muted = { color: "#616161", fontSize: "12px" };
const input = { padding: "5px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit" };
const scroll = { maxHeight: "620px", overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" });
const fmtDate = (s, time = false) =>
  s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", ...(time ? { hour: "numeric", minute: "2-digit" } : {}) }) : "—";
const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const money = (x, c) => new Intl.NumberFormat("en-US", { style: "currency", currency: c || "USD" }).format(x || 0);
const signed = (p) => (
  <span style={{ color: p >= 0 ? "#1a5e20" : "#8e1f0b", fontWeight: 700 }}>
    {p >= 0 ? "+" : "−"}
    {n(Math.abs(p))}
  </span>
);

function Stat({ label, value, note }) {
  return (
    <div style={{ flex: "1 1 150px", padding: "12px 14px", border: "1px solid #e3e3e3", borderRadius: "10px", background: "#fff" }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: "22px", fontWeight: 700, marginTop: "2px" }}>{value}</div>
      {note && <div style={muted}>{note}</div>}
    </div>
  );
}

export default function Loyalty() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Loyalty" /> : <LoyaltyPage />;
}

function LoyaltyPage() {
  const { tab, stats, program } = useLoaderData();
  const [, setParams] = useSearchParams();
  return (
    <s-page heading="Loyalty">
      {!program.enabled && (
        <s-banner tone="warning" heading="The program is paused">
          <s-paragraph>Members can't see or spend {program.pointsName} until it's turned back on under Settings.</s-paragraph>
        </s-banner>
      )}
      <s-section>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <Stat label="Members" value={n(stats.members)} note="invite-only" />
          <Stat label={`${program.pointsName} to spend`} value={n(stats.points)} note={`${n(stats.pending)} pending`} />
          <Stat label={`${program.pointsName} earned`} value={n(stats.lifetime)} note="all time" />
          <Stat label="Codes redeemed" value={n(stats.codesIssued)} note={`${n(stats.codesUsed)} used`} />
          <Stat label="Discount given" value={money(stats.discountGiven, program.currency)} note="on used codes" />
        </div>
        <div style={{ display: "flex", gap: "4px", marginTop: "14px", borderBottom: "1px solid #e3e3e3" }}>
          {[
            ["members", "Members"],
            ["activity", "Activity"],
            ["settings", "Settings"],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setParams({ tab: k })}
              style={{
                appearance: "none",
                border: 0,
                background: "none",
                padding: "8px 14px",
                font: "inherit",
                fontWeight: tab === k ? 700 : 500,
                borderBottom: `3px solid ${tab === k ? "#303030" : "transparent"}`,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </s-section>
      {tab === "members" && <MembersTab />}
      {tab === "activity" && <ActivityTab />}
      {tab === "settings" && <SettingsTab />}
    </s-page>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function AddMember({ canManage }) {
  const search = useFetcher();
  const adder = useFetcher();
  const revalidator = useRevalidator();
  const [q, setQ] = useState("");
  const timer = useRef(null);
  const [added, setAdded] = useState({});
  useEffect(() => {
    if (adder.state === "idle" && adder.data?.intent === "add" && adder.data.ok) {
      setAdded((a) => ({ ...a, [adder.data.customerId]: true }));
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adder.state, adder.data]);
  const results = search.data?.intent === "search" ? search.data.results ?? [] : [];
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: "6px" }}>Add a member</div>
      <input
        type="search"
        value={q}
        placeholder="Search customers by name or email"
        onChange={(e) => {
          const v = e.target.value;
          setQ(v);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => v.trim().length >= 2 && search.submit({ intent: "search", q: v.trim() }, { method: "post" }), 300);
        }}
        style={{ ...input, width: "100%", maxWidth: "420px" }}
        disabled={!canManage}
      />
      {!canManage && <div style={muted}>Adding members needs manage access.</div>}
      {search.data?.error && <div style={{ ...muted, color: "#b42318" }}>{search.data.error}</div>}
      {q.trim().length >= 2 && results.length > 0 && (
        <div style={{ marginTop: "8px", border: "1px solid #e3e3e3", borderRadius: "8px", maxWidth: "560px" }}>
          {results.map((r) => (
            <div key={r.customerId} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", borderBottom: "1px solid #f0f0f0" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div style={muted}>
                  {r.email ?? "no email"} · {r.orders} order{r.orders === 1 ? "" : "s"}
                </div>
              </div>
              {r.member || added[r.customerId] ? (
                <span style={pill("#e3f1df", "#1a5e20")}>Member</span>
              ) : (
                <s-button
                  onClick={() => adder.submit({ intent: "add", customerId: r.customerId }, { method: "post" })}
                  {...(adder.state !== "idle" && adder.formData?.get("customerId") === r.customerId ? { loading: true } : {})}
                >
                  Add
                </s-button>
              )}
            </div>
          ))}
        </div>
      )}
      {q.trim().length >= 2 && search.state === "idle" && search.data?.intent === "search" && !results.length && <div style={{ ...muted, marginTop: "6px" }}>No customers found.</div>}
      {adder.data?.error && <div style={{ ...muted, color: "#b42318", marginTop: "6px" }}>{adder.data.error}</div>}
    </div>
  );
}

function JoinLink({ invite, canManage }) {
  const fetcher = useFetcher();
  const [max, setMax] = useState(invite.max ?? "");
  const [copied, setCopied] = useState(false);
  useEffect(() => setMax(invite.max ?? ""), [invite.max]);
  const send = (patch) => fetcher.submit({ intent: "invite", enabled: invite.enabled ? "1" : "", max: String(max), ...patch }, { method: "post" });
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: "6px" }}>Private join link</div>
      <div style={{ ...muted, marginBottom: "6px" }}>Anyone with the link who logs in to their account joins. Turn it off when you've invited who you want.</div>
      <label style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <input type="checkbox" checked={invite.enabled} disabled={!canManage} onChange={(e) => send({ enabled: e.target.checked ? "1" : "" })} />
        Link is on
      </label>
      {invite.enabled && invite.url && (
        <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "8px" }}>
          <input readOnly value={invite.url} style={{ ...input, flex: "1 1 280px", maxWidth: "460px" }} onFocus={(e) => e.target.select()} />
          <s-button
            onClick={() => {
              try {
                navigator.clipboard?.writeText(invite.url);
              } catch {
                /* shown anyway */
              }
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </s-button>
          {canManage && (
            <s-button variant="tertiary" onClick={() => send({ regenerate: "1" })}>
              New link
            </s-button>
          )}
        </div>
      )}
      {invite.enabled && (
        <div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "8px", fontSize: "13px" }}>
          Up to
          <input type="number" min="1" value={max} placeholder="any" disabled={!canManage} onChange={(e) => setMax(e.target.value)} style={{ ...input, width: "80px" }} />
          people · {n(invite.uses)} joined so far
          {canManage && String(max) !== String(invite.max ?? "") && <s-button onClick={() => send({})}>Save</s-button>}
        </div>
      )}
      {fetcher.data?.error && <div style={{ ...muted, color: "#b42318" }}>{fetcher.data.error}</div>}
    </div>
  );
}

function MemberRow({ m, program, shopAdmin, canManage }) {
  const [open, setOpen] = useState(null); // null | "history" | "adjust"
  const hist = useFetcher();
  const act = useFetcher();
  const revalidator = useRevalidator();
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const tier = program.tiers.find((t) => t.id === m.tier) ?? program.tiers[0];
  useEffect(() => {
    if (act.state !== "idle" || !act.data?.ok) return;
    if (act.data.intent === "adjust") {
      setPoints("");
      setNote("");
      setOpen(null);
    }
    revalidator.revalidate();
    if (open === "history") hist.submit({ intent: "history", customerId: m.customerId }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.state, act.data]);
  const showHistory = () => {
    setOpen(open === "history" ? null : "history");
    if (open !== "history") hist.submit({ intent: "history", customerId: m.customerId }, { method: "post" });
  };
  const h = act.data?.intent === "cancelCode" && act.data.entries ? act.data : hist.data;
  return (
    <>
      <tr>
        <td style={cell}>
          <a href={`${shopAdmin}/customers/${m.customerId}`} target="_blank" rel="noreferrer" style={{ color: "#005bd3", fontWeight: 600 }}>
            {m.name ?? m.email ?? `Customer ${m.customerId}`}
          </a>
          <div style={muted}>{m.email}</div>
        </td>
        <td style={cell}>
          <span style={pill("#f1f1f1", "#303030")}>{tier.name}</span>
          <div style={muted}>{money(m.tierSpend, program.currency)} in 12 mo.</div>
        </td>
        <td style={{ ...num, fontWeight: 700 }}>{n(m.points)}</td>
        <td style={num}>{m.pending ? n(m.pending) : "—"}</td>
        <td style={num}>{n(m.lifetime)}</td>
        <td style={cell}>
          {fmtDate(m.joinedAt)}
          <div style={muted}>{m.via === "invite" ? "join link" : "added"}</div>
        </td>
        <td style={{ ...cell, whiteSpace: "nowrap" }}>
          <s-button variant="tertiary" onClick={showHistory}>
            {open === "history" ? "Hide" : "History"}
          </s-button>
          {canManage && (
            <s-button variant="tertiary" onClick={() => setOpen(open === "adjust" ? null : "adjust")}>
              Adjust
            </s-button>
          )}
          {canManage &&
            (confirmRemove ? (
              <>
                <s-button tone="critical" onClick={() => act.submit({ intent: "remove", customerId: m.customerId }, { method: "post" })}>
                  Remove
                </s-button>
                <s-button variant="tertiary" onClick={() => setConfirmRemove(false)}>
                  Keep
                </s-button>
              </>
            ) : (
              <s-button variant="tertiary" tone="critical" onClick={() => setConfirmRemove(true)}>
                Remove
              </s-button>
            ))}
        </td>
      </tr>
      {open === "adjust" && (
        <tr>
          <td colSpan={7} style={{ ...cell, background: "#fafafa" }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <input type="number" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="e.g. 250 or -100" style={{ ...input, width: "140px" }} aria-label={program.pointsName} />
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (the customer sees this)" style={{ ...input, flex: "1 1 260px", maxWidth: "420px" }} aria-label="Reason" />
              <s-button variant="primary" onClick={() => act.submit({ intent: "adjust", customerId: m.customerId, points, note }, { method: "post" })} {...(act.state !== "idle" ? { loading: true } : {})}>
                Save
              </s-button>
              {act.data?.error && <span style={{ ...muted, color: "#b42318" }}>{act.data.error}</span>}
            </div>
          </td>
        </tr>
      )}
      {open === "history" && (
        <tr>
          <td colSpan={7} style={{ ...cell, background: "#fafafa" }}>
            {!h?.entries ? (
              <span style={muted}>Loading…</span>
            ) : (
              <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" }}>
                <div style={{ flex: "2 1 380px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "4px" }}>{program.pointsName}</div>
                  {h.entries.length === 0 && <div style={muted}>Nothing yet.</div>}
                  {h.entries.map((e) => (
                    <div key={e.id} style={{ display: "flex", gap: "10px", padding: "4px 0", borderBottom: "1px solid #eee", opacity: e.status === "void" ? 0.45 : 1 }}>
                      <span style={{ ...muted, width: "110px", flexShrink: 0 }}>{fmtDate(e.at)}</span>
                      <span style={{ flex: 1 }}>
                        {e.text}
                        {e.status === "pending" && <span style={{ ...pill("#fff4d6", "#7a4f01"), marginLeft: "6px" }}>Pending</span>}
                        {e.status === "void" && <span style={{ ...pill("#f1f1f1", "#616161"), marginLeft: "6px" }}>Void</span>}
                        {e.by && <span style={muted}> · by {e.by}</span>}
                      </span>
                      {signed(e.points)}
                    </div>
                  ))}
                </div>
                <div style={{ flex: "1 1 280px" }}>
                  <div style={{ fontWeight: 600, marginBottom: "4px" }}>Codes</div>
                  {h.codes.length === 0 && <div style={muted}>None.</div>}
                  {h.codes.map((c) => (
                    <div key={c.id} style={{ padding: "4px 0", borderBottom: "1px solid #eee" }}>
                      <code style={{ fontWeight: 700 }}>{c.code}</code> · {c.name} · {n(c.points)} {program.pointsName}{" "}
                      <span style={pill(c.status === "used" ? "#e3f1df" : c.status === "issued" ? "#eef3ff" : "#f1f1f1", "#303030")}>{c.status}</span>
                      <div style={muted}>
                        {fmtDate(c.createdAt)}
                        {c.usedOn ? ` · used on ${c.usedOn}` : c.expiresAt ? ` · expires ${fmtDate(c.expiresAt)}` : ""}
                        {c.error ? ` · ${c.error}` : ""}
                      </div>
                      {canManage && c.status === "issued" && (
                        <s-button variant="tertiary" tone="critical" onClick={() => act.submit({ intent: "cancelCode", customerId: m.customerId, redemptionId: String(c.id) }, { method: "post" })}>
                          Cancel code and give back the {program.pointsName}
                        </s-button>
                      )}
                    </div>
                  ))}
                  {act.data?.intent === "cancelCode" && act.data.error && <div style={{ ...muted, color: "#b42318" }}>{act.data.error}</div>}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function MembersTab() {
  const { members, program, invite, shopAdmin, canManage, rewardsUrl, embedUrl } = useLoaderData();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const timer = useRef(null);
  return (
    <>
      <s-section>
        <div style={{ display: "flex", gap: "28px", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 340px" }}>
            <AddMember canManage={canManage} />
          </div>
          <div style={{ flex: "1 1 340px" }}>
            <JoinLink invite={invite} canManage={canManage} />
          </div>
        </div>
      </s-section>
      <s-section heading={`Members (${members.length}${members.length === 200 ? "+" : ""})`}>
        <input
          type="search"
          value={q}
          placeholder="Filter by name or email"
          onChange={(e) => {
            const v = e.target.value;
            setQ(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setParams((p) => {
              const x = new URLSearchParams(p);
              if (v.trim()) x.set("q", v.trim());
              else x.delete("q");
              return x;
            }, { replace: true }), 350);
          }}
          style={{ ...input, width: "100%", maxWidth: "320px", marginBottom: "10px" }}
        />
        {members.length === 0 ? (
          <s-paragraph>No members yet. Add someone above, or turn on the join link.</s-paragraph>
        ) : (
          <div style={scroll}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={head}>Customer</th>
                  <th style={head}>Tier</th>
                  <th style={{ ...head, textAlign: "right" }}>{program.pointsName}</th>
                  <th style={{ ...head, textAlign: "right" }}>Pending</th>
                  <th style={{ ...head, textAlign: "right" }}>Earned</th>
                  <th style={head}>Joined</th>
                  <th style={head} />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <MemberRow key={m.customerId} m={m} program={program} shopAdmin={shopAdmin} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
      <s-section heading="On your store">
        <s-paragraph>
          Members see their {program.pointsName} on the Rewards page ({rewardsUrl}), plus a badge by the account icon and "Earn X {program.pointsName}" on product pages once the{" "}
          <strong>Rewards</strong> app embed is on. Nobody else sees any of it, so Smile.io keeps working as it is.
        </s-paragraph>
        <div style={{ marginTop: "8px" }}>
          <s-button href={embedUrl} target="_blank">
            Open theme editor
          </s-button>
        </div>
      </s-section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function ActivityTab() {
  const { activity, program } = useLoaderData();
  return (
    <s-section heading={`Recent ${program.pointsName} activity`}>
      {activity.length === 0 ? (
        <s-paragraph>Nothing yet.</s-paragraph>
      ) : (
        <div style={scroll}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={head}>When</th>
                <th style={head}>Member</th>
                <th style={head}>What</th>
                <th style={{ ...head, textAlign: "right" }}>{program.pointsName}</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a) => (
                <tr key={a.id} style={{ opacity: a.status === "void" ? 0.45 : 1 }}>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDate(a.at, true)}</td>
                  <td style={cell}>{a.who}</td>
                  <td style={cell}>
                    {a.text}
                    {a.status === "pending" && <span style={{ ...pill("#fff4d6", "#7a4f01"), marginLeft: "6px" }}>Pending</span>}
                    {a.status === "void" && <span style={{ ...pill("#f1f1f1", "#616161"), marginLeft: "6px" }}>Void</span>}
                    {a.by && <span style={muted}> · by {a.by}</span>}
                  </td>
                  <td style={num}>{signed(a.points)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function ListEditor({ rows, setRows, cols, disabled, addLabel, blank }) {
  return (
    <div>
      {rows.map((r, i) => (
        <div key={r.id ?? i} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
          {cols.map((c) => (
            <label key={c.key} style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
              {c.label && <span style={muted}>{c.label}</span>}
              <input
                value={r[c.key] ?? ""}
                type={c.type ?? "text"}
                step={c.step}
                placeholder={c.placeholder}
                disabled={disabled}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))}
                style={{ ...input, width: c.width ?? "100px" }}
                aria-label={c.aria ?? c.label ?? c.key}
              />
              {c.suffix && <span style={muted}>{c.suffix}</span>}
            </label>
          ))}
          {!disabled && (
            <s-button variant="tertiary" tone="critical" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              Remove
            </s-button>
          )}
        </div>
      ))}
      {!disabled && (
        <s-button variant="tertiary" onClick={() => setRows([...rows, { ...blank, id: `n${Date.now().toString(36)}` }])}>
          + {addLabel}
        </s-button>
      )}
    </div>
  );
}

function SettingsTab() {
  const { program, canManage } = useLoaderData();
  const fetcher = useFetcher();
  const init = () => ({
    enabled: program.enabled,
    programName: program.programName,
    pointsPerDollar: String(program.rate),
    earnOn: program.earnOn,
    joinBonus: String(program.joinBonus),
    birthdayBonus: String(program.birthdayBonus),
    pointsName: program.pointsName,
    pointName: program.pointName,
    tierTagPrefix: program.tierTagPrefix,
    tiers: program.tiers.map((t) => ({ ...t, threshold: String(t.threshold) })),
    rewards: program.rewards.map((r) => ({ ...r, points: String(r.points), amount: String(r.amount), minSubtotal: r.minSubtotal == null ? "" : String(r.minSubtotal) })),
    socials: program.socials.map((s) => ({ ...s, points: String(s.points) })),
  });
  const [f, setF] = useState(init);
  const [dirty, setDirty] = useState(false);
  const set = (patch) => {
    setF((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setDirty(false);
  }, [fetcher.state, fetcher.data]);
  const dis = !canManage;
  const row = { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" };
  const cur = program.currency;
  return (
    <>
      <s-section heading="Program">
        <label style={row}>
          <input type="checkbox" checked={f.enabled} disabled={dis} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>
            <strong>Program is on</strong> <span style={muted}>(off hides the program from members and stops redeeming; orders still earn, nothing is lost)</span>
          </span>
        </label>
        <label style={row}>
          Name customers see
          <input value={f.programName} disabled={dis} onChange={(e) => set({ programName: e.target.value })} style={{ ...input, width: "220px" }} />
        </label>
        <label style={row}>
          Points are called
          <input value={f.pointsName} disabled={dis} onChange={(e) => set({ pointsName: e.target.value })} style={{ ...input, width: "140px" }} aria-label="Plural" />
          <span style={muted}>one:</span>
          <input value={f.pointName} disabled={dis} onChange={(e) => set({ pointName: e.target.value })} style={{ ...input, width: "140px" }} aria-label="Singular" />
        </label>
      </s-section>
      <s-section heading="Earning">
        <label style={row}>
          <input type="number" step="0.1" min="0" value={f.pointsPerDollar} disabled={dis} onChange={(e) => set({ pointsPerDollar: e.target.value })} style={{ ...input, width: "80px" }} />
          {f.pointsName || "points"} per {money(1, cur)} spent (after discounts, not shipping, tax or gift cards)
        </label>
        <div style={row}>
          Order {f.pointsName || "points"} become spendable
          <select value={f.earnOn} disabled={dis} onChange={(e) => set({ earnOn: e.target.value })} style={input}>
            <option value="shipped">when the order ships (safest for pre-orders)</option>
            <option value="paid">as soon as it's paid</option>
          </select>
        </div>
        <div style={{ ...muted, marginBottom: "12px" }}>Refunds, edits and cancellations take them back automatically.</div>
        <label style={row}>
          Joining bonus
          <input type="number" min="0" value={f.joinBonus} disabled={dis} onChange={(e) => set({ joinBonus: e.target.value })} style={{ ...input, width: "90px" }} />
          {f.pointsName}
        </label>
        <label style={row}>
          Birthday bonus
          <input type="number" min="0" value={f.birthdayBonus} disabled={dis} onChange={(e) => set({ birthdayBonus: e.target.value })} style={{ ...input, width: "90px" }} />
          {f.pointsName}, once a year on their birthday (set to 0 to turn off)
        </label>
        <div style={{ fontWeight: 600, margin: "14px 0 6px" }}>Follow us on social</div>
        <div style={{ ...muted, marginBottom: "6px" }}>Given once per account when they click through. There's no way to check they actually followed, so keep these small.</div>
        <ListEditor
          rows={f.socials}
          setRows={(socials) => set({ socials })}
          disabled={dis}
          addLabel="Add a social account"
          blank={{ label: "", url: "", points: "50" }}
          cols={[
            { key: "label", placeholder: "Follow us on Instagram", width: "220px", aria: "Label" },
            { key: "url", placeholder: "https://instagram.com/…", width: "240px", aria: "Link" },
            { key: "points", type: "number", width: "80px", suffix: f.pointsName, aria: "Amount" },
          ]}
        />
      </s-section>
      <s-section heading="VIP tiers">
        <div style={{ ...muted, marginBottom: "8px" }}>
          By what the member spent in the last 12 months. Tiers don't change earning; they're for exclusive sales. Each member's tier is added to their Shopify
          customer as a tag (e.g. "{(f.tierTagPrefix ?? "") + (f.tiers[f.tiers.length - 1]?.name ?? "Gold")}"), so a sale can target a customer segment of
          that tag. One tier must start at {money(0, cur)}.
          <div style={{ marginTop: "6px" }}>
            Tag starts with
            <input value={f.tierTagPrefix} disabled={dis} onChange={(e) => set({ tierTagPrefix: e.target.value })} style={{ ...input, width: "90px", margin: "0 6px" }} aria-label="Tag prefix" />
          </div>
        </div>
        <ListEditor
          rows={f.tiers}
          setRows={(tiers) => set({ tiers })}
          disabled={dis}
          addLabel="Add a tier"
          blank={{ name: "", threshold: "", perks: "" }}
          cols={[
            { key: "name", placeholder: "Gold", width: "120px", aria: "Tier name" },
            { key: "threshold", type: "number", width: "90px", label: "from", suffix: cur, aria: "Spend from" },
            { key: "perks", placeholder: "Shown to members, e.g. Exclusive Gold sales", width: "280px", aria: "Perks" },
          ]}
        />
      </s-section>
      <s-section heading="Rewards">
        <div style={{ ...muted, marginBottom: "8px" }}>
          Each one makes a one-time discount code only that customer can use. Codes never expire.
        </div>
        <ListEditor
          rows={f.rewards}
          setRows={(rewards) => set({ rewards })}
          disabled={dis}
          addLabel="Add a reward"
          blank={{ name: "", points: "", amount: "", minSubtotal: "" }}
          cols={[
            { key: "name", placeholder: "$5 off", width: "140px", aria: "Reward name" },
            { key: "points", type: "number", width: "90px", suffix: f.pointsName, aria: "Cost" },
            { key: "amount", type: "number", step: "0.01", width: "80px", label: "for", suffix: `${cur} off`, aria: "Amount off" },
            { key: "minSubtotal", type: "number", step: "0.01", width: "80px", label: "min. order", aria: "Minimum order" },
          ]}
        />
      </s-section>
      {canManage && (
        <s-section>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <s-button
              variant="primary"
              onClick={() =>
                fetcher.submit(
                  {
                    intent: "settings",
                    enabled: f.enabled ? "1" : "",
                    programName: f.programName,
                    pointsPerDollar: f.pointsPerDollar,
                    earnOn: f.earnOn,
                    joinBonus: f.joinBonus,
                    birthdayBonus: f.birthdayBonus,
                    pointsName: f.pointsName,
                    pointName: f.pointName,
                    tierTagPrefix: f.tierTagPrefix,
                    tiers: JSON.stringify(f.tiers),
                    rewards: JSON.stringify(f.rewards),
                    socials: JSON.stringify(f.socials),
                  },
                  { method: "post" },
                )
              }
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
              {...(!dirty ? { disabled: true } : {})}
            >
              Save settings
            </s-button>
            {fetcher.state === "idle" && fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
            {fetcher.state === "idle" && fetcher.data?.ok && !dirty && <span style={{ color: "#1a5e20" }}>Saved</span>}
          </div>
        </s-section>
      )}
    </>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
