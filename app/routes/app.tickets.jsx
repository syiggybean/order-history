import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { Flyout } from "../components/Flyout";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import {
  HelpdeskError,
  addNote,
  assign,
  assignees,
  attachment,
  connect,
  customerDetail,
  customerFor,
  editNote,
  getTemplates,
  resetTemplate,
  saveTemplate,
  sendTest,
  getSignature,
  getSync,
  getTicket,
  listTickets,
  mailbox,
  orderDetail,
  pause,
  reply,
  saveSignature,
  setStatus,
  setupProblem,
  updateTicket,
  sync,
} from "../helpdesk.server";
import { STATUS_LABELS, VARIABLES, renderTemplate, sampleValues, unknownVariables } from "../tickets";

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
  const view = url.searchParams.get("view") === "templates" ? "templates" : "tickets";
  const s = await getSync(shop);
  // Check the mailbox now if it's been a little while (the minute timer does the rest)
  if (s?.enabledAt && !s.pausedAt && (!s.lastSyncAt || Date.now() - s.lastSyncAt.getTime() > 20_000)) sync(shop).catch(() => {});
  const [list, ticket, people, signature, templates] = await Promise.all([
    listTickets(shop, { status, who, q, userId: user?.id }),
    id ? getTicket(shop, id) : null,
    assignees(shop),
    getSignature(shop, user?.id),
    view === "templates" ? getTemplates(shop) : null,
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
    filters: { status, who, q, id, view },
    templates,
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
    if (intent === "customerDetail") return { intent, customer: await customerDetail(shop, admin, String(form.get("customerId") ?? "")) };
    if (intent === "orderDetail") return { intent, order: await orderDetail(shop, admin, String(form.get("orderId") ?? "")) };
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
    if (intent === "editNote") return (await editNote(shop, form.get("messageId"), form.get("text"), user), { intent, ok: true });
    if (intent === "testTemplate") return { intent, ok: true, sentTo: await sendTest(shop, { subject: form.get("subject"), html: form.get("html") }, user) };
    if (intent === "saveTemplate" || intent === "resetTemplate") {
      if (!user?.isAdmin) return { intent, error: "Only app admins can change email templates." };
      if (intent === "resetTemplate") return (await resetTemplate(shop, String(form.get("key") ?? "")), { intent, ok: true });
      await saveTemplate(shop, String(form.get("key") ?? ""), { subject: form.get("subject"), html: form.get("html"), enabled: form.get("enabled") === "true" }, user);
      return { intent, ok: true };
    }
    if (intent === "note") return (await addNote(shop, id, form.get("text"), user), { intent, ok: true });
    if (intent === "update") return (await updateTicket(shop, id, { status: String(form.get("status") ?? ""), staffId: Number(form.get("staffId")) || null }), { intent, ok: true });
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
      <div style={{ display: "flex", gap: "4px", marginBottom: "12px" }}>
        {[
          ["tickets", "Tickets"],
          ["templates", "Email templates"],
        ].map(([k, label]) => (
          <button key={k} type="button" onClick={() => set({ view: k === "tickets" ? null : k })} style={{ ...btn, ...(data.filters.view === k ? chosen : {}) }}>
            {label}
          </button>
        ))}
      </div>
      {data.filters.view === "templates" && <TemplateDesigner data={data} />}
      {data.filters.view !== "templates" && data.sync.on && (
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
  const error = act.data?.error;
  // Status and assignee are edited here and only saved with Save (status
  // changes will notify customers in a later update)
  const saved = { status: ticket.status, assigneeId: ticket.assigneeId ?? "" };
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft({ status: ticket.status, assigneeId: ticket.assigneeId ?? "" }), [ticket.status, ticket.assigneeId]);
  const dirty = draft.status !== saved.status || String(draft.assigneeId) !== String(saved.assigneeId);
  const save = () => act.submit({ intent: "update", id: String(ticket.id), status: draft.status, staffId: String(draft.assigneeId ?? "") }, { method: "post" });
  const discard = () => setDraft(saved);

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
              value={draft.status}
              disabled={!data.canReply || busy}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
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
              value={draft.assigneeId ?? ""}
              disabled={!data.canReply || busy}
              onChange={(e) => setDraft({ ...draft, assigneeId: e.target.value ? Number(e.target.value) : "" })}
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
            {data.canReply && draft.assigneeId !== data.me && data.me && (
              <button type="button" style={{ ...btn, padding: "3px 10px" }} disabled={busy} onClick={() => setDraft({ ...draft, assigneeId: data.me })}>
                Assign to me
              </button>
            )}
          </div>
          {data.canReply && (dirty || busy) && (
            <div style={{ display: "flex", gap: "8px", alignItems: "center", background: "#fff8e6", border: "1px solid #ecd58f", borderRadius: "8px", padding: "6px 10px", fontSize: "13px" }}>
              <span style={{ flex: 1 }}>Unsaved changes to this ticket.</span>
              <button type="button" style={btn} disabled={busy} onClick={discard}>
                Discard
              </button>
              <button type="button" style={dark} disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>

        {ticket.messages.map((m) => (
          <Message key={m.id} m={m} data={data} />
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

function Message({ m, data }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const ed = useFetcher();
  useEffect(() => {
    if (ed.state === "idle" && ed.data?.intent === "editNote" && ed.data.ok) setEditing(false);
  }, [ed.state, ed.data]);
  const canEdit = m.kind === "note" && data?.canReply && (data.isAdmin || (data.me && m.staffId === data.me));
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
  const auto = m.kind === "auto";
  const ours = m.kind === "reply" || auto;
  const [main, quoted] = note || m.html ? [m.body, ""] : splitQuoted(m.body);
  const who = note
    ? `${m.staffName ?? "Staff"} · internal note`
    : auto
      ? "Automatic reply"
      : ours
        ? `${m.staffName ?? m.fromName ?? "Yiggybean"} (reply)`
        : m.fromName
          ? `${m.fromName} <${m.fromEmail}>`
          : m.fromEmail;
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
        <span style={small}>
          {fmt(m.sentAt)}
          {m.editedAt ? ` · edited ${fmt(m.editedAt)}${m.editedBy && m.editedBy !== m.staffName ? ` by ${m.editedBy}` : ""}` : ""}
        </span>
        {canEdit && !editing && (
          <button type="button" style={{ ...linkStyle, fontSize: "12px" }} onClick={() => (setDraft(m.body), setEditing(true))}>
            Edit
          </button>
        )}
      </div>
      {!note && m.cc && <span style={small}>Cc: {m.cc}</span>}
      {editing ? (
        <div style={{ display: "grid", gap: "6px" }}>
          <textarea aria-label="Edit note" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} style={{ ...field, width: "100%", boxSizing: "border-box", resize: "vertical", fontSize: "14px" }} />
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button type="button" style={dark} disabled={ed.state !== "idle" || !draft.trim()} onClick={() => ed.submit({ intent: "editNote", messageId: String(m.id), text: draft }, { method: "post" })}>
              {ed.state !== "idle" ? "Saving…" : "Save note"}
            </button>
            <button type="button" style={btn} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {ed.data?.error && <span style={{ color: "#8e1f0b", fontSize: "13px" }}>{ed.data.error}</span>}
          </div>
        </div>
      ) : m.html ? (
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
function RichEditor({ initial = "", onChange, placeholder, label, minHeight = "130px", apiRef }) {
  const ref = useRef(null);
  if (apiRef) {
    apiRef.current = {
      insert: (text) => {
        ref.current?.focus();
        if (saved.current) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(saved.current);
        }
        document.execCommand("insertText", false, text);
        onChange?.(ref.current?.innerHTML ?? "");
      },
    };
  }
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

// ---- Email templates -------------------------------------------------------

function TemplateDesigner({ data }) {
  const list = data.templates ?? [];
  const [key, setKey] = useState(list[0]?.key ?? null);
  const tpl = list.find((t) => t.key === key) ?? list[0];
  if (!tpl) return <div style={muted}>Loading templates…</div>;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr)", gap: "16px", alignItems: "start" }}>
      <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", overflow: "hidden" }}>
        {list.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setKey(t.key)}
            style={{
              display: "grid",
              gap: "3px",
              width: "100%",
              textAlign: "left",
              padding: "10px 12px",
              border: "none",
              borderBottom: "1px solid #f0f0f0",
              background: t.key === tpl.key ? "#f1f6ff" : "#fff",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: "13px" }}>{t.name}</span>
            <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              {t.live ? (
                <span style={{ ...tagStyle, ...(t.enabled ? { background: "#d9f2df", color: "#1a5e20" } : {}) }}>{t.enabled ? "On" : "Off"}</span>
              ) : (
                <span style={tagStyle}>Not sent yet</span>
              )}
              {t.customized && <span style={small}>edited</span>}
            </span>
          </button>
        ))}
      </div>
      <TemplateEditor key={`${tpl.key}:${tpl.updatedAt ?? "default"}`} tpl={tpl} data={data} />
    </div>
  );
}

const tagStyle = { background: "#ebebeb", color: "#4a4a4a", padding: "1px 8px", borderRadius: "8px", fontSize: "12px", fontWeight: 600 };

function TemplateEditor({ tpl, data }) {
  const save = useFetcher();
  const test = useFetcher();
  const [subject, setSubject] = useState(tpl.subject);
  const [html, setHtml] = useState(tpl.html);
  const [enabled, setEnabled] = useState(tpl.enabled);
  const [target, setTarget] = useState("body"); // where Insert puts a variable
  const editor = useRef(null);
  const subjectRef = useRef(null);
  const canEdit = data.isAdmin;
  const dirty = subject !== tpl.subject || html !== tpl.html || enabled !== tpl.enabled;
  const samples = sampleValues();
  const unknown = unknownVariables(subject, html);
  const insert = (name) => {
    const token = `{{${name}}}`;
    if (target === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const start = el.selectionStart ?? subject.length;
      const end = el.selectionEnd ?? subject.length;
      const next = subject.slice(0, start) + token + subject.slice(end);
      setSubject(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    } else editor.current?.insert(token);
  };
  return (
    <div style={{ display: "grid", gap: "12px" }}>
      <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", padding: "14px", display: "grid", gap: "10px" }}>
        <div style={{ display: "grid", gap: "2px" }}>
          <strong style={{ fontSize: "15px" }}>{tpl.name}</strong>
          <span style={muted}>{tpl.description}</span>
          {!tpl.live && <span style={{ ...small, color: "#7a4f01" }}>Not sent yet: status-change emails are switched on in a later update. You can write it now.</span>}
          {tpl.updatedBy && <span style={small}>Last edited by {tpl.updatedBy} {fmt(tpl.updatedAt)}</span>}
        </div>
        {tpl.live && (
          <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
            <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
            Send this automatically
            <span style={small}>(once per customer every 12 hours; never to mailing lists, no-reply addresses or other auto-replies)</span>
          </label>
        )}
        <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
          <span style={muted}>Subject</span>
          <input
            ref={subjectRef}
            value={subject}
            disabled={!canEdit}
            onFocus={() => setTarget("subject")}
            onChange={(e) => setSubject(e.target.value)}
            style={{ ...field, fontSize: "14px" }}
          />
        </label>
        <div style={{ display: "grid", gap: "4px", fontSize: "13px" }} onFocusCapture={(e) => e.target !== subjectRef.current && setTarget("body")}>
          <span style={muted}>Email</span>
          {canEdit ? (
            <RichEditor initial={tpl.html} onChange={setHtml} label="Email body" apiRef={editor} minHeight="180px" />
          ) : (
            <div className="tk-html" style={{ border: "1px solid #eee", borderRadius: "8px", padding: "10px" }} dangerouslySetInnerHTML={{ __html: tpl.html }} />
          )}
        </div>
        {canEdit && (
          <div style={{ display: "grid", gap: "6px" }}>
            <span style={{ ...small, fontWeight: 600 }}>Insert a variable into the {target === "subject" ? "subject" : "email"}:</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {VARIABLES.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  title={`{{${v.name}}}: e.g. ${v.sample}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(v.name)}
                  style={{ ...btn, padding: "2px 8px", fontSize: "12px", background: "#f6f6f6" }}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <span style={small}>
              Write a fallback for empty values like <code>{'{{customer.first_name | default: "there"}}'}</code>.
            </span>
          </div>
        )}
        {unknown.length > 0 && <span style={{ color: "#8e1f0b", fontSize: "13px" }}>Not a variable: {unknown.map((u) => `{{${u}}}`).join(", ")}. It would be sent as typed.</span>}
        {canEdit ? (
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              style={dark}
              disabled={!dirty || save.state !== "idle"}
              onClick={() => save.submit({ intent: "saveTemplate", key: tpl.key, subject, html, enabled: String(enabled) }, { method: "post" })}
            >
              {save.state !== "idle" ? "Saving…" : "Save template"}
            </button>
            <button type="button" style={btn} disabled={test.state !== "idle"} onClick={() => test.submit({ intent: "testTemplate", subject, html }, { method: "post" })}>
              {test.state !== "idle" ? "Sending…" : "Send a test to me"}
            </button>
            {tpl.customized && (
              <button type="button" style={{ ...linkStyle, fontSize: "13px" }} onClick={() => save.submit({ intent: "resetTemplate", key: tpl.key }, { method: "post" })}>
                Reset to the original wording
              </button>
            )}
            {dirty && <span style={small}>Unsaved changes</span>}
            {save.data?.error && <span style={{ color: "#8e1f0b" }}>{save.data.error}</span>}
            {test.data?.sentTo && <span style={{ color: "#1a5e20", fontSize: "13px" }}>Test sent to {test.data.sentTo}</span>}
            {test.data?.error && <span style={{ color: "#8e1f0b", fontSize: "13px" }}>{test.data.error}</span>}
          </div>
        ) : (
          <span style={small}>Only app admins can change email templates.</span>
        )}
      </div>
      <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid #eee", background: "#fafafa", fontSize: "13px", display: "grid", gap: "2px" }}>
          <span style={small}>Preview with a sample customer</span>
          <span>
            <span style={muted}>From:</span> {data.mailbox}
          </span>
          <span>
            <span style={muted}>To:</span> {samples["customer.name"]} &lt;{samples["customer.email"]}&gt;
          </span>
          <span>
            <span style={muted}>Subject:</span> <strong>{renderTemplate(subject, samples)}</strong>
          </span>
        </div>
        <div
          className="tk-html"
          style={{ padding: "14px", fontFamily: "Arial, Helvetica, sans-serif", fontSize: "14px", lineHeight: 1.5 }}
          dangerouslySetInnerHTML={{ __html: renderTemplate(html, samples, { html: true }) }}
        />
      </div>
    </div>
  );
}

function CustomerPanel({ ticket }) {
  const f = useFetcher();
  const email = ticket.customerEmail;
  const submit = useRef(f.submit);
  submit.current = f.submit;
  const [fly, setFly] = useState(null); // { kind: "customer" | "order", id }
  useEffect(() => {
    if (email) submit.current({ intent: "customer", email }, { method: "post" });
  }, [email]);
  const c = f.data?.intent === "customer" ? f.data.customer : undefined;
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "12px", background: "#fff", padding: "12px 14px", display: "grid", gap: "8px", fontSize: "13px" }}>
      <strong>Customer</strong>
      <span style={{ overflowWrap: "anywhere" }}>
        {ticket.customerName && (
          <>
            {ticket.customerName}
            <br />
          </>
        )}
        <span style={muted}>{email}</span>
      </span>
      {f.state !== "idle" && c === undefined && <span style={muted}>Looking them up…</span>}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      {c === null && <span style={muted}>No Shopify customer with this email.</span>}
      {c && (
        <>
          <button type="button" style={{ ...linkStyle, textAlign: "left" }} onClick={() => setFly({ kind: "customer", id: c.id })}>
            {c.name || c.email}: customer details
          </button>
          <span style={muted}>
            {c.orders ?? 0} order{c.orders === 1 ? "" : "s"}
            {c.spent ? ` · ${c.spent} spent` : ""}
          </span>
          {c.tags.length > 0 && <span style={small}>{c.tags.join(", ")}</span>}
          {c.recent.length > 0 && (
            <div style={{ display: "grid", gap: "6px", marginTop: "4px" }}>
              <span style={{ ...small, fontWeight: 600 }}>Recent orders</span>
              {c.recent.map((o) => (
                <OrderRow key={o.id} o={o} onOpen={() => setFly({ kind: "order", id: o.id })} />
              ))}
            </div>
          )}
        </>
      )}
      {fly?.kind === "customer" && <CustomerFlyout id={fly.id} onClose={() => setFly(null)} onOrder={(id) => setFly({ kind: "order", id, back: fly })} />}
      {fly?.kind === "order" && (
        <OrderFlyout
          id={fly.id}
          onClose={() => setFly(null)}
          onBack={fly.back ? () => setFly(fly.back) : null}
          onCustomer={(id) => setFly({ kind: "customer", id })}
        />
      )}
    </div>
  );
}

function OrderRow({ o, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ display: "grid", gap: "1px", width: "100%", textAlign: "left", font: "inherit", fontSize: "13px", color: "inherit", background: "#fff", cursor: "pointer", padding: "6px 8px", border: "1px solid #eee", borderRadius: "8px" }}
    >
      <span style={{ display: "flex", justifyContent: "space-between", gap: "6px" }}>
        <span style={{ color: "#005bd3", fontWeight: 600 }}>{o.name}</span>
        <span>{o.total}</span>
      </span>
      <span style={small}>
        {new Date(o.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · {o.cancelled ? "Cancelled" : `${titleCase(o.paid)} · ${titleCase(o.fulfilled)}`}
      </span>
    </button>
  );
}

// Loads one thing for a flyout when it opens
function useDetail(intent, key, id) {
  const f = useFetcher();
  const submit = useRef(f.submit);
  submit.current = f.submit;
  useEffect(() => {
    if (id) submit.current({ intent, [key]: id }, { method: "post" });
  }, [intent, key, id]);
  return { data: f.data?.intent === intent ? f.data : null, loading: f.state !== "idle" || !f.data };
}

const section = { display: "grid", gap: "6px", paddingBottom: "14px", marginBottom: "14px", borderBottom: "1px solid #eee", fontSize: "13px" };
const heading = { fontSize: "12px", fontWeight: 600, color: "#616161", textTransform: "uppercase", letterSpacing: "0.03em" };

function CustomerFlyout({ id, onClose, onOrder }) {
  const { data, loading } = useDetail("customerDetail", "customerId", id);
  const c = data?.customer;
  return (
    <Flyout onClose={onClose} label="Customer" title={c?.name || "Customer"} width={460}>
      {loading && !c && <span style={muted}>Loading…</span>}
      {data?.error && <span style={{ color: "#8e1f0b" }}>{data.error}</span>}
      {c && (
        <>
          <div style={section}>
            {c.email && (
              <a href={`mailto:${c.email}`} style={{ color: "#005bd3" }}>
                {c.email}
              </a>
            )}
            {c.phone && <span>{c.phone}</span>}
            <span style={muted}>
              {c.orders ?? 0} order{c.orders === 1 ? "" : "s"}
              {c.spent ? ` · ${c.spent} spent` : ""} · customer since {new Date(c.since).toLocaleDateString("en-US", { month: "short", year: "numeric" })}
            </span>
            {c.tags.length > 0 && <span style={small}>Tags: {c.tags.join(", ")}</span>}
            <a href={c.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
              Open in Shopify ↗
            </a>
          </div>
          {c.address.length > 0 && (
            <div style={section}>
              <span style={heading}>Default address</span>
              <span style={{ whiteSpace: "pre-line" }}>{c.address.join("\n")}</span>
            </div>
          )}
          {c.note && (
            <div style={section}>
              <span style={heading}>Note</span>
              <span style={{ whiteSpace: "pre-wrap" }}>{c.note}</span>
            </div>
          )}
          <div style={{ ...section, borderBottom: "none" }}>
            <span style={heading}>Orders</span>
            {c.recent.length === 0 && <span style={muted}>No orders.</span>}
            {c.recent.map((o) => (
              <OrderRow key={o.id} o={o} onOpen={() => onOrder(o.id)} />
            ))}
          </div>
        </>
      )}
    </Flyout>
  );
}

function OrderFlyout({ id, onClose, onBack, onCustomer }) {
  const { data, loading } = useDetail("orderDetail", "orderId", id);
  const o = data?.order;
  const line = (label, value, strong) =>
    value ? (
      <span style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontWeight: strong ? 600 : 400 }}>
        <span style={strong ? {} : muted}>{label}</span>
        <span>{value}</span>
      </span>
    ) : null;
  return (
    <Flyout onClose={onClose} label="Order" title={o ? `Order ${o.name}` : "Order"} width={520}>
      {onBack && (
        <button type="button" style={{ ...linkStyle, fontSize: "13px", marginBottom: "10px" }} onClick={onBack}>
          ← Back to customer
        </button>
      )}
      {loading && !o && <span style={muted}>Loading…</span>}
      {data?.error && <span style={{ color: "#8e1f0b" }}>{data.error}</span>}
      {o && (
        <>
          <div style={section}>
            <span style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
              <span>{new Date(o.at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              {o.cancelled ? (
                <Pill tone="red">Cancelled{o.cancelled.reason ? ` (${titleCase(o.cancelled.reason)})` : ""}</Pill>
              ) : (
                <>
                  <Pill tone={/PAID/i.test(o.paid ?? "") && !/PARTIALLY|UN/i.test(o.paid ?? "") ? "green" : "yellow"}>{titleCase(o.paid)}</Pill>
                  <Pill tone={/^FULFILLED$/i.test(o.fulfilled ?? "") ? "green" : "yellow"}>{titleCase(o.fulfilled)}</Pill>
                </>
              )}
            </span>
            {o.customer && (
              <button type="button" style={{ ...linkStyle, textAlign: "left", fontSize: "13px" }} onClick={() => onCustomer(o.customer.id)}>
                {o.customer.name}
              </button>
            )}
            <a href={o.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
              Open in Shopify ↗
            </a>
          </div>
          <div style={section}>
            <span style={heading}>Items</span>
            {o.items.map((l) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) auto", gap: "8px", alignItems: "center", opacity: l.current === 0 ? 0.55 : 1 }}>
                {l.image ? (
                  <img src={l.image} alt="" width={44} height={44} style={{ objectFit: "cover", borderRadius: "6px", border: "1px solid #eee" }} />
                ) : (
                  <span style={{ width: 44, height: 44, borderRadius: "6px", background: "#f3f3f3" }} />
                )}
                <span style={{ display: "grid" }}>
                  <span style={{ textDecoration: l.current === 0 ? "line-through" : "none" }}>{l.title}</span>
                  <span style={small}>
                    {[l.variant, l.sku].filter(Boolean).join(" · ")}
                    {l.current !== l.qty ? ` · ${l.qty - l.current} removed or refunded` : ""}
                  </span>
                </span>
                <span style={{ whiteSpace: "nowrap" }}>
                  {l.current} × {l.price}
                </span>
              </div>
            ))}
          </div>
          <div style={section}>
            {line("Subtotal", o.totals.subtotal)}
            {line("Discounts", o.totals.discounts && `−${o.totals.discounts}`)}
            {line(`Shipping${o.shippingMethod ? ` (${o.shippingMethod})` : ""}`, o.totals.shipping)}
            {line("Tax", o.totals.tax)}
            {line("Total", o.totals.total, true)}
            {line("Refunded", o.totals.refunded && `−${o.totals.refunded}`)}
          </div>
          <div style={section}>
            <span style={heading}>Shipping</span>
            {o.shipTo.length > 0 ? <span style={{ whiteSpace: "pre-line" }}>{o.shipTo.join("\n")}</span> : <span style={muted}>No shipping address.</span>}
            {o.fulfillments.length === 0 && <span style={muted}>Not shipped yet.</span>}
            {o.fulfillments.map((fl, i) => (
              <div key={i} style={{ display: "grid", gap: "2px", padding: "6px 8px", border: "1px solid #eee", borderRadius: "8px" }}>
                <span>
                  {titleCase(fl.status)} · {new Date(fl.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                {fl.tracking.map((t, j) =>
                  t.url ? (
                    <a key={j} href={t.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                      {t.company ? `${t.company} ` : ""}
                      {t.number} ↗
                    </a>
                  ) : (
                    <span key={j}>
                      {t.company ? `${t.company} ` : ""}
                      {t.number}
                    </span>
                  ),
                )}
              </div>
            ))}
          </div>
          {(o.note || o.tags.length > 0) && (
            <div style={{ ...section, borderBottom: "none" }}>
              {o.note && (
                <>
                  <span style={heading}>Order note</span>
                  <span style={{ whiteSpace: "pre-wrap" }}>{o.note}</span>
                </>
              )}
              {o.tags.length > 0 && <span style={small}>Tags: {o.tags.join(", ")}</span>}
            </div>
          )}
        </>
      )}
    </Flyout>
  );
}

const PILL = { green: ["#d9f2df", "#1a5e20"], yellow: ["#fff1d6", "#7a4f01"], red: ["#fde2dd", "#8e1f0b"] };
function Pill({ tone, children }) {
  const [bg, fg] = PILL[tone] ?? PILL.yellow;
  return <span style={{ background: bg, color: fg, padding: "1px 8px", borderRadius: "8px", fontSize: "12px", fontWeight: 600 }}>{children}</span>;
}

const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
