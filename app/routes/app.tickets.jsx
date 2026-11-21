import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import {
  HelpdeskError,
  addNote,
  assign,
  assignees,
  attachment,
  connect,
  customerFor,
  getSignature,
  getSync,
  getTicket,
  listTickets,
  mailbox,
  pause,
  reply,
  saveSignature,
  setStatus,
  setupProblem,
  sync,
} from "../helpdesk.server";
import { STATUS_LABELS } from "../tickets";

// Tickets: emails to help@ as tickets, answered from here

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "tickets", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "active";
  const who = url.searchParams.get("who") || "all";
  const q = url.searchParams.get("q") || "";
  const id = Number(url.searchParams.get("id")) || null;
  const s = await getSync(shop);
  // Check the mailbox now if it's been a little while (the minute timer does the rest)
  if (s?.enabledAt && !s.pausedAt && (!s.lastSyncAt || Date.now() - s.lastSyncAt.getTime() > 20_000)) sync(shop).catch(() => {});
  const [list, ticket, people, signature] = await Promise.all([
    listTickets(shop, { status, who, q, userId: user?.id }),
    id ? getTicket(shop, id) : null,
    assignees(shop),
    getSignature(shop, user?.id),
  ]);
  return {
    mailbox: s?.mailbox ?? mailbox(),
    sync: s
      ? {
          on: Boolean(s.enabledAt),
          enabledAt: s.enabledAt?.toISOString() ?? null,
          paused: Boolean(s.pausedAt),
          lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
          error: s.lastError,
        }
      : { on: false },
    setupProblem: setupProblem(),
    filters: { status, who, q, id },
    ...list,
    ticket,
    people,
    signature: signature ?? "",
    me: user?.id ?? null,
    canReply: can(user, "tickets", "reply"),
    isAdmin: Boolean(user?.isAdmin),
  };
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "tickets", "view")) return denied("tickets", "view");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const shop = session.shop;
  const id = form.get("id");
  try {
    if (intent === "customer") return { intent, customer: await customerFor(shop, admin, String(form.get("email") ?? "")) };
    if (intent === "attachment") return { intent, file: await attachment(shop, form.get("messageId"), form.get("index")) };
    if (intent === "connect" || intent === "pause" || intent === "resume") {
      if (!user?.isAdmin) return { intent, error: "Only app admins can connect or pause the mailbox." };
      if (intent === "connect") return { intent, ok: true, ...(await connect(shop)) };
      await pause(shop, intent === "pause");
      return { intent, ok: true };
    }
    if (intent === "syncNow") return { intent, ok: true, ...(await sync(shop)) };
    if (!can(user, "tickets", "reply")) return denied("tickets", "reply");
    if (intent === "reply") {
      await reply(shop, id, form.get("html"), user, { status: String(form.get("status") || "waiting"), signature: form.get("signature") !== "false" });
      return { intent, ok: true };
    }
    if (intent === "signature") return { intent, ok: true, signature: await saveSignature(shop, user?.id, form.get("html")) };
    if (intent === "note") return (await addNote(shop, id, form.get("text"), user), { intent, ok: true });
    if (intent === "status") return (await setStatus(shop, id, String(form.get("status") ?? "")), { intent, ok: true });
    if (intent === "assign") return (await assign(shop, id, Number(form.get("staffId")) || null), { intent, ok: true });
    if (intent === "assignMe") return (await assign(shop, id, user?.id), { intent, ok: true });
    return { intent, error: "Unknown action." };
  } catch (e) {
    if (!(e instanceof HelpdeskError)) console.error(`[tickets] ${intent}:`, e);
    return { intent, error: e instanceof HelpdeskError ? e.message : `Something went wrong: ${e?.message ?? e}` };
  }
};

export const headers = (headersArgs) => boundary.headers(headersArgs);

// ---------------------------------------------------------------------------

const muted = { color: "#616161" };
const small = { fontSize: "12px", color: "#616161" };
const btn = { appearance: "none", border: "1px solid #c9c9c9", background: "#fff", borderRadius: "8px", padding: "6px 12px", font: "inherit", fontSize: "13px", cursor: "pointer" };
const dark = { ...btn, background: "#1a1a1a", color: "#fff", border: "1px solid #1a1a1a" };
const chosen = { background: "#1a1a1a", color: "#fff", border: "1px solid #1a1a1a" };
const field = { border: "1px solid #c9c9c9", borderRadius: "8px", padding: "6px 10px", font: "inherit", fontSize: "13px", background: "#fff" };
const STATUS_STYLE = {
  open: { background: "#e0f0ff", color: "#0b4a8b" },
  waiting: { background: "#fff1d6", color: "#7a4f01" },
  closed: { background: "#ebebeb", color: "#4a4a4a" },
};

function fmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return d.toLocaleString("en-US", sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatusTag({ status }) {
  return (
    <span style={{ ...STATUS_STYLE[status], padding: "1px 8px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" }}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// Long quoted history ("On … wrote:" and "> …" lines) folds away
function splitQuoted(body) {
  const text = String(body ?? "");
  const m = text.match(/\n(On .{5,300}?wrote:\s*\n|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/);
  let cut = m ? m.index : -1;
  if (cut < 0) {
    const lines = text.split("\n");
    let i = lines.length;
    while (i > 0 && (/^\s*>/.test(lines[i - 1]) || !lines[i - 1].trim())) i--;
    if (i < lines.length && lines.slice(i).some((l) => /^\s*>/.test(l))) cut = lines.slice(0, i).join("\n").length;
  }
  return cut > 0 ? [text.slice(0, cut).trimEnd(), text.slice(cut).trim()] : [text, ""];
}

export default function Tickets() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Tickets" />;
  return <TicketsPage data={data} />;
}

function TicketsPage({ data }) {
  const [params, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  // Fresh tickets every 30 seconds
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") revalidator.revalidate();
    }, 30_000);
    return () => clearInterval(t);
  }, [revalidator]);

  const set = (changes) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, String(v));
    }
    setParams(next, { preventScrollReset: true });
  };

  return (
    <s-page heading="Tickets" inlineSize="large">
      <style>{`
        .tk-editor:empty:before { content: attr(data-placeholder); color: #8a8a8a; }
        .tk-html p { margin: 0 0 8px; }
        .tk-html ul, .tk-html ol { margin: 4px 0 8px; padding-left: 22px; }
        .tk-html blockquote { margin: 4px 0; padding-left: 10px; border-left: 3px solid #ddd; color: #555; }
        .tk-html a { color: #005bd3; }
        .tk-html img { max-width: 100%; height: auto; }
      `}</style>
      <Connection data={data} />
      {data.sync.on && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 380px) minmax(0, 1fr)", gap: "16px", alignItems: "start" }}>
          <TicketList data={data} set={set} />
          {data.ticket ? (
            <TicketView key={data.ticket.id} ticket={data.ticket} data={data} />
          ) : (
            <div style={{ ...muted, padding: "40px 20px", textAlign: "center", border: "1px dashed #d4d4d4", borderRadius: "12px" }}>Pick a ticket to read it.</div>
          )}
        </div>
      )}
    </s-page>
  );
}

// ---- Mailbox connection ---------------------------------------------------

function Connection({ data }) {
  const f = useFetcher();
  const busy = f.state !== "idle";
  const error = f.data?.error;
  const box = data.mailbox;
  if (!data.sync.on) {
    return (
      <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", padding: "16px", background: "#fff", marginBottom: "16px", display: "grid", gap: "8px", maxWidth: "720px" }}>
        <strong>Turn emails to {box} into tickets</strong>
        <span>
          From the moment you connect, each new email in {box}&apos;s inbox becomes a ticket here, and replies in the same conversation join it. Imported
          emails get a &quot;MonkeyBean&quot; label in Gmail so they&apos;re never imported twice; nothing else about them changes.
        </span>
        <span style={small}>
          Before connecting: in the Google Admin console (Security → API controls → Domain-wide delegation), add
          <code> https://www.googleapis.com/auth/gmail.modify </code>
          to the scopes of MonkeyBean&apos;s service account (the one already used for email).
        </span>
        {data.setupProblem && <span style={{ color: "#8e1f0b" }}>{data.setupProblem}</span>}
        {data.isAdmin ? (
          <div>
            <button type="button" style={dark} disabled={busy || Boolean(data.setupProblem)} onClick={() => f.submit({ intent: "connect" }, { method: "post" })}>
              {busy ? "Connecting…" : `Connect ${box}`}
            </button>
          </div>
        ) : (
          <span style={muted}>An app admin needs to connect the mailbox.</span>
        )}
        {error && <span style={{ color: "#8e1f0b" }}>{error}</span>}
      </div>
    );
  }
  const s = data.sync;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginBottom: "12px", fontSize: "13px" }}>
      <span style={muted}>
        📥 {box}
        {s.paused ? " · paused" : s.lastSyncAt ? ` · checked ${fmt(s.lastSyncAt)}` : " · checking…"} · tickets from {fmt(s.enabledAt)}
      </span>
      <button type="button" style={{ ...btn, padding: "3px 10px" }} disabled={busy || s.paused} onClick={() => f.submit({ intent: "syncNow" }, { method: "post" })}>
        {busy && f.formData?.get("intent") === "syncNow" ? "Checking…" : "Check now"}
      </button>
      {data.isAdmin && (
        <button
          type="button"
          style={{ ...btn, padding: "3px 10px" }}
          disabled={busy}
          onClick={() => f.submit({ intent: s.paused ? "resume" : "pause" }, { method: "post" })}
          title={s.paused ? "Start importing again" : "Stop importing new emails for now"}
        >
          {s.paused ? "Resume" : "Pause"}
        </button>
      )}
      {(error || s.error) && <span style={{ color: "#8e1f0b", flexBasis: "100%" }}>{error || s.error}</span>}
    </div>
  );
}

// ---- The list -------------------------------------------------------------

const STATUS_TABS = [
  ["active", "Open + waiting"],
  ["open", "Open"],
  ["waiting", "Waiting"],
  ["closed", "Closed"],
  ["all", "All"],
];

function TicketList({ data, set }) {
  const { filters, counts } = data;
  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const count = (k) => (k === "active" ? (counts.open ?? 0) + (counts.waiting ?? 0) : k === "all" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[k] ?? 0);
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", overflow: "hidden" }}>
      <div style={{ padding: "10px", display: "grid", gap: "8px", borderBottom: "1px solid #eee" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
          {STATUS_TABS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => set({ status: k === "active" ? null : k, id: null })}
              style={{ ...btn, padding: "3px 9px", fontSize: "12px", ...(filters.status === k ? chosen : {}) }}
            >
              {label} <span style={{ opacity: 0.7 }}>{count(k)}</span>
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          <select aria-label="Whose tickets" value={filters.who} onChange={(e) => set({ who: e.target.value === "all" ? null : e.target.value })} style={field}>
            <option value="all">Everyone&apos;s</option>
            <option value="mine">Mine</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <form
            style={{ flex: 1, display: "flex" }}
            onSubmit={(e) => {
              e.preventDefault();
              set({ q: q.trim() || null });
            }}
          >
            <input type="search" placeholder="Search # , subject, customer" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...field, flex: 1, minWidth: 0 }} />
          </form>
        </div>
      </div>
      <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
        {data.tickets.length === 0 && <div style={{ ...muted, padding: "24px", textAlign: "center" }}>No tickets here.</div>}
        {data.tickets.map((t) => {
          const selected = t.id === filters.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => set({ id: t.id })}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr)",
                gap: "3px",
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                border: "none",
                borderBottom: "1px solid #f0f0f0",
                background: selected ? "#f1f6ff" : "#fff",
                font: "inherit",
                cursor: "pointer",
                borderLeft: `3px solid ${t.needsReply && t.status !== "closed" ? "#2c6ecb" : "transparent"}`,
              }}
            >
              <span style={{ display: "flex", gap: "6px", alignItems: "baseline" }}>
                <span style={{ ...small, flexShrink: 0 }}>#{t.number}</span>
                <span style={{ fontWeight: t.needsReply && t.status !== "closed" ? 650 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{t.subject}</span>
                <span style={{ ...small, flexShrink: 0 }}>{fmt(t.lastMessageAt)}</span>
              </span>
              <span style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" }}>
                <span style={{ ...muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>{t.customerName || t.customerEmail}</span>
                {t.assigneeName && <span style={small}>→ {t.assigneeName}</span>}
                <StatusTag status={t.status} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- One ticket -----------------------------------------------------------

function TicketView({ ticket, data }) {
  const act = useFetcher();
  const busy = act.state !== "idle";
  const run = (intent, extra = {}) => act.submit({ intent, id: String(ticket.id), ...extra }, { method: "post" });
  const error = act.data?.error;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 260px", gap: "16px", alignItems: "start" }}>
      <div style={{ display: "grid", gap: "12px", minWidth: 0 }}>
        <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", padding: "12px 14px", display: "grid", gap: "8px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={small}>#{ticket.number}</span>
            <strong style={{ fontSize: "15px", flex: 1, minWidth: 0 }}>{ticket.subject}</strong>
            <StatusTag status={ticket.status} />
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", fontSize: "13px" }}>
            <span style={muted}>Status</span>
            <select
              aria-label="Status"
              value={ticket.status}
              disabled={!data.canReply || busy}
              onChange={(e) => run("status", { status: e.target.value })}
              style={field}
            >
              {Object.entries(STATUS_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <span style={{ ...muted, marginLeft: "8px" }}>Assigned to</span>
            <select
              aria-label="Assigned to"
              value={ticket.assigneeId ?? ""}
              disabled={!data.canReply || busy}
              onChange={(e) => run("assign", { staffId: e.target.value })}
              style={field}
            >
              <option value="">Nobody</option>
              {ticket.assigneeId && !data.people.some((p) => p.id === ticket.assigneeId) && <option value={ticket.assigneeId}>{ticket.assigneeName}</option>}
              {data.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === data.me ? " (me)" : ""}
                </option>
              ))}
            </select>
            {data.canReply && ticket.assigneeId !== data.me && data.me && (
              <button type="button" style={{ ...btn, padding: "3px 10px" }} disabled={busy} onClick={() => run("assignMe")}>
                Assign to me
              </button>
            )}
          </div>
        </div>

        {ticket.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {data.canReply ? (
          <Composer ticket={ticket} signature={data.signature} />
        ) : (
          <div style={{ ...muted, fontSize: "13px" }}>You can read tickets. Ask an admin for &quot;View + reply&quot; access to answer them.</div>
        )}
        {error && <div style={{ color: "#8e1f0b" }}>{error}</div>}
      </div>
      <CustomerPanel ticket={ticket} />
    </div>
  );
}

function Message({ m }) {
  const [open, setOpen] = useState(false);
  const dl = useFetcher();
  useEffect(() => {
    const f = dl.data?.file;
    if (!f) return;
    const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: f.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [dl.data]);
  const note = m.kind === "note";
  const ours = m.kind === "reply";
  const [main, quoted] = note || m.html ? [m.body, ""] : splitQuoted(m.body);
  const who = note ? `${m.staffName ?? "Staff"} · internal note` : ours ? `${m.staffName ?? m.fromName ?? "Yiggybean"} (reply)` : m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail;
  return (
    <div
      style={{
        border: `1px solid ${note ? "#ecd58f" : ours ? "#c8dcf5" : "#e3e3e3"}`,
        background: note ? "#fffbea" : ours ? "#f5f9ff" : "#fff",
        borderRadius: "12px",
        padding: "12px 14px",
        display: "grid",
        gap: "6px",
        marginLeft: ours || note ? "32px" : 0,
      }}
    >
      <div style={{ display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: "13px", flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{who}</strong>
        <span style={small}>{fmt(m.sentAt)}</span>
      </div>
      {!note && m.cc && <span style={small}>Cc: {m.cc}</span>}
      {m.html ? (
        // Our own replies: HTML cleaned on the server (only simple formatting, links and https images)
        <div className="tk-html" style={{ overflowWrap: "anywhere", fontSize: "14px", lineHeight: 1.45 }} dangerouslySetInnerHTML={{ __html: m.html }} />
      ) : (
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "14px", lineHeight: 1.45 }}>{main || <span style={muted}>(no text)</span>}</div>
      )}
      {quoted && (
        <div>
          <button type="button" style={{ appearance: "none", border: "none", background: "none", padding: 0, color: "#005bd3", cursor: "pointer", font: "inherit", fontSize: "12px" }} onClick={() => setOpen(!open)}>
            {open ? "Hide earlier messages" : "Show earlier messages"}
          </button>
          {open && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "13px", color: "#616161", marginTop: "6px" }}>{quoted}</div>}
        </div>
      )}
      {m.attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {m.attachments.map((a) => (
            <button
              key={a.i}
              type="button"
              style={{ ...btn, padding: "3px 10px", fontSize: "12px" }}
              disabled={dl.state !== "idle"}
              onClick={() => dl.submit({ intent: "attachment", messageId: String(m.id), index: String(a.i) }, { method: "post" })}
            >
              📎 {a.name}
              {a.size ? ` (${Math.max(1, Math.round(a.size / 1024))} KB)` : ""}
            </button>
          ))}
          {dl.data?.error && <span style={{ color: "#8e1f0b", fontSize: "12px" }}>{dl.data.error}</span>}
        </div>
      )}
    </div>
  );
}

function Composer({ ticket, signature }) {
  const f = useFetcher();
  const [mode, setMode] = useState("reply");
  const [text, setText] = useState("");
  const [html, setHtml] = useState("");
  const [after, setAfter] = useState("waiting");
  const [withSig, setWithSig] = useState(true);
  const [editingSig, setEditingSig] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const [sig, setSig] = useState(signature);
  useEffect(() => setSig(signature), [signature]);
  const busy = f.state !== "idle";
  useEffect(() => {
    if (f.state === "idle" && f.data?.ok && (f.data.intent === "reply" || f.data.intent === "note")) {
      setText("");
      setHtml("");
      setEditorKey((k) => k + 1);
    }
  }, [f.state, f.data]);
  const empty = mode === "note" ? !text.trim() : !htmlHasText(html);
  const send = () => {
    if (empty) return;
    if (mode === "note") f.submit({ intent: "note", id: String(ticket.id), text }, { method: "post" });
    else f.submit({ intent: "reply", id: String(ticket.id), html, status: after, signature: withSig && sig ? "true" : "false" }, { method: "post" });
  };
  return (
    <div style={{ border: `1px solid ${mode === "note" ? "#ecd58f" : "#c9c9c9"}`, background: mode === "note" ? "#fffbea" : "#fff", borderRadius: "12px", padding: "10px 12px", display: "grid", gap: "8px" }}>
      <div style={{ display: "flex", gap: "4px" }}>
        {[
          ["reply", `Reply to ${ticket.customerName || ticket.customerEmail}`],
          ["note", "Internal note"],
        ].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} style={{ ...btn, padding: "3px 10px", fontSize: "12px", ...(mode === k ? chosen : {}) }}>
            {label}
          </button>
        ))}
      </div>
      {mode === "note" ? (
        <textarea
          aria-label="Internal note"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Only staff see this."
          style={{ ...field, width: "100%", boxSizing: "border-box", resize: "vertical", fontSize: "14px", lineHeight: 1.45 }}
        />
      ) : (
        <>
          <RichEditor key={editorKey} onChange={setHtml} placeholder="Your reply goes out from the help mailbox, in the same email conversation." label="Reply" />
          {withSig && sig && !editingSig && (
            <div style={{ borderTop: "1px dashed #ddd", paddingTop: "6px" }}>
              <div className="tk-html" style={{ fontSize: "13px", color: "#4a4a4a" }} dangerouslySetInnerHTML={{ __html: sig }} />
            </div>
          )}
          {editingSig && <SignatureEditor value={sig} onDone={(v) => (setSig(v ?? sig), setEditingSig(false))} />}
        </>
      )}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={dark} disabled={busy || empty} onClick={send}>
          {busy && (f.formData?.get("intent") === "reply" || f.formData?.get("intent") === "note") ? (mode === "note" ? "Saving…" : "Sending…") : mode === "note" ? "Add note" : "Send reply"}
        </button>
        {mode === "reply" && (
          <>
            <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
              then mark as
              <select value={after} onChange={(e) => setAfter(e.target.value)} style={field}>
                <option value="waiting">Waiting on customer</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </label>
            {sig ? (
              <label style={{ display: "flex", gap: "4px", alignItems: "center", fontSize: "13px" }}>
                <input type="checkbox" checked={withSig} onChange={(e) => setWithSig(e.target.checked)} /> My signature
              </label>
            ) : null}
            <button type="button" style={{ ...linkStyle, fontSize: "13px" }} onClick={() => setEditingSig(!editingSig)}>
              {editingSig ? "Close signature" : sig ? "Edit signature" : "Add a signature"}
            </button>
          </>
        )}
        {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      </div>
    </div>
  );
}

const linkStyle = { appearance: "none", border: "none", background: "none", padding: 0, color: "#005bd3", cursor: "pointer", font: "inherit" };
const htmlHasText = (h) => /<img/i.test(h) || Boolean(String(h ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim());

// This person's signature, saved for all their replies
function SignatureEditor({ value, onDone }) {
  const f = useFetcher();
  const [html, setHtml] = useState(value ?? "");
  useEffect(() => {
    if (f.state === "idle" && f.data?.intent === "signature" && f.data.ok) onDone(f.data.signature);
  }, [f.state, f.data, onDone]);
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", padding: "10px", display: "grid", gap: "8px", background: "#fafafa" }}>
      <strong style={{ fontSize: "13px" }}>Your signature</strong>
      <span style={small}>Added under each reply you send. Only yours: everyone sets their own. Images need an https address (Image button).</span>
      <RichEditor initial={value} onChange={setHtml} placeholder="e.g. Rosie · Yiggybean Books + Gifts" label="Signature" minHeight="70px" />
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button type="button" style={dark} disabled={f.state !== "idle"} onClick={() => f.submit({ intent: "signature", html }, { method: "post" })}>
          {f.state !== "idle" ? "Saving…" : "Save signature"}
        </button>
        <button type="button" style={btn} onClick={() => onDone(null)}>
          Cancel
        </button>
        {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      </div>
    </div>
  );
}

// A small formatting editor: bold, italic, underline, lists, links, images.
// The server cleans whatever comes out of it before anything is stored or sent.
function RichEditor({ initial = "", onChange, placeholder, label, minHeight = "130px" }) {
  const ref = useRef(null);
  const saved = useRef(null);
  const [linking, setLinking] = useState(null); // "link" | "image" | null
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (ref.current && initial) {
      ref.current.innerHTML = initial;
      onChange?.(initial);
    }
    // Only the first time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changed = () => onChange?.(ref.current?.innerHTML ?? "");
  const cmd = (name, arg) => {
    ref.current?.focus();
    restore();
    document.execCommand(name, false, arg);
    changed();
  };
  const remember = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && ref.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    if (!saved.current) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(saved.current);
  };
  const tool = (title, content, onClick, extra = {}) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      style={{ ...btn, padding: "2px 8px", fontSize: "13px", minWidth: "30px", ...extra }}
    >
      {content}
    </button>
  );
  const finishLink = () => {
    const v = url.trim();
    if (v) {
      if (linking === "link") cmd("createLink", /^(https?:|mailto:|tel:)/i.test(v) ? v : `https://${v}`);
      else if (/^https:\/\//i.test(v)) cmd("insertImage", v);
    }
    setLinking(null);
    setUrl("");
  };
  return (
    <div style={{ border: "1px solid #c9c9c9", borderRadius: "8px", background: "#fff" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", padding: "6px", borderBottom: "1px solid #eee", alignItems: "center" }}>
        {tool("Bold", <b>B</b>, () => cmd("bold"))}
        {tool("Italic", <i>I</i>, () => cmd("italic"))}
        {tool("Underline", <u>U</u>, () => cmd("underline"))}
        {tool("Bulleted list", "• List", () => cmd("insertUnorderedList"))}
        {tool("Numbered list", "1. List", () => cmd("insertOrderedList"))}
        {tool("Link", "🔗 Link", () => (remember(), setLinking("link")))}
        {tool("Image (https address)", "🖼 Image", () => (remember(), setLinking("image")))}
        {tool("Clear formatting", "Clear", () => cmd("removeFormat"))}
        {linking && (
          <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
            <input
              autoFocus
              aria-label={linking === "link" ? "Link address" : "Image address"}
              placeholder={linking === "link" ? "https://…" : "https://… (image)"}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  finishLink();
                }
                if (e.key === "Escape") setLinking(null);
              }}
              style={{ ...field, padding: "3px 8px", width: "220px" }}
            />
            {tool("Add", "Add", finishLink)}
          </span>
        )}
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={changed}
        onBlur={remember}
        onKeyUp={remember}
        onMouseUp={remember}
        className="tk-editor tk-html"
        style={{ minHeight, padding: "8px 10px", outline: "none", fontSize: "14px", lineHeight: 1.45, overflowWrap: "anywhere" }}
      />
    </div>
  );
}

function CustomerPanel({ ticket }) {
  const f = useFetcher();
  const email = ticket.customerEmail;
  const submit = useRef(f.submit);
  submit.current = f.submit;
  useEffect(() => {
    if (email) submit.current({ intent: "customer", email }, { method: "post" });
  }, [email]);
  const c = f.data?.intent === "customer" ? f.data.customer : undefined;
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", padding: "12px 14px", display: "grid", gap: "8px", fontSize: "13px" }}>
      <strong>Customer</strong>
      <span style={{ overflowWrap: "anywhere" }}>
        {ticket.customerName && <>{ticket.customerName}<br /></>}
        <span style={muted}>{email}</span>
      </span>
      {f.state !== "idle" && c === undefined && <span style={muted}>Looking them up…</span>}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      {c === null && <span style={muted}>No Shopify customer with this email.</span>}
      {c && (
        <>
          <a href={c.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
            {c.name || c.email} in Shopify ↗
          </a>
          <span style={muted}>
            {c.orders ?? 0} order{c.orders === 1 ? "" : "s"}
            {c.spent ? ` · ${c.spent} spent` : ""}
          </span>
          {c.tags.length > 0 && <span style={small}>{c.tags.join(", ")}</span>}
          {c.recent.length > 0 && (
            <div style={{ display: "grid", gap: "6px", marginTop: "4px" }}>
              <span style={{ ...small, fontWeight: 600 }}>Recent orders</span>
              {c.recent.map((o) => (
                <a key={o.name} href={o.url} target="_blank" rel="noreferrer" style={{ display: "grid", gap: "1px", color: "inherit", textDecoration: "none", padding: "6px 8px", border: "1px solid #eee", borderRadius: "8px" }}>
                  <span style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
                    <span style={{ color: "#005bd3", fontWeight: 600 }}>{o.name}</span>
                    <span>{o.total}</span>
                  </span>
                  <span style={small}>
                    {new Date(o.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · {o.cancelled ? "Cancelled" : `${titleCase(o.paid)} · ${titleCase(o.fulfilled)}`}
                  </span>
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
