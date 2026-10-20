import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import {
  WindowError,
  addProduct,
  listLocations,
  listWindows,
  removeProduct,
  reopenWindow,
  saveWindow,
  searchProducts,
  sellingLocation,
  windowVariants,
} from "../preorder-windows.server";
import { NotifyError, getSettings, recentSends, saveSettings, sendTestEmail } from "../preorder-notify.server";
import { mailStatus } from "../mailer.server";

export const loader = async ({ request }) => {
  const { session, admin, user, noAccess } = await loadWithAccess(request, "preorders", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const [windows, settings, mail, sends, locations] = await Promise.all([
    listWindows(shop),
    getSettings(shop),
    mailStatus(),
    recentSends(shop, 30),
    listLocations(admin).catch(() => []),
  ]);
  return {
    canManage: can(user, "preorders", "manage"),
    windows,
    settings: {
      restockThreshold: settings.restockThreshold,
      reminderHours: settings.reminderHours,
      fromName: settings.fromName ?? "",
      locationId: settings.locationId ?? "",
    },
    locations: locations.map((l) => ({ id: l.id, name: l.name, online: l.fulfillsOnlineOrders })),
    mail,
    sends,
    staffEmail: user?.email ?? "",
  };
};

const NEEDS = {
  search: "view",
  variants: "view",
  add: "manage",
  save: "manage",
  remove: "manage",
  reopen: "manage",
  settings: "manage",
  testEmail: "manage",
};

export const action = async ({ request }) => {
  const { session, admin, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!NEEDS[intent]) return { intent, error: "Unknown action" };
  if (!can(user, "preorders", NEEDS[intent])) return { intent, ...denied("preorders", NEEDS[intent]) };
  const shop = session.shop;
  const id = Number(form.get("id"));

  try {
    if (intent === "search") {
      const q = String(form.get("q") ?? "");
      return { intent, q, results: await searchProducts(shop, admin, q) };
    }
    if (intent === "variants") {
      return { intent, id, variants: await windowVariants(shop, admin, id) };
    }
    if (intent === "add") {
      const w = await addProduct(shop, admin, String(form.get("productId") ?? ""), user);
      return { intent, ok: true, id: w.id, productId: w.productId };
    }
    if (intent === "save") {
      const limits = form.get("limits") ? JSON.parse(String(form.get("limits"))) : null;
      await saveWindow(
        shop,
        admin,
        id,
        { opens: String(form.get("opens") ?? ""), closes: String(form.get("closes") ?? ""), limits },
        user,
      );
      return { intent, ok: true, id };
    }
    if (intent === "reopen") {
      await reopenWindow(
        shop,
        admin,
        id,
        { closes: String(form.get("closes") ?? ""), addUnits: Number(form.get("addUnits") ?? 0) },
        user,
      );
      return { intent, ok: true, id };
    }
    if (intent === "testEmail") {
      const to = String(form.get("to") ?? "").trim();
      await sendTestEmail(shop, to, admin);
      return { intent, ok: true, to };
    }
    if (intent === "remove") {
      await removeProduct(shop, admin, id);
      return { intent, ok: true, id };
    }
    if (intent === "settings") {
      const locationId = String(form.get("locationId") ?? "");
      await saveSettings(shop, {
        restockThreshold: form.get("restockThreshold"),
        reminderHours: form.get("reminderHours"),
        fromName: form.get("fromName"),
        locationId: locationId || null,
      });
      if (!locationId) await sellingLocation(shop, admin);
      return { intent, ok: true };
    }
  } catch (e) {
    if (!(e instanceof WindowError) && !(e instanceof NotifyError)) console.error(`[preorder-countdowns] ${intent}:`, e);
    return { intent, id, error: e?.message ?? String(e) };
  }
  return { intent, error: "Unknown action" };
};

// Reading actions don't need the whole page reloaded
export const shouldRevalidate = ({ formData, defaultShouldRevalidate }) =>
  ["search", "variants"].includes(String(formData?.get("intent"))) ? false : defaultShouldRevalidate;

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const STORE_TZ = "America/Los_Angeles";
const PINK = "#FBACBB";
const cell = { padding: "8px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "middle" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap" };
const muted = { color: "#616161" };
const small = { fontSize: "12px", color: "#616161" };
const box = { overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };
const input = { font: "inherit", padding: "5px 8px", borderRadius: "8px", border: "1px solid #c9c9c9" };
const thumb = { width: "36px", height: "36px", objectFit: "cover", borderRadius: "6px", background: "#f1f1f1", flexShrink: 0 };
const num = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

const MOTION_CSS = `
@keyframes pcRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.pc-rise { animation: pcRise .38s cubic-bezier(.2, .7, .3, 1) both; }
@media (prefers-reduced-motion: reduce) { .pc-rise { animation: none; } }
`;

const fmtStore = (iso, withYear = true) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: STORE_TZ,
        month: "short",
        day: "numeric",
        ...(withYear ? { year: "numeric" } : {}),
        hour: "numeric",
        minute: "2-digit",
      }) + " PT"
    : "—";
const money = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");

const pad = (n) => String(n).padStart(2, "0");
function until(iso, now) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  return `${d > 0 ? `${d}d ` : ""}${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const pill = (bg, color) => ({
  display: "inline-block",
  fontSize: "12px",
  fontWeight: 600,
  padding: "2px 8px",
  borderRadius: "999px",
  background: bg,
  color,
  whiteSpace: "nowrap",
});

function phaseNow(w, now) {
  if (w.closesAt && now >= new Date(w.closesAt).getTime()) return "closed";
  if (w.opensAt && now < new Date(w.opensAt).getTime()) return "scheduled";
  return w.opensAt || w.closesAt ? "open" : "unset";
}

function Status({ w, now }) {
  const phase = phaseNow(w, now);
  if (phase === "unset") return <span style={pill("#fff4d6", "#7a4f01")}>Needs an opening time</span>;
  if (phase === "scheduled")
    return (
      <>
        <span style={pill("#1a1a1a", PINK)}>Counting down</span>
        <div style={{ ...small, ...num, marginTop: "4px" }}>Opens in {until(w.opensAt, now)}</div>
      </>
    );
  if (phase === "open")
    return (
      <>
        {w.soldOut ? <span style={pill("#fde8e8", "#b42318")}>Sold out</span> : <span style={pill("#e3f1df", "#1a5e20")}>Open</span>}
        {w.closesAt && <div style={{ ...small, ...num, marginTop: "4px" }}>Closes in {until(w.closesAt, now)}</div>}
      </>
    );
  return <span style={pill("#f1f1f1", "#616161")}>Closed</span>;
}

function Stock({ w }) {
  if (!w.limited) return <span style={muted}>No limit</span>;
  if (w.appliedPhase === "open")
    return (
      <span style={num}>
        <strong>{w.available}</strong> <span style={muted}>left of {w.limitTotal}</span>
        {w.soldOut && w.restockedUnits > 0 && <div style={small}>{w.restockedUnits} added since selling out</div>}
      </span>
    );
  return (
    <span style={num}>
      Limit {w.limitTotal}
      {w.held > 0 && <div style={small}>{w.held} held for re-opening</div>}
    </span>
  );
}

function EmailStats({ m }) {
  if (!m) return null;
  return (
    <span style={num}>
      {m.sent} sent
      <div style={small}>
        {pct(m.opened, m.sent)} opened · {pct(m.clicked, m.sent)} clicked
      </div>
    </span>
  );
}

function FromEmails({ m }) {
  if (!m) return null;
  return (
    <span style={num}>
      {m.orders} order{m.orders === 1 ? "" : "s"}
      <div style={small}>{money(m.emailRevenue)}</div>
    </span>
  );
}

function Sold({ m }) {
  if (!m) return null;
  return (
    <span style={num}>
      {m.units} unit{m.units === 1 ? "" : "s"}
      <div style={small}>{money(m.revenue)}</div>
    </span>
  );
}

function ProductCell({ title, imageUrl, productId }) {
  const numeric = productId?.split("/").pop();
  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "center", minWidth: "180px" }}>
      {imageUrl ? <img src={imageUrl} alt="" style={thumb} /> : <div style={thumb} />}
      <a href={`shopify:admin/products/${numeric}`} target="_top" style={{ color: "#005bd3" }}>
        {title}
      </a>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
      <span style={muted}>{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Open & upcoming
// ---------------------------------------------------------------------------

function EditPanel({ w, colSpan, onDone }) {
  const save = useFetcher();
  const variants = useFetcher();
  const [opens, setOpens] = useState(w.opensInput);
  const [closes, setCloses] = useState(w.closesInput);
  const [limited, setLimited] = useState(w.limited);
  const [limits, setLimits] = useState({});
  const busy = save.state !== "idle";

  useEffect(() => {
    variants.submit({ intent: "variants", id: String(w.id) }, { method: "post" });
  }, []);
  const list = variants.data?.intent === "variants" ? variants.data.variants ?? [] : [];
  useEffect(() => {
    if (list.length) setLimits(Object.fromEntries(list.map((v) => [v.id, v.limit ?? ""])));
  }, [variants.data]);
  useEffect(() => {
    if (save.data?.intent === "save" && save.data.ok) onDone();
  }, [save.data]);

  const submit = () => {
    const payload = { intent: "save", id: String(w.id), opens, closes };
    if (limited) {
      const missing = list.some((v) => limits[v.id] === "" || limits[v.id] == null);
      if (missing) return alertLater("Enter a limit for every variant, or untick “Limit pre-orders”.");
      payload.limits = JSON.stringify(Object.fromEntries(list.map((v) => [v.id, Number(limits[v.id])])));
    }
    save.submit(payload, { method: "post" });
  };
  const [localError, setLocalError] = useState(null);
  const alertLater = (msg) => setLocalError(msg);
  const error = localError ?? save.data?.error ?? variants.data?.error;

  return (
    <tr>
      <td style={{ ...cell, background: "#fafafa" }} colSpan={colSpan}>
        <div style={{ display: "flex", gap: "14px", alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Pre-orders open (Pacific)">
            <input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} style={input} />
          </Field>
          <Field label="Pre-orders close (optional)">
            <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} style={input} />
          </Field>
          <label style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", paddingBottom: "6px" }}>
            <input type="checkbox" checked={limited} onChange={(e) => (setLimited(e.target.checked), setLocalError(null))} />
            Limit pre-orders
          </label>
        </div>

        {limited && (
          <div style={{ marginTop: "12px" }}>
            {variants.state !== "idle" && !list.length ? (
              <span style={muted}>Loading variants…</span>
            ) : (
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                {list.map((v) => (
                  <Field key={v.id} label={`${v.title}${w.appliedPhase === "open" ? ` (${v.available} on sale now)` : ""}`}>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={limits[v.id] ?? ""}
                      onChange={(e) => (setLimits({ ...limits, [v.id]: e.target.value }), setLocalError(null))}
                      style={{ ...input, width: "110px" }}
                      disabled={!v.tracked}
                    />
                    {!v.tracked && <span style={{ ...small, color: "#b42318" }}>Turn on “Track quantity” first</span>}
                  </Field>
                ))}
              </div>
            )}
            <div style={{ ...small, marginTop: "6px" }}>
              At opening each variant gets this many units to sell. When they run out the button shows “Pre-Orders Closed”
              and customers can sign up to hear if more are added.
              {w.appliedPhase === "open" && " Changing it now adds or removes the difference straight away."}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
          <s-button variant="primary" onClick={submit} {...(busy ? { loading: true } : {})}>
            Save
          </s-button>
          <s-button variant="tertiary" onClick={onDone}>
            Cancel
          </s-button>
        </div>
        {error && <div style={{ color: "#b42318", marginTop: "8px" }}>{error}</div>}
      </td>
    </tr>
  );
}

const OPEN_COLUMNS = ["Product", "Opens", "Closes", "Status", "Stock", "Sign-ups", "Emails", "From emails", "Sold"];

function OpenRow({ w, now, canManage }) {
  const fetcher = useFetcher();
  const [editing, setEditing] = useState(!w.opensAt && !w.closesAt && canManage);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = fetcher.state !== "idle";
  const colSpan = OPEN_COLUMNS.length + (canManage ? 1 : 0);
  const m = w.metrics;

  return (
    <>
      <tr className="pc-rise" style={{ opacity: fetcher.formData?.get("intent") === "remove" ? 0.4 : 1 }}>
        <td style={cell}>
          <ProductCell {...w} />
          {w.lastError && <div style={{ color: "#b42318", fontSize: "12px", marginTop: "4px" }}>Couldn't update Shopify: {w.lastError}</div>}
        </td>
        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtStore(w.opensAt)}</td>
        <td style={{ ...cell, whiteSpace: "nowrap" }}>{w.closesAt ? fmtStore(w.closesAt) : <span style={muted}>No end</span>}</td>
        <td style={cell}>
          <Status w={w} now={now} />
        </td>
        <td style={cell}>
          <Stock w={w} />
        </td>
        <td style={{ ...cell, ...num }}>{m?.signups ?? 0}</td>
        <td style={cell}>
          <EmailStats m={m} />
        </td>
        <td style={cell}>
          <FromEmails m={m} />
        </td>
        <td style={cell}>
          <Sold m={m} />
        </td>
        {canManage && (
          <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
            {!editing && (
              <s-button variant="tertiary" onClick={() => setEditing(true)}>
                Edit
              </s-button>
            )}
            {confirmRemove ? (
              <>
                <s-button
                  variant="tertiary"
                  tone="critical"
                  onClick={() => fetcher.submit({ intent: "remove", id: String(w.id) }, { method: "post" })}
                  {...(busy ? { loading: true } : {})}
                >
                  Confirm remove
                </s-button>
                <s-button variant="tertiary" onClick={() => setConfirmRemove(false)}>
                  Keep
                </s-button>
              </>
            ) : (
              <s-button variant="tertiary" tone="critical" onClick={() => setConfirmRemove(true)}>
                Remove
              </s-button>
            )}
            {fetcher.data?.error && <div style={{ color: "#b42318", fontSize: "12px" }}>{fetcher.data.error}</div>}
          </td>
        )}
      </tr>
      {editing && canManage && <EditPanel w={w} colSpan={colSpan} onDone={() => setEditing(false)} />}
    </>
  );
}

function OpenTab({ windows, now, canManage }) {
  return (
    <>
      <s-section heading="Open and upcoming">
        {windows.length === 0 ? (
          <s-paragraph>Nothing scheduled. Add products below.</s-paragraph>
        ) : (
          <div style={box}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  {[...OPEN_COLUMNS, ...(canManage ? [""] : [])].map((h, i) => (
                    <th key={i} style={head}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {windows.map((w) => (
                  <OpenRow key={w.id} w={w} now={now} canManage={canManage} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
      <AddProducts canManage={canManage} />
    </>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryRow({ w, canManage }) {
  const fetcher = useFetcher();
  const [reopening, setReopening] = useState(false);
  const [closes, setCloses] = useState("");
  const [addUnits, setAddUnits] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const busy = fetcher.state !== "idle";
  const m = w.metrics;
  const willSell = w.held + (Number(addUnits) || 0) * (w.variantCount ?? 1);

  return (
    <>
      <tr className="pc-rise">
        <td style={cell}>
          <ProductCell {...w} />
        </td>
        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtStore(w.firstOpenedAt ?? w.opensAt)}</td>
        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtStore(w.closedAt ?? w.closesAt)}</td>
        <td style={cell}>
          <Sold m={m} />
        </td>
        <td style={cell}>
          {w.limited ? (
            <span style={num}>
              Limit {w.limitTotal}
              {w.held > 0 && <div style={small}>{w.held} held</div>}
            </span>
          ) : (
            <span style={muted}>No limit</span>
          )}
        </td>
        <td style={{ ...cell, ...num }}>{m?.signups ?? 0}</td>
        <td style={cell}>
          <EmailStats m={m} />
        </td>
        <td style={cell}>
          <FromEmails m={m} />
        </td>
        {canManage && (
          <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
            {!reopening && (
              <s-button onClick={() => setReopening(true)}>Re-open</s-button>
            )}
            {confirmRemove ? (
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={() => fetcher.submit({ intent: "remove", id: String(w.id) }, { method: "post" })}
              >
                Confirm remove
              </s-button>
            ) : (
              <s-button variant="tertiary" tone="critical" onClick={() => setConfirmRemove(true)}>
                Remove
              </s-button>
            )}
          </td>
        )}
      </tr>
      {reopening && (
        <tr>
          <td style={{ ...cell, background: "#fafafa" }} colSpan={9}>
            <div style={{ display: "flex", gap: "12px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <Field label="New closing time (optional, Pacific)">
                <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} style={input} />
              </Field>
              {w.limited && (
                <Field label="Add units to each variant">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={addUnits}
                    placeholder="0"
                    onChange={(e) => setAddUnits(e.target.value)}
                    style={{ ...input, width: "110px" }}
                  />
                </Field>
              )}
              <s-button
                variant="primary"
                onClick={() => fetcher.submit({ intent: "reopen", id: String(w.id), closes, addUnits: addUnits || "0" }, { method: "post" })}
                {...(busy ? { loading: true } : {})}
              >
                Re-open now
              </s-button>
              <s-button variant="tertiary" onClick={() => setReopening(false)}>
                Cancel
              </s-button>
            </div>
            <div style={{ ...small, marginTop: "8px" }}>
              Pre-orders open straight away.
              {w.limited
                ? ` ${willSell} unit${willSell === 1 ? "" : "s"} go on sale (${w.held} held at closing${Number(addUnits) > 0 ? ` plus ${addUnits} per variant` : ""}). Sign-ups are emailed if that's more than the restock threshold.`
                : " Everyone signed up is emailed."}
            </div>
            {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "8px" }}>{fetcher.data.error}</div>}
          </td>
        </tr>
      )}
    </>
  );
}

function HistoryTab({ windows, canManage }) {
  return (
    <s-section heading="Closed pre-orders">
      {windows.length === 0 ? (
        <s-paragraph>No closed pre-orders yet.</s-paragraph>
      ) : (
        <div style={box}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Product", "Opened", "Closed", "Sold", "Limit", "Sign-ups", "Emails", "From emails", ...(canManage ? [""] : [])].map(
                  (h, i) => (
                    <th key={i} style={head}>
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => (
                <HistoryRow key={w.id} w={w} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Emails & settings
// ---------------------------------------------------------------------------

const KIND = { opened: "Pre-orders open", reopened: "Re-opened", closing: "Closing soon", test: "Test" };
const STATUS = {
  queued: pill("#fff4d6", "#7a4f01"),
  sent: pill("#e3f1df", "#1a5e20"),
  failed: pill("#fde8e8", "#b42318"),
  skipped: pill("#f1f1f1", "#616161"),
  sending: pill("#fff4d6", "#7a4f01"),
};

function TestEmail({ staffEmail }) {
  const fetcher = useFetcher();
  const [to, setTo] = useState(staffEmail);
  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap", marginTop: "14px" }}>
      <Field label="Send a test email to">
        <input type="email" value={to} onChange={(e) => setTo(e.target.value)} style={{ ...input, width: "240px" }} />
      </Field>
      <s-button
        onClick={() => fetcher.submit({ intent: "testEmail", to }, { method: "post" })}
        {...(fetcher.state !== "idle" ? { loading: true } : {})}
      >
        Send test
      </s-button>
      {fetcher.state === "idle" && fetcher.data?.ok && (
        <span style={{ color: "#1a5e20" }}>
          Sent. Check {fetcher.data.to}; opening it shows under Recent emails (tests aren't counted in the totals).
        </span>
      )}
      {fetcher.state === "idle" && fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
    </div>
  );
}

function EmailsTab({ windows, settings, locations, mail, sends, canManage, staffEmail }) {
  const fetcher = useFetcher();
  const [s, setS] = useState(settings);
  useEffect(() => {
    setS(settings);
  }, [settings]);
  const totals = windows.reduce(
    (t, w) => {
      const m = w.metrics ?? {};
      return {
        signups: t.signups + (m.signups ?? 0),
        sent: t.sent + (m.sent ?? 0),
        opened: t.opened + (m.opened ?? 0),
        clicked: t.clicked + (m.clicked ?? 0),
        orders: t.orders + (m.orders ?? 0),
        revenue: t.revenue + (m.emailRevenue ?? 0),
      };
    },
    { signups: 0, sent: 0, opened: 0, clicked: 0, orders: 0, revenue: 0 },
  );
  const stat = (label, value, sub) => (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", padding: "12px 14px", minWidth: "130px", flex: "1 1 130px" }}>
      <div style={small}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 700, ...num }}>{value}</div>
      {sub && <div style={small}>{sub}</div>}
    </div>
  );

  return (
    <>
      <s-section heading="Notification emails">
        {!mail.configured && (
          <div style={{ marginBottom: "12px" }}>
            <s-banner tone="warning" heading="Email isn't set up yet">
              <s-paragraph>
                {mail.problem ??
                  "Sign-ups are being collected, but nothing will be sent until GOOGLE_SERVICE_ACCOUNT_JSON and MAIL_SENDER are added in Railway (a Google service account allowed to send as your Workspace mailbox)."}
              </s-paragraph>
            </s-banner>
          </div>
        )}
        {mail.configured && mail.problem && (
          <div style={{ marginBottom: "12px" }}>
            <s-banner tone="critical" heading="Emails can't be sent right now">
              <s-paragraph>{mail.problem} Waiting emails will go out once it's fixed.</s-paragraph>
            </s-banner>
          </div>
        )}
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {stat("Signed up", totals.signups)}
          {stat("Emails sent", totals.sent, mail.configured ? `${mail.sentToday} today of ${mail.dailyLimit} allowed` : null)}
          {stat("Opened", pct(totals.opened, totals.sent), `${totals.opened} people`)}
          {stat("Clicked", pct(totals.clicked, totals.sent), `${totals.clicked} people`)}
          {stat("Orders from emails", totals.orders, money(totals.revenue))}
        </div>
        <div style={{ ...small, marginTop: "8px" }}>
          {mail.configured ? `Sending as ${mail.from}${mail.method === "gmail-api" ? " through the Gmail API" : " over SMTP"}. ` : ""}
          {mail.queued > 0 && `${mail.queued} waiting to send. `}
          {mail.failed > 0 && `${mail.failed} couldn't be sent. `}
          Opens are approximate: some mail apps load images automatically, others block them.
        </div>
        {canManage && mail.configured && <TestEmail staffEmail={staffEmail} />}
      </s-section>

      <s-section heading="Settings">
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Email sign-ups after a restock of more than">
            <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="number"
                min="0"
                value={s.restockThreshold}
                onChange={(e) => setS({ ...s, restockThreshold: e.target.value })}
                style={{ ...input, width: "90px" }}
                disabled={!canManage}
              />
              units
            </span>
          </Field>
          <Field label="Closing reminder (0 = off)">
            <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="number"
                min="0"
                value={s.reminderHours}
                onChange={(e) => setS({ ...s, reminderHours: e.target.value })}
                style={{ ...input, width: "90px" }}
                disabled={!canManage}
              />
              hours before
            </span>
          </Field>
          <Field label="Emails come from (name)">
            <input
              value={s.fromName}
              placeholder="Yiggybean"
              onChange={(e) => setS({ ...s, fromName: e.target.value })}
              style={{ ...input, width: "180px" }}
              disabled={!canManage}
            />
          </Field>
          <Field label="Limited stock is kept at">
            <select
              value={s.locationId}
              onChange={(e) => setS({ ...s, locationId: e.target.value })}
              style={{ ...input, minWidth: "180px" }}
              disabled={!canManage}
            >
              <option value="">Automatic (online orders location)</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.online ? "" : " (doesn't fulfil online orders)"}
                </option>
              ))}
            </select>
          </Field>
          {canManage && (
            <s-button
              variant="primary"
              onClick={() => fetcher.submit({ intent: "settings", ...s }, { method: "post" })}
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Save settings
            </s-button>
          )}
        </div>
        {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "8px" }}>{fetcher.data.error}</div>}
        {fetcher.data?.ok && fetcher.state === "idle" && <div style={{ color: "#1a5e20", marginTop: "8px" }}>Saved.</div>}
      </s-section>

      <s-section heading="Recent emails">
        {sends.length === 0 ? (
          <s-paragraph>No emails yet.</s-paragraph>
        ) : (
          <div style={{ ...box, maxHeight: "420px" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  {["Queued", "To", "Product", "Email", "Status", "Opened", "Clicked"].map((h) => (
                    <th key={h} style={head}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sends.map((x, i) => (
                  <tr key={x.id} className="pc-rise" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtStore(x.createdAt, false)}</td>
                    <td style={cell}>{x.email}</td>
                    <td style={cell}>{x.title ?? "—"}</td>
                    <td style={cell}>{KIND[x.kind] ?? x.kind}</td>
                    <td style={cell}>
                      <span style={STATUS[x.status] ?? STATUS.skipped}>{x.status}</span>
                      {x.error && <div style={{ ...small, color: "#b42318", maxWidth: "260px" }}>{x.error}</div>}
                    </td>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{x.openedAt ? fmtStore(x.openedAt, false) : "—"}</td>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{x.clickedAt ? fmtStore(x.clickedAt, false) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Adding products
// ---------------------------------------------------------------------------

function AddProducts({ canManage }) {
  const search = useFetcher();
  const add = useFetcher();
  const [q, setQ] = useState("");
  const [added, setAdded] = useState(new Set());
  const timer = useRef(null);

  const run = (text) => search.submit({ intent: "search", q: text }, { method: "post" });
  // Current pre-orders to start with. Braces matter: an effect must return
  // nothing (or a clean-up function), and submit() returns a Promise.
  useEffect(() => {
    run("");
  }, []);
  useEffect(() => {
    if (add.data?.ok) setAdded((s) => new Set([...s, add.data.productId]));
  }, [add.data]);

  const onType = (text) => {
    setQ(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(text), 300);
  };

  const results = search.data?.intent === "search" ? search.data.results ?? [] : [];
  const adding = add.state !== "idle" ? add.formData?.get("productId") : null;

  return (
    <s-section heading="Add products">
      <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "10px" }}>
        <input
          type="search"
          value={q}
          onChange={(e) => onType(e.target.value)}
          placeholder="Search by title or SKU"
          aria-label="Search products"
          style={{ ...input, flexGrow: 1, maxWidth: "420px" }}
        />
        {search.state !== "idle" && <span style={muted}>Searching…</span>}
      </div>
      <s-paragraph>
        <span style={muted}>
          {q.trim() ? "Products matching your search." : "Current pre-orders (products with a GT tag). Search to find others."}
        </span>
      </s-paragraph>
      {search.data?.error && <div style={{ color: "#b42318", margin: "8px 0" }}>{search.data.error}</div>}
      {add.data?.error && <div style={{ color: "#b42318", margin: "8px 0" }}>{add.data.error}</div>}
      <div style={{ ...box, maxHeight: "420px", marginTop: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
          <thead>
            <tr>
              {["Product", "Release date", "", ""].map((h, i) => (
                <th key={i} style={head}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.length === 0 && search.state === "idle" && (
              <tr>
                <td style={{ ...cell, ...muted }} colSpan={4}>
                  No products found.
                </td>
              </tr>
            )}
            {results.map((p, i) => {
              const inGroup = p.inGroup || added.has(p.productId);
              return (
                <tr key={p.productId} className="pc-rise" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                  <td style={cell}>
                    <ProductCell {...p} />
                  </td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>{p.release ?? <span style={muted}>—</span>}</td>
                  <td style={cell}>
                    {p.preorder && <span style={pill("#fde7ec", "#8a2a3d")}>Pre-order</span>}{" "}
                    {p.status !== "ACTIVE" && <span style={pill("#f1f1f1", "#616161")}>{p.status.toLowerCase()}</span>}
                  </td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    {inGroup ? (
                      <span style={muted}>Added</span>
                    ) : canManage ? (
                      <s-button
                        onClick={() => add.submit({ intent: "add", productId: p.productId }, { method: "post" })}
                        {...(adding === p.productId ? { loading: true } : {})}
                        {...(adding && adding !== p.productId ? { disabled: true } : {})}
                      >
                        Add
                      </s-button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PreorderCountdowns() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Pre-order countdowns" /> : <Page />;
}

const TABS = [
  { id: "open", label: "Open and upcoming" },
  { id: "history", label: "History" },
  { id: "emails", label: "Emails and settings" },
];

function Page() {
  const data = useLoaderData();
  const { windows, canManage } = data;
  const revalidator = useRevalidator();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "open";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const current = windows.filter((w) => phaseNow(w, now) !== "closed");
  const closed = windows.filter((w) => phaseNow(w, now) === "closed");

  // When something opens or closes, refresh shortly after to show what the
  // app changed in Shopify; otherwise refresh the numbers every minute
  const pendingSwitch = windows.some((w) => {
    const due = phaseNow(w, now);
    return due !== "unset" && due !== w.appliedPhase && !w.lastError;
  });
  const bucket = pendingSwitch ? Math.floor(now / 5000) : Math.floor(now / 60000);
  useEffect(() => {
    const t = setTimeout(() => revalidator.state === "idle" && revalidator.revalidate(), pendingSwitch ? 5000 : 60000);
    return () => clearTimeout(t);
  }, [bucket]);

  const tabStyle = (active) => ({
    appearance: "none",
    border: 0,
    borderBottom: `3px solid ${active ? PINK : "transparent"}`,
    background: "none",
    padding: "10px 14px",
    font: "inherit",
    fontWeight: active ? 700 : 500,
    color: active ? "#1a1a1a" : "#616161",
    cursor: "pointer",
  });

  return (
    <s-page heading="Pre-order countdowns">
      <style>{MOTION_CSS}</style>
      <div role="tablist" style={{ display: "flex", gap: "4px", borderBottom: "1px solid #e3e3e3", marginBottom: "14px", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            style={tabStyle(tab === t.id)}
            onClick={() => setParams({ tab: t.id }, { preventScrollReset: true })}
          >
            {t.label}
            {t.id === "open" && current.length > 0 && <span style={{ ...muted, fontWeight: 500 }}> ({current.length})</span>}
            {t.id === "history" && closed.length > 0 && <span style={{ ...muted, fontWeight: 500 }}> ({closed.length})</span>}
          </button>
        ))}
      </div>

      {tab === "open" && <OpenTab windows={current} now={now} canManage={canManage} />}
      {tab === "history" && <HistoryTab windows={closed} canManage={canManage} />}
      {tab === "emails" && <EmailsTab {...data} />}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
