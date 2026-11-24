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
  linkCustomer,
  searchCustomers,
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
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, attachmentProblem, fileSize, STATUS_LABELS, VARIABLES, renderTemplate, sampleValues, unknownVariables } from "../tickets";
import { emailDocument, sanitizeHtml } from "../email-html";
import { OrderFlyout as SharedOrderFlyout } from "../components/OrderPanel";
import { AddressError, changeAddresses, openOrders } from "../address-change.server";

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
    if (intent === "customer") return { intent, customer: await customerFor(shop, admin, String(form.get("email") ?? ""), form.get("linkedId") || null) };
    if (intent === "searchCustomers") return { intent, results: await searchCustomers(admin, form.get("q")) };
    if (intent === "customerDetail") return { intent, customer: await customerDetail(shop, admin, String(form.get("customerId") ?? "")) };
    if (intent === "orderDetail") return { intent, order: await orderDetail(shop, admin, String(form.get("orderId") ?? "")) };
    if (intent === "attachment") return { intent, i: Number(form.get("index")), file: await attachment(shop, form.get("messageId"), form.get("index")) };
    if (intent === "connect" || intent === "pause" || intent === "resume") {
      if (!user?.isAdmin) return { intent, error: "Only app admins can connect or pause the mailbox." };
      if (intent === "connect") return { intent, ok: true, ...(await connect(shop)) };
      await pause(shop, intent === "pause");
      return { intent, ok: true };
    }
    if (intent === "syncNow") return { intent, ok: true, ...(await sync(shop)) };
    if (!can(user, "tickets", "reply")) return denied("tickets", "reply");
    if (intent === "reply") {
      // Attached files (return labels, photos…), sent with the email
      const files = [];
      for (const f of form.getAll("files")) {
        if (!f || typeof f === "string" || !f.size) continue;
        files.push({ name: String(f.name || "attachment").slice(0, 200), type: f.type || "", content: Buffer.from(await f.arrayBuffer()) });
      }
      await reply(shop, id, form.get("html"), user, { status: String(form.get("status") || "waiting"), signature: form.get("signature") !== "false", files });
      return { intent, ok: true, attached: files.length };
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
    if (intent === "openOrders") return { intent, ...(await openOrders(shop, admin, String(form.get("customerId") ?? ""))) };
    if (intent === "changeAddresses") {
      let orderIds = [];
      let address = {};
      try {
        orderIds = JSON.parse(String(form.get("orderIds") ?? "[]"));
        address = JSON.parse(String(form.get("address") ?? "{}"));
      } catch {
        return { intent, error: "Something was wrong with the form. Reload and try again." };
      }
      return { intent, ok: true, ...(await changeAddresses(shop, admin, { ticketId: id, customerId: String(form.get("customerId") ?? ""), orderIds, address, user })) };
    }
    if (intent === "linkCustomer") {
      const cid = form.get("customerId");
      await linkCustomer(shop, id, cid ? { id: cid, name: form.get("name") || null, email: form.get("email") || null } : null, user);
      return { intent, ok: true };
    }
    if (intent === "note") return (await addNote(shop, id, form.get("text"), user), { intent, ok: true });
    if (intent === "update") return (await updateTicket(shop, id, { status: String(form.get("status") ?? ""), staffId: Number(form.get("staffId")) || null }), { intent, ok: true });
    if (intent === "status") return (await setStatus(shop, id, String(form.get("status") ?? "")), { intent, ok: true });
    if (intent === "assign") return (await assign(shop, id, Number(form.get("staffId")) || null), { intent, ok: true });
    if (intent === "assignMe") return (await assign(shop, id, user?.id), { intent, ok: true });
    return { intent, error: "Unknown action." };
  } catch (e) {
    const known = e instanceof HelpdeskError || e instanceof AddressError;
    if (!known) console.error(`[tickets] ${intent}:`, e);
    return { intent, error: known ? e.message : `Something went wrong: ${e?.message ?? e}` };
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
      <CustomerPanel ticket={ticket} canEdit={data.canReply} />
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
  const [viewing, setViewing] = useState(null); // index of the image open in the viewer
  const images = m.attachments.filter(isImage);
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
              title={isImage(a) ? "View" : "Download"}
              style={{ ...btn, padding: "3px 10px", fontSize: "12px" }}
              disabled={!isImage(a) && dl.state !== "idle"}
              onClick={() => (isImage(a) ? setViewing(a.i) : dl.submit({ intent: "attachment", messageId: String(m.id), index: String(a.i) }, { method: "post" }))}
            >
              {isImage(a) ? "🖼" : "📎"} {a.name}
              {a.size ? ` (${Math.max(1, Math.round(a.size / 1024))} KB)` : ""}
            </button>
          ))}
          {dl.data?.error && <span style={{ color: "#8e1f0b", fontSize: "12px" }}>{dl.data.error}</span>}
        </div>
      )}
      {viewing != null && <ImageViewer messageId={m.id} images={images} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// Pictures a browser can show (phones sometimes send them without a type)
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const isImage = (a) => /^image\/(jpeg|png|gif|webp|bmp|avif)$/i.test(a.mime ?? "") || ((!a.mime || a.mime === "application/octet-stream") && IMAGE_EXT.test(a.name ?? ""));

const fileUrl = (f) => {
  const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
  const type = /^image\//.test(f.mime) ? f.mime : `image/${(f.name.match(IMAGE_EXT)?.[1] ?? "jpeg").toLowerCase().replace("jpg", "jpeg")}`;
  return URL.createObjectURL(new Blob([bytes], { type }));
};

// A message's pictures, shown over the ticket. ← → between them, Escape or a
// click outside to close.
function ImageViewer({ messageId, images, start, onClose }) {
  const f = useFetcher();
  const [at, setAt] = useState(() => Math.max(0, images.findIndex((a) => a.i === start)));
  const [urls, setUrls] = useState({}); // attachment index → object URL
  const [zoom, setZoom] = useState(false);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  const a = images[at];
  const submit = useRef(f.submit);
  submit.current = f.submit;
  useEffect(() => {
    if (a && !urlsRef.current[a.i]) submit.current({ intent: "attachment", messageId: String(messageId), index: String(a.i) }, { method: "post" });
    setZoom(false);
  }, [a, messageId]);
  useEffect(() => {
    if (f.data?.file && f.data.i != null && !urlsRef.current[f.data.i]) setUrls((u) => ({ ...u, [f.data.i]: fileUrl(f.data.file) }));
  }, [f.data]);
  useEffect(() => () => Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u)), []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setAt((n) => Math.min(images.length - 1, n + 1));
      if (e.key === "ArrowLeft") setAt((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [images.length, onClose]);
  if (!a) return null;
  const url = urls[a.i];
  const failed = f.state === "idle" && f.data?.error && !url;
  const ctl = { ...btn, background: "rgba(255,255,255,.95)", padding: "4px 12px" };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={a.name}
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,.72)", display: "grid", gridTemplateRows: "auto 1fr", padding: "14px", boxSizing: "border-box" }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: "8px", alignItems: "center", color: "#fff", fontSize: "13px", justifySelf: "center", maxWidth: "100%", flexWrap: "wrap", justifyContent: "center" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "50vw" }}>{a.name}</span>
        {images.length > 1 && (
          <span>
            {at + 1} of {images.length}
          </span>
        )}
        {url && (
          <a href={url} download={a.name} style={{ ...ctl, color: "#303030", textDecoration: "none" }}>
            Download
          </a>
        )}
        <button type="button" aria-label="Close" style={ctl} onClick={onClose}>
          ✕
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0, gap: "10px" }}>
        {images.length > 1 && (
          <button type="button" aria-label="Previous picture" disabled={at === 0} style={{ ...ctl, fontSize: "18px", opacity: at === 0 ? 0.4 : 1 }} onClick={(e) => (e.stopPropagation(), setAt(at - 1))}>
            ‹
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: zoom ? "auto" : "hidden" }}>
          {url ? (
            <img
              src={url}
              alt={a.name}
              title={zoom ? "Click to fit" : "Click for full size"}
              onClick={(e) => (e.stopPropagation(), setZoom(!zoom))}
              style={zoom ? { maxWidth: "none", cursor: "zoom-out", alignSelf: "flex-start" } : { maxWidth: "100%", maxHeight: "calc(100vh - 90px)", objectFit: "contain", cursor: "zoom-in", borderRadius: "4px", boxShadow: "0 4px 24px rgba(0,0,0,.4)" }}
            />
          ) : failed ? (
            <span style={{ color: "#fff" }} onClick={(e) => e.stopPropagation()}>{f.data.error}</span>
          ) : (
            <span style={{ color: "#fff" }}>Loading…</span>
          )}
        </div>
        {images.length > 1 && (
          <button
            type="button"
            aria-label="Next picture"
            disabled={at === images.length - 1}
            style={{ ...ctl, fontSize: "18px", opacity: at === images.length - 1 ? 0.4 : 1 }}
            onClick={(e) => (e.stopPropagation(), setAt(at + 1))}
          >
            ›
          </button>
        )}
      </div>
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
  // Files to send with the reply
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef(null);
  const addFiles = (list) => {
    const incoming = [...(list ?? [])].filter((x) => x && x.size !== undefined);
    if (!incoming.length) return;
    // The same file twice is attached once
    setFiles((cur) => [...cur, ...incoming.filter((x) => !cur.some((c) => c.name === x.name && c.size === x.size))]);
  };
  const fileProblem = attachmentProblem(files);
  const busy = f.state !== "idle";
  useEffect(() => {
    if (f.state === "idle" && f.data?.ok && (f.data.intent === "reply" || f.data.intent === "note")) {
      setText("");
      setHtml("");
      setFiles([]);
      setEditorKey((k) => k + 1);
    }
  }, [f.state, f.data]);
  const empty = mode === "note" ? !text.trim() : !htmlHasText(html) && !files.length;
  const send = () => {
    if (empty) return;
    if (mode === "note") return f.submit({ intent: "note", id: String(ticket.id), text }, { method: "post" });
    if (fileProblem) return;
    const fields = { intent: "reply", id: String(ticket.id), html, status: after, signature: withSig && sig ? "true" : "false" };
    if (!files.length) return f.submit(fields, { method: "post" });
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const file of files) form.append("files", file, file.name);
    f.submit(form, { method: "post", encType: "multipart/form-data" });
  };
  return (
    <div
      onDragOver={(e) => {
        if (mode !== "reply" || ![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        if (mode !== "reply" || !e.dataTransfer?.files?.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
      style={{
        border: `1px ${dragging ? "dashed" : "solid"} ${dragging ? "#005bd3" : mode === "note" ? "#ecd58f" : "#c9c9c9"}`,
        background: dragging ? "#f0f6ff" : mode === "note" ? "#fffbea" : "#fff",
        borderRadius: "12px",
        padding: "10px 12px",
        display: "grid",
        gap: "8px",
      }}
    >
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
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              aria-label="Attach files"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" style={{ ...btn, padding: "3px 10px", fontSize: "12px" }} disabled={busy} onClick={() => picker.current?.click()}>
              📎 Attach files
            </button>
            {!files.length && (
              <span style={{ fontSize: "12px", color: "#616161" }}>
                or drop them here. Return labels, photos, PDFs; up to {ATTACH_MAX_FILES} files, {fileSize(ATTACH_MAX_BYTES)} in all.
              </span>
            )}
            {files.map((file, i) => (
              <span
                key={`${file.name}-${i}`}
                style={{ display: "inline-flex", gap: "6px", alignItems: "center", padding: "2px 4px 2px 10px", border: "1px solid #ddd", borderRadius: "999px", fontSize: "12px", background: "#f6f6f7" }}
              >
                {/^image\//.test(file.type) ? "🖼" : "📄"} {file.name} <span style={{ color: "#616161" }}>{fileSize(file.size)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  disabled={busy}
                  onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  style={{ appearance: "none", border: 0, background: "none", cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: "0 4px", color: "#616161" }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {fileProblem && <span style={{ color: "#8e1f0b", fontSize: "13px" }}>{fileProblem}</span>}
        </>
      )}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" style={dark} disabled={busy || empty || (mode === "reply" && Boolean(fileProblem))} onClick={send}>
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
  const [mode, setMode] = useState(() => (/<(table|td|center|font)\b|style="/i.test(tpl.html) ? "html" : "visual"));
  const [visualKey, setVisualKey] = useState(0); // remount the visual editor with the code's latest
  const editor = useRef(null);
  const codeRef = useRef(null);
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
    } else if (mode === "html" && codeRef.current) {
      const el = codeRef.current;
      const start = el.selectionStart ?? html.length;
      const end = el.selectionEnd ?? html.length;
      setHtml(html.slice(0, start) + token + html.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    } else editor.current?.insert(token);
  };
  const switchTo = (m) => {
    if (m === "visual") setVisualKey((k) => k + 1);
    setMode(m);
  };
  const tab = (on) => ({ ...btn, padding: "2px 10px", fontSize: "12px", ...(on ? { background: "#303030", color: "#fff", border: "1px solid #303030" } : { border: "1px solid #c9c9c9" }) });
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
            <span style={small}>(one per new ticket; never to mailing lists, no-reply addresses or other auto-replies)</span>
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
          <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <span style={muted}>Email</span>
            {canEdit && (
              <span style={{ display: "flex", gap: "4px", marginLeft: "auto" }}>
                <button type="button" style={tab(mode === "visual")} onClick={() => switchTo("visual")}>
                  Visual
                </button>
                <button type="button" style={tab(mode === "html")} onClick={() => switchTo("html")}>
                  HTML
                </button>
              </span>
            )}
          </span>
          {canEdit && mode === "html" ? (
            <>
              <textarea
                ref={codeRef}
                aria-label="Email HTML"
                value={html}
                spellCheck={false}
                onChange={(e) => setHtml(e.target.value)}
                style={{ ...field, minHeight: "260px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "12px", lineHeight: 1.45, whiteSpace: "pre", overflow: "auto", resize: "vertical" }}
              />
              <span style={small}>
                Tables, inline styles (style="…"), colors and images from https addresses work. &lt;style&gt; blocks, scripts and forms are removed when saved, as most email apps
                ignore them anyway. The preview shows exactly what will be sent.
              </span>
            </>
          ) : canEdit ? (
            <RichEditor key={visualKey} initial={html} onChange={setHtml} label="Email body" apiRef={editor} minHeight="180px" />
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
        <EmailFrame html={sanitizeHtml(renderTemplate(html, samples, { html: true }), { email: true })} />
      </div>
    </div>
  );
}

// One new shipping address onto several of the customer's open orders
const ADDRESS_INPUTS = [
  ["firstName", "First name", 1],
  ["lastName", "Last name", 1],
  ["company", "Company", 2],
  ["address1", "Address", 2],
  ["address2", "Apartment, suite, etc.", 2],
  ["city", "City", 2],
  ["provinceCode", "State / province code", 1, "e.g. CA"],
  ["zip", "ZIP / postal code", 1],
  ["countryCode", "Country code", 1, "e.g. US"],
  ["phone", "Phone", 1],
];

function AddressFlyout({ ticketId, customerId, onClose }) {
  const load = useFetcher();
  const save = useFetcher();
  const [form, setForm] = useState(null);
  const [chosen, setChosen] = useState(null); // Set of order ids
  const [confirming, setConfirming] = useState(false);
  const submit = useRef(load.submit);
  submit.current = load.submit;
  const reload = () => submit.current({ intent: "openOrders", customerId }, { method: "post" });
  useEffect(() => {
    reload();
  }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = load.data?.intent === "openOrders" ? load.data : null;
  useEffect(() => {
    if (!data?.orders) return;
    setForm((f) => f ?? data.start);
    setChosen(new Set(data.orders.filter((o) => !o.locked).map((o) => o.id)));
  }, [data]);
  const done = save.data?.intent === "changeAddresses" && save.data.ok ? save.data : null;
  useEffect(() => {
    if (done) {
      setConfirming(false);
      reload();
    }
  }, [done]);
  const count = chosen?.size ?? 0;
  const go = () =>
    save.submit({ intent: "changeAddresses", id: String(ticketId), customerId, orderIds: JSON.stringify([...chosen]), address: JSON.stringify(form) }, { method: "post" });
  return (
    <Flyout onClose={onClose} label="Change shipping address" title="Change shipping address" width={520}>
      <div style={{ display: "grid", gap: "14px", fontSize: "13px" }}>
        {!data && !load.data?.error && <span style={muted}>Loading open orders…</span>}
        {load.data?.error && <span style={{ color: "#8e1f0b" }}>{load.data.error}</span>}
        {done && (
          <div style={{ display: "grid", gap: "4px", padding: "8px 10px", borderRadius: "8px", background: done.changed ? "#eaf6ec" : "#fdecea" }}>
            <strong>{done.changed ? `Changed ${done.changed} order${done.changed === 1 ? "" : "s"} in Shopify.` : "No orders were changed."}</strong>
            {done.results.map((r) => (
              <span key={r.id} style={{ color: r.ok ? "#1a5e20" : "#8e1f0b" }}>
                {r.name ?? r.id}: {r.ok ? "changed" : r.error}
                {r.ok && r.warning ? ` (${r.warning})` : ""}
              </span>
            ))}
            <span style={small}>A note with the old addresses was added to the ticket.</span>
          </div>
        )}
        {data && data.orders.length === 0 && <span style={muted}>{data.customer.name} has no open orders to change.</span>}
        {data && data.orders.length > 0 && form && chosen && (
          <>
            <div style={section}>
              <span style={heading}>Open orders</span>
              {data.orders.map((o) => (
                <label key={o.id} style={{ display: "flex", gap: "8px", alignItems: "flex-start", padding: "6px 8px", border: "1px solid #eee", borderRadius: "8px", opacity: o.locked ? 0.6 : 1 }}>
                  <input
                    type="checkbox"
                    disabled={Boolean(o.locked)}
                    checked={chosen.has(o.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      e.target.checked ? next.add(o.id) : next.delete(o.id);
                      setChosen(next);
                      setConfirming(false);
                    }}
                    style={{ marginTop: "2px" }}
                  />
                  <span style={{ display: "grid", gap: "2px", minWidth: 0 }}>
                    <span>
                      <strong>{o.name}</strong> <span style={small}>{fmt(o.at)}</span>
                    </span>
                    <span style={{ ...small, overflowWrap: "anywhere" }}>{o.address ?? "No shipping address"}</span>
                    {o.locked && <span style={{ ...small, color: "#8e1f0b" }}>{o.locked}</span>}
                    {!o.locked && o.warning && <span style={{ ...small, color: "#7a4f01" }}>{o.warning}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div style={section}>
              <span style={heading}>New address</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                {ADDRESS_INPUTS.map(([k, label, span, ph]) => (
                  <label key={k} style={{ display: "grid", gap: "3px", gridColumn: span === 2 ? "1 / -1" : "auto" }}>
                    <span style={small}>{label}</span>
                    <input
                      value={form[k] ?? ""}
                      placeholder={ph}
                      onChange={(e) => (setForm({ ...form, [k]: e.target.value }), setConfirming(false))}
                      style={{ ...field, width: "100%", boxSizing: "border-box" }}
                    />
                  </label>
                ))}
              </div>
            </div>
            {save.data?.error && <span style={{ color: "#8e1f0b" }}>{save.data.error}</span>}
            {!confirming ? (
              <button type="button" style={{ ...dark, justifySelf: "start" }} disabled={!count} onClick={() => setConfirming(true)}>
                Change {count} order{count === 1 ? "" : "s"}
              </button>
            ) : (
              <div style={{ display: "grid", gap: "8px", padding: "10px", border: "1px solid #ecd58f", background: "#fffbea", borderRadius: "8px" }}>
                <span>
                  This changes the shipping address in Shopify on{" "}
                  <strong>{data.orders.filter((o) => chosen.has(o.id)).map((o) => o.name).join(", ")}</strong>. The customer isn't emailed.
                </span>
                <span style={{ display: "flex", gap: "8px" }}>
                  <button type="button" style={dark} disabled={save.state !== "idle"} onClick={go}>
                    {save.state !== "idle" ? "Changing…" : "Yes, change them"}
                  </button>
                  <button type="button" style={btn} disabled={save.state !== "idle"} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Flyout>
  );
}

// Search Shopify customers (name, email, phone or an order number) and pick one
function CustomerFinder({ busy, onPick, onCancel }) {
  const f = useFetcher();
  const [q, setQ] = useState("");
  const submit = useRef(f.submit);
  submit.current = f.submit;
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return;
    const timer = setTimeout(() => submit.current({ intent: "searchCustomers", q: text }, { method: "post" }), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const results = f.data?.intent === "searchCustomers" ? f.data.results : null;
  return (
    <div style={{ display: "grid", gap: "6px", border: "1px solid #eee", borderRadius: "8px", padding: "8px" }}>
      <input
        autoFocus
        aria-label="Find a customer"
        placeholder="Name, email, phone or order #"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        style={{ ...field, fontSize: "13px" }}
      />
      {f.state !== "idle" && <span style={small}>Searching…</span>}
      {f.data?.error && <span style={{ color: "#8e1f0b" }}>{f.data.error}</span>}
      {results && q.trim().length >= 2 && results.length === 0 && f.state === "idle" && <span style={small}>No customers found.</span>}
      {results?.map((r) => (
        <div key={r.id} style={{ display: "flex", gap: "6px", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid #f1f1f1", paddingTop: "6px" }}>
          <span style={{ display: "grid", minWidth: 0, overflowWrap: "anywhere" }}>
            <strong style={{ fontWeight: 600 }}>{r.name || r.email || "Customer"}</strong>
            <span style={small}>
              {[r.email, r.phone, r.orders != null ? `${r.orders} order${r.orders === 1 ? "" : "s"}` : null, r.order ? `placed ${r.order}` : null].filter(Boolean).join(" · ")}
            </span>
          </span>
          <button type="button" style={{ ...btn, padding: "2px 10px", fontSize: "12px", flexShrink: 0 }} disabled={busy} onClick={() => onPick(r)}>
            Associate
          </button>
        </div>
      ))}
      <button type="button" style={{ ...linkStyle, fontSize: "12px", justifySelf: "start" }} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// The email as the customer sees it, in a frame of its own (no scripts; its
// styles can't touch the page)
function EmailFrame({ html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(200);
  const fit = () => {
    const d = ref.current?.contentDocument;
    if (d?.documentElement) setHeight(Math.min(Math.max(d.documentElement.scrollHeight, 120), 2000));
  };
  const doc = emailDocument(html).replace("<body>", '<head><base target="_blank"></head><body style="margin:0;padding:14px">');
  return <iframe ref={ref} title="Email preview" sandbox="allow-same-origin allow-popups" srcDoc={doc} onLoad={fit} style={{ width: "100%", height: `${height}px`, border: 0, display: "block" }} />;
}

function CustomerPanel({ ticket, canEdit }) {
  const f = useFetcher();
  const link = useFetcher();
  const email = ticket.customerEmail;
  const linkedId = ticket.shopifyCustomerId ?? "";
  const submit = useRef(f.submit);
  submit.current = f.submit;
  const [fly, setFly] = useState(null); // { kind: "customer" | "order", id }
  const [finding, setFinding] = useState(false);
  useEffect(() => {
    if (email || linkedId) submit.current({ intent: "customer", email: email ?? "", linkedId }, { method: "post" });
  }, [email, linkedId]);
  useEffect(() => {
    if (link.state === "idle" && link.data?.ok) setFinding(false);
  }, [link.state, link.data]);
  const c = f.data?.intent === "customer" ? f.data.customer : !email && !linkedId ? null : undefined;
  const choose = (r) => link.submit({ intent: "linkCustomer", id: ticket.id, customerId: r?.id ?? "", name: r?.name ?? "", email: r?.email ?? "" }, { method: "post" });
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
      {c === null && <span style={muted}>{email ? "No Shopify customer with this email." : "No email address on this ticket."}</span>}
      {link.data?.error && <span style={{ color: "#8e1f0b" }}>{link.data.error}</span>}
      {canEdit && c === null && !finding && (
        <button type="button" style={{ ...btn, justifySelf: "start" }} onClick={() => setFinding(true)}>
          Associate customer
        </button>
      )}
      {canEdit && finding && <CustomerFinder busy={link.state !== "idle"} onPick={choose} onCancel={() => setFinding(false)} />}
      {c?.linked && !finding && (
        <span style={small}>
          Associated by hand.{" "}
          {canEdit && (
            <>
              <button type="button" style={{ ...linkStyle, fontSize: "12px" }} onClick={() => setFinding(true)}>
                Change
              </button>
              {" · "}
              <button type="button" style={{ ...linkStyle, fontSize: "12px" }} disabled={link.state !== "idle"} onClick={() => choose(null)}>
                Remove
              </button>
            </>
          )}
        </span>
      )}
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
          {canEdit && (
            <button type="button" style={{ ...btn, justifySelf: "start", fontSize: "12px", padding: "3px 10px" }} onClick={() => setFly({ kind: "address", id: c.id })}>
              Change shipping address on open orders
            </button>
          )}
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
      {fly?.kind === "address" && <AddressFlyout ticketId={ticket.id} customerId={fly.id} onClose={() => setFly(null)} />}
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

// The shared order flyout, with a way back to the customer it was opened from
function OrderFlyout({ id, onClose, onBack, onCustomer }) {
  return (
    <SharedOrderFlyout
      orderId={id}
      onClose={onClose}
      zIndex={1000}
      top={({ order }) =>
        onBack || order?.customer?.id ? (
          <span style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            {onBack && (
              <button type="button" style={{ ...linkStyle, fontSize: "13px" }} onClick={onBack}>
                ← Back to customer
              </button>
            )}
            {!onBack && order?.customer?.id && (
              <button type="button" style={{ ...linkStyle, fontSize: "13px" }} onClick={() => onCustomer(order.customer.id)}>
                Customer details
              </button>
            )}
          </span>
        ) : null
      }
    />
  );
}

const PILL = { green: ["#d9f2df", "#1a5e20"], yellow: ["#fff1d6", "#7a4f01"], red: ["#fde2dd", "#8e1f0b"], blue: ["#e0f0ff", "#00427c"] };
function Pill({ tone, children }) {
  const [bg, fg] = PILL[tone] ?? PILL.yellow;
  return <span style={{ background: bg, color: fg, padding: "1px 8px", borderRadius: "8px", fontSize: "12px", fontWeight: 600 }}>{children}</span>;
}

const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
