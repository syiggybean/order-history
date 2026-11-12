import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import { PreorderTabs } from "../components/PreorderTabs";
import { Flyout, useFlyoutClose } from "../components/Flyout";
import {
  WindowError,
  addProduct,
  bulkEdit,
  listLocations,
  listWindows,
  removeProduct,
  reopenWindow,
  saveWindow,
  searchProducts,
  sellingLocation,
  syncReleaseCloses,
  windowVariants,
  setContinueSelling,
} from "../preorder-windows.server";
import { NotifyError, getSettings, recentSends, saveSettings, sendTestEmail } from "../preorder-notify.server";
import { setReleaseDate } from "../preorders.server";
import {
  allowAgain,
  approve as approveAuto,
  autoJob,
  autoSettings,
  buildPreview,
  listSkips,
  listSuppliers,
  saveExclusions,
  turnOff as turnOffAuto,
} from "../preorder-auto.server";
import { mailStatus } from "../mailer.server";

export const loader = async ({ request }) => {
  const { session, admin, user, noAccess } = await loadWithAccess(request, "preorders", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  // Closing times that follow release dates catch up with Shopify first
  const releaseSync = await syncReleaseCloses(shop, admin).catch((e) => ({ changed: [], problems: [`Couldn't read release dates: ${e?.message ?? e}`] }));
  const [windows, settings, mail, sends, locations, suppliers, skips] = await Promise.all([
    listWindows(shop),
    getSettings(shop),
    mailStatus(),
    recentSends(shop, 30),
    listLocations(admin).catch(() => []),
    listSuppliers(shop),
    listSkips(shop),
  ]);
  return {
    canManage: can(user, "preorders", "manage"),
    windows,
    settings: {
      restockThreshold: settings.restockThreshold,
      reminderHours: settings.reminderHours,
      fromName: settings.fromName ?? "",
      locationId: settings.locationId ?? "",
      closeOnRelease: settings.closeOnRelease,
    },
    releaseProblems: releaseSync.problems,
    locations: locations.map((l) => ({ id: l.id, name: l.name, online: l.fulfillsOnlineOrders })),
    mail,
    sends,
    staffEmail: user?.email ?? "",
    auto: autoSettings(settings),
    autoJob: autoJob(shop),
    suppliers,
    skips,
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
  bulk: "manage",
  closeOnRelease: "manage",
  autoPreview: "view",
  autoJob: "view",
  autoApprove: "manage",
  autoOff: "manage",
  autoExclusions: "manage",
  autoAllow: "manage",
};
const jsonList = (form, key) => {
  try {
    const v = JSON.parse(String(form.get(key) ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
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
      // A new release date goes to Shopify first, so "close on its release date" uses it
      const release = String(form.get("release") ?? "");
      const productId = String(form.get("productId") ?? "");
      if (release && productId && release !== String(form.get("releaseWas") ?? "")) {
        await setReleaseDate(admin, shop, productId, release, "Countdown");
      }
      // "Continue selling when out of stock", only when someone changed it
      const selling = form.has("continueSelling") ? form.get("continueSelling") === "true" : null;
      if (selling && limits) throw new WindowError("A product with a sales limit can't continue selling when out of stock. Untick one of them.");
      await saveWindow(
        shop,
        admin,
        id,
        {
          opens: String(form.get("opens") ?? ""),
          closes: String(form.get("closes") ?? ""),
          limits,
          closesRule: ["release", "manual"].includes(String(form.get("closesRule"))) ? String(form.get("closesRule")) : undefined,
          keepSelling: form.has("keepSelling") ? form.get("keepSelling") === "true" : undefined,
        },
        user,
      );
      if (selling !== null) await setContinueSelling(shop, admin, id, selling, user);
      return { intent, ok: true, id };
    }
    if (intent === "bulk") {
      const ids = JSON.parse(String(form.get("ids") ?? "[]")).map(Number).filter(Boolean);
      const results = await bulkEdit(
        shop,
        admin,
        ids,
        {
          opens: String(form.get("opens") ?? ""),
          closesMode: String(form.get("closesMode") ?? "keep"),
          closes: String(form.get("closes") ?? ""),
          release: String(form.get("release") ?? ""),
          selling: ["on", "off"].includes(String(form.get("selling"))) ? String(form.get("selling")) : "keep",
        },
        user,
      );
      return { intent, ok: true, results };
    }
    if (intent === "closeOnRelease") {
      await saveSettings(shop, { closeOnRelease: form.get("on") === "true" });
      const sync = await syncReleaseCloses(shop, admin, { user });
      return { intent, ok: true, changed: sync.changed.length, problems: sync.problems };
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
      await removeProduct(shop, admin, id, user);
      return { intent, ok: true, id };
    }
    if (intent === "autoPreview") {
      const preview = await buildPreview(shop, admin, {
        vendors: form.has("vendors") ? jsonList(form, "vendors").map(String) : null,
        suppliers: form.has("suppliers") ? jsonList(form, "suppliers").map(Number) : null,
      });
      return { intent, ok: true, preview };
    }
    if (intent === "autoJob") {
      return { intent, job: autoJob(shop) };
    }
    if (intent === "autoApprove") {
      const job = await approveAuto(
        shop,
        admin,
        { vendors: jsonList(form, "vendors").map(String), suppliers: jsonList(form, "suppliers").map(Number), untick: jsonList(form, "untick").map(String) },
        user,
      );
      return { intent, ok: true, job };
    }
    if (intent === "autoOff") {
      await turnOffAuto(shop);
      return { intent, ok: true };
    }
    if (intent === "autoExclusions") {
      await saveExclusions(shop, { vendors: jsonList(form, "vendors").map(String), suppliers: jsonList(form, "suppliers").map(Number) });
      return { intent, ok: true };
    }
    if (intent === "autoAllow") {
      await allowAgain(shop, jsonList(form, "productIds").map(String));
      return { intent, ok: true };
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
  ["search", "variants", "autoPreview", "autoJob"].includes(String(formData?.get("intent"))) ? false : defaultShouldRevalidate;

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const STORE_TZ = "America/Los_Angeles";
const PINK = "#FBACBB";
const cell = { padding: "8px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "middle" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap" };
const muted = { color: "#616161" };
const small = { fontSize: "12px", color: "#616161" };
// Scrolls inside its own frame, so the sideways scrollbar is always on screen
const box = { overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px", maxHeight: "calc(100vh - 200px)" };
// The product (left) and actions (right) stay put while scrolling sideways
const stickL = { position: "sticky", left: 0, background: "#fff", zIndex: 1, boxShadow: "1px 0 0 #ebebeb" };
const stickR = { position: "sticky", right: 0, background: "#fff", zIndex: 1, boxShadow: "-1px 0 0 #ebebeb" };
// Tick-box column: a fixed width, so the sticky product column sits right against it
const CHECK_W = 38;
const checkCol = { width: `${CHECK_W}px`, minWidth: `${CHECK_W}px`, maxWidth: `${CHECK_W}px`, boxSizing: "border-box", padding: "8px 0 8px 12px", boxShadow: "none" };
const fmtDay = (day) =>
  day ? new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : null;
const input = { font: "inherit", padding: "5px 8px", borderRadius: "8px", border: "1px solid #c9c9c9" };
const thumb = { width: "36px", height: "36px", objectFit: "cover", borderRadius: "6px", background: "#f1f1f1", flexShrink: 0 };
const num = { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

const MOTION_CSS = `
@keyframes pcRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.pc-rise { animation: pcRise .38s cubic-bezier(.2, .7, .3, 1) both; }
.pc-row-open { cursor: pointer; }
.pc-row-open:hover td { background: #fafafa; }
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

const follows = (w, closeOnRelease) => w.closesRule === "release" || (!w.closesRule && Boolean(closeOnRelease));

// ---------------------------------------------------------------------------
// Flyout: everything about one product's countdown
// ---------------------------------------------------------------------------

const radioRow = { display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px", lineHeight: 1.4 };
const drawerSection = { padding: "14px 18px", borderBottom: "1px solid #ebebeb", display: "flex", flexDirection: "column", gap: "10px" };
const sectionTitle = { fontWeight: 650, fontSize: "13px", margin: 0 };

function EditDrawer({ w, onClose, closeOnRelease, canManage }) {
  return (
    <Flyout
      onClose={onClose}
      label={`Countdown for ${w.title}`}
      title={canManage ? "Edit countdown" : "Countdown"}
      width={460}
      bodyStyle={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      <DrawerBody w={w} closeOnRelease={closeOnRelease} canManage={canManage} />
    </Flyout>
  );
}

function DrawerBody({ w, closeOnRelease, canManage }) {
  const onClose = useFlyoutClose();
  const save = useFetcher();
  const remove = useFetcher();
  const variants = useFetcher();
  const [release, setRelease] = useState(w.releaseDay ?? "");
  const [opens, setOpens] = useState(w.opensInput || "");
  const [closeMode, setCloseMode] = useState(follows(w, closeOnRelease) && w.releaseDay ? "release" : w.closesInput ? "date" : "none");
  const [closes, setCloses] = useState(w.closesInput || "");
  const [keepSelling, setKeepSelling] = useState(Boolean(w.keepSelling));
  // "Continue selling when out of stock" as it is in Shopify now (null until loaded)
  const [selling, setSelling] = useState(null);
  const [limited, setLimited] = useState(w.limited);
  const [limits, setLimits] = useState({});
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [localError, setLocalError] = useState(null);
  const busy = save.state !== "idle";

  useEffect(() => {
    if (canManage) variants.submit({ intent: "variants", id: String(w.id) }, { method: "post" });
  }, []);
  const list = variants.data?.intent === "variants" ? variants.data.variants ?? [] : [];
  useEffect(() => {
    if (list.length) setLimits(Object.fromEntries(list.map((v) => [v.id, v.limit ?? ""])));
  }, [variants.data]);
  const sellingNow = !list.length ? null : list.every((v) => v.continueSelling) ? "on" : list.some((v) => v.continueSelling) ? "mixed" : "off";
  const sellingShown = selling ?? sellingNow;
  useEffect(() => {
    if (save.data?.intent === "save" && save.data.ok) onClose();
  }, [save.data]);
  useEffect(() => {
    if (remove.data?.intent === "remove" && remove.data.ok) onClose();
  }, [remove.data]);

  const submit = () => {
    setLocalError(null);
    if (closeMode === "release" && !release) return setLocalError("Enter a release date, or pick another closing option.");
    if (closeMode === "date" && !closes) return setLocalError("Enter a closing time, or pick another closing option.");
    const payload = {
      intent: "save",
      id: String(w.id),
      productId: w.productId,
      release,
      releaseWas: w.releaseDay ?? "",
      opens,
      closes: closeMode === "date" ? closes : "",
      closesRule: closeMode === "release" ? "release" : "manual",
      keepSelling: String(keepSelling),
    };
    // Only sent when someone changed it here
    if (selling && selling !== sellingNow) payload.continueSelling = String(selling === "on");
    if (limited) {
      const missing = list.some((v) => limits[v.id] === "" || limits[v.id] == null);
      if (missing) return setLocalError("Enter a limit for every variant, or untick “Limit pre-orders”.");
      payload.limits = JSON.stringify(Object.fromEntries(list.map((v) => [v.id, Number(limits[v.id])])));
    }
    save.submit(payload, { method: "post" });
  };
  const error = localError ?? save.data?.error ?? remove.data?.error ?? variants.data?.error;
  const numeric = w.productId?.split("/").pop();

  return (
    <>
        <div style={{ flex: 1, overflowY: "auto" }}>
          <div style={{ display: "flex", gap: "12px", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid #ebebeb" }}>
            {w.imageUrl ? <img src={w.imageUrl} alt="" style={{ ...thumb, width: "48px", height: "48px" }} /> : <div style={{ ...thumb, width: "48px", height: "48px" }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, fontSize: "14px" }}>{w.title}</div>
              <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap", marginTop: "3px" }}>
                {w.auto && <span style={pill("#f3ecff", "#5b2bb5")}>Added automatically</span>}
                <a href={`shopify:admin/products/${numeric}`} target="_top" style={{ color: "#005bd3", fontSize: "12px" }}>
                  Open in Shopify ↗
                </a>
              </div>
            </div>
          </div>
          <div style={drawerSection}>
            <p style={sectionTitle}>Release date</p>
            <input type="date" value={release} onChange={(e) => setRelease(e.target.value)} style={{ ...input, width: "180px" }} disabled={!canManage} />
            <span style={small}>Saved to the product in Shopify (its publication date), so pre-order tags and shipping follow it too.</span>
          </div>

          <div style={drawerSection}>
            <p style={sectionTitle}>Pre-orders open (Pacific)</p>
            <input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} style={{ ...input, width: "220px" }} disabled={!canManage} />
          </div>

          <div style={drawerSection}>
            <p style={sectionTitle}>Pre-orders close</p>
            <label style={radioRow}>
              <input type="radio" name={`close-${w.id}`} checked={closeMode === "release"} onChange={() => setCloseMode("release")} disabled={!canManage} />
              <span>
                At the end of the release date{release ? ` (${fmtDay(release)})` : ""}
                <div style={small}>Moves with the release date if it changes.</div>
              </span>
            </label>
            <label style={radioRow}>
              <input type="radio" name={`close-${w.id}`} checked={closeMode === "date"} onChange={() => setCloseMode("date")} disabled={!canManage} />
              <span style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                At a set time
                {closeMode === "date" && (
                  <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} style={{ ...input, width: "220px" }} disabled={!canManage} />
                )}
              </span>
            </label>
            <label style={radioRow}>
              <input type="radio" name={`close-${w.id}`} checked={closeMode === "none"} onChange={() => setCloseMode("none")} disabled={!canManage} />
              <span>No closing time</span>
            </label>
          </div>

          <div style={drawerSection}>
            <p style={sectionTitle}>Continue selling when out of stock</p>
            {sellingShown == null ? (
              <span style={muted}>{canManage ? "Loading…" : "Shown to people who can manage countdowns."}</span>
            ) : (
              <label style={{ ...radioRow, opacity: limited ? 0.55 : 1 }}>
                <input
                  type="checkbox"
                  ref={(el) => el && (el.indeterminate = sellingShown === "mixed")}
                  checked={sellingShown === "on"}
                  disabled={limited || !canManage}
                  onChange={(e) => setSelling(e.target.checked ? "on" : "off")}
                />
                <span>
                  {sellingShown === "on" ? "On for every variant" : sellingShown === "off" ? "Off" : "On for some variants (tick to turn on for all)"}
                  <div style={small}>
                    The same setting as on the product in Shopify. Countdowns never change it on their own, only here or in bulk edit.
                    {limited && " Off while there's a sales limit."}
                    {!limited && sellingShown !== "on" && w.appliedPhase === "open" && " While it's off, pre-orders stop when stock runs out."}
                  </div>
                </span>
              </label>
            )}
          </div>

          <div style={drawerSection}>
            <p style={sectionTitle}>After pre-orders close</p>
            <label style={radioRow}>
              <input type="checkbox" checked={keepSelling} disabled={!canManage} onChange={(e) => setKeepSelling(e.target.checked)} />
              <span>
                Take the countdown off and show the normal Add to cart
                <div style={small}>
                  {keepSelling
                    ? "The product page goes back to normal. Whether it can be bought with no stock follows the setting above."
                    : "The product page shows “Pre-Orders Closed”."}
                </div>
              </span>
            </label>
          </div>

          <div style={drawerSection}>
            <label style={radioRow}>
              <input
                type="checkbox"
                checked={limited}
                disabled={!canManage}
                onChange={(e) => (setLimited(e.target.checked), e.target.checked && sellingShown !== "off" && setSelling("off"), setLocalError(null))}
              />
              <span style={sectionTitle}>Limit pre-orders</span>
            </label>
            {limited && (
              <>
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
                <div style={small}>
                  At opening each variant gets this many units to sell. When they run out the button shows “Pre-Orders Closed” and customers can sign up
                  to hear if more are added.
                  {w.appliedPhase === "open" && " Changing it now adds or removes the difference straight away."}
                </div>
              </>
            )}
          </div>

          {canManage && (
            <div style={{ ...drawerSection, borderBottom: 0 }}>
              {confirmRemove ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <span style={{ fontSize: "13px" }}>
                    Take this product out of the countdowns? Its selling setting goes back to how it was
                    {w.auto ? ", and automatic countdowns won't add it again." : "."}
                  </span>
                  <span style={{ display: "flex", gap: "6px" }}>
                    <s-button
                      tone="critical"
                      onClick={() => remove.submit({ intent: "remove", id: String(w.id) }, { method: "post" })}
                      {...(remove.state !== "idle" ? { loading: true } : {})}
                    >
                      Remove
                    </s-button>
                    <s-button variant="tertiary" onClick={() => setConfirmRemove(false)}>
                      Keep
                    </s-button>
                  </span>
                </div>
              ) : (
                <span>
                  <s-button variant="tertiary" tone="critical" onClick={() => setConfirmRemove(true)}>
                    Remove from countdowns
                  </s-button>
                </span>
              )}
            </div>
          )}
        </div>

        <footer style={{ padding: "12px 18px", borderTop: "1px solid #ebebeb", background: "#fafafa" }}>
          {error && <div style={{ color: "#b42318", marginBottom: "8px", fontSize: "13px" }}>{error}</div>}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <s-button variant="tertiary" onClick={onClose}>
              {canManage ? "Cancel" : "Close"}
            </s-button>
            {canManage && (
              <s-button variant="primary" onClick={submit} {...(busy ? { loading: true } : {})}>
                Save
              </s-button>
            )}
          </div>
        </footer>
    </>
  );
}

const OPEN_COLUMNS = ["Product", "Opens", "Closes", "Release date", "Status", "After closing", "Stock", "Sign-ups", "Emails", "From emails", "Sold"];

function OpenRow({ w, now, canManage, closeOnRelease, selected, onSelect, onOpen }) {
  const m = w.metrics;
  // A click anywhere on the row opens the flyout, except on links and controls
  const open = (e) => {
    if (e.target.closest("a, input, button, s-button, label")) return;
    onOpen();
  };

  return (
    <tr className="pc-rise pc-row-open" onClick={open}>
      {canManage && (
        <td style={{ ...cell, ...stickL, ...checkCol }}>
          <input type="checkbox" aria-label={`Select ${w.title}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} />
        </td>
      )}
      <td style={{ ...cell, ...stickL, left: canManage ? `${CHECK_W}px` : 0 }}>
        <ProductCell {...w} />
        <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
          {w.auto && <span style={pill("#f3ecff", "#5b2bb5")}>Auto</span>}
          {!w.opensAt && !w.closesAt && <span style={pill("#fff1e3", "#8a4b00")}>Not set up</span>}
        </div>
        {w.lastError && <div style={{ color: "#b42318", fontSize: "12px", marginTop: "4px" }}>Couldn't update Shopify: {w.lastError}</div>}
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtStore(w.opensAt)}</td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>
        {w.closesAt ? fmtStore(w.closesAt) : <span style={muted}>No end</span>}
        {follows(w, closeOnRelease) && w.releaseDay && (
          <div>
            <span style={pill("#eef3ff", "#1c4a9c")}>On release date</span>
          </div>
        )}
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(w.releaseDay) ?? <span style={muted}>Not set</span>}</td>
      <td style={cell}>
        <Status w={w} now={now} />
      </td>
      <td style={{ ...cell, whiteSpace: "nowrap" }}>{w.keepSelling ? "Add to cart" : "Pre-Orders Closed"}</td>
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
      <td style={{ ...cell, ...stickR, textAlign: "right", whiteSpace: "nowrap" }}>
        <s-button variant="tertiary" onClick={onOpen}>
          {canManage ? "Edit" : "Details"}
        </s-button>
      </td>
    </tr>
  );
}

function OpenTab({ windows, now, canManage, settings, releaseProblems }) {
  const [selected, setSelected] = useState(() => new Set());
  const ids = windows.map((w) => w.id);
  const picked = ids.filter((id) => selected.has(id));
  const toggle = (id, on) =>
    setSelected((cur) => {
      const next = new Set(cur);
      on ? next.add(id) : next.delete(id);
      return next;
    });
  const closeOnRelease = settings?.closeOnRelease;

  // The flyout: opens by itself for a product just added that isn't set up
  const [openId, setOpenId] = useState(() => (canManage ? windows.find((w) => !w.opensAt && !w.closesAt)?.id ?? null : null));
  const seen = useRef(new Set(ids));
  useEffect(() => {
    const fresh = windows.find((w) => !seen.current.has(w.id) && !w.opensAt && !w.closesAt);
    for (const id of ids) seen.current.add(id);
    if (fresh && canManage) setOpenId(fresh.id);
  }, [ids.join(",")]);
  const openW = windows.find((w) => w.id === openId);

  const [filter, setFilter] = useState("all");
  const autoCount = windows.filter((w) => w.auto).length;
  const shown = filter === "auto" ? windows.filter((w) => w.auto) : filter === "manual" ? windows.filter((w) => !w.auto) : windows;

  return (
    <>
      {openW && <EditDrawer key={openW.id} w={openW} canManage={canManage} closeOnRelease={closeOnRelease} onClose={() => setOpenId(null)} />}
      <s-section heading="Open and upcoming">
        <CloseOnReleaseSetting on={Boolean(closeOnRelease)} canManage={canManage} problems={releaseProblems} />
        {canManage && picked.length > 0 && <BulkBar windows={windows.filter((w) => selected.has(w.id))} onDone={() => setSelected(new Set())} />}
        {autoCount > 0 && (
          <div style={{ display: "flex", gap: "6px", marginBottom: "10px", flexWrap: "wrap" }}>
            {[
              ["all", `All (${windows.length})`],
              ["auto", `Added automatically (${autoCount})`],
              ["manual", `Added by hand (${windows.length - autoCount})`],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                style={{
                  appearance: "none",
                  font: "inherit",
                  fontSize: "12px",
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: "999px",
                  cursor: "pointer",
                  border: `1px solid ${filter === id ? "#1a1a1a" : "#d4d4d4"}`,
                  background: filter === id ? "#1a1a1a" : "#fff",
                  color: filter === id ? "#fff" : "#303030",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {windows.length === 0 ? (
          <s-paragraph>Nothing scheduled. Add products below, or turn on automatic countdowns in the Automatic tab.</s-paragraph>
        ) : (
          <div style={box}>
            <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  {canManage && (
                    <th style={{ ...head, ...stickL, ...checkCol, background: "#f7f7f7", zIndex: 3 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={shown.length > 0 && shown.every((w) => selected.has(w.id))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((w) => w.id)) : new Set())}
                      />
                    </th>
                  )}
                  {OPEN_COLUMNS.map((h, i) => (
                    <th key={h} style={i === 0 ? { ...head, ...stickL, background: "#f7f7f7", zIndex: 3, left: canManage ? `${CHECK_W}px` : 0 } : head}>
                      {h}
                    </th>
                  ))}
                  <th style={{ ...head, ...stickR, background: "#f7f7f7", zIndex: 3 }} />
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => (
                  <OpenRow
                    key={w.id}
                    onOpen={() => setOpenId(w.id)}
                    w={w}
                    now={now}
                    canManage={canManage}
                    closeOnRelease={closeOnRelease}
                    selected={selected.has(w.id)}
                    onSelect={(on) => toggle(w.id, on)}
                  />
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
          {(w.auto || w.finished) && (
            <div style={{ display: "flex", gap: "4px", marginTop: "4px", flexWrap: "wrap" }}>
              {w.auto && <span style={pill("#f3ecff", "#5b2bb5")}>Auto</span>}
              {w.finished && <span style={pill("#e3f5e8", "#0c5132")}>Countdown taken off</span>}
            </div>
          )}
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

// Shop-wide: countdowns close at the end of each product's release date
function CloseOnReleaseSetting({ on, canManage, problems }) {
  const f = useFetcher();
  const busy = f.state !== "idle";
  const value = busy ? f.formData.get("on") === "true" : on;
  return (
    <div style={{ marginBottom: "12px" }}>
      <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
        <input
          type="checkbox"
          checked={value}
          disabled={!canManage || busy}
          onChange={(e) => f.submit({ intent: "closeOnRelease", on: String(e.target.checked) }, { method: "post" })}
          style={{ marginTop: "2px" }}
        />
        <span>
          <strong>Close pre-orders on the release date</strong>
          <span style={{ ...small, display: "block" }}>
            Each countdown closes at 11:59 PM PT on its product's release date, and moves when that date changes in Shopify
            (checked hourly and whenever this page loads). Products given their own closing time in Edit keep it.
          </span>
        </span>
      </label>
      {f.data?.intent === "closeOnRelease" && f.data.ok && (
        <div style={{ ...small, color: "#1a5e20", marginTop: "4px" }}>
          {f.data.changed ? `${f.data.changed} closing time${f.data.changed === 1 ? "" : "s"} moved to the release date.` : "Saved."}
        </div>
      )}
      {(f.data?.problems ?? problems ?? []).length > 0 && (
        <div style={{ ...small, color: "#b42318", marginTop: "4px" }}>
          {(f.data?.problems ?? problems).map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      {f.data?.error && <div style={{ ...small, color: "#b42318" }}>{f.data.error}</div>}
    </div>
  );
}

// The same opening time, closing choice and/or release date for every ticked product
function BulkBar({ windows, onDone }) {
  const f = useFetcher();
  const [opens, setOpens] = useState("");
  const [closesMode, setClosesMode] = useState("keep");
  const [closes, setCloses] = useState("");
  const [release, setRelease] = useState("");
  const [selling, setSelling] = useState("keep");
  const busy = f.state !== "idle";
  const results = f.data?.intent === "bulk" ? f.data.results : null;
  const failed = results?.filter((r) => !r.ok) ?? [];
  const nothing = !opens && closesMode === "keep" && !release && selling === "keep";
  const n = windows.length;
  const apply = () =>
    f.submit(
      { intent: "bulk", ids: JSON.stringify(windows.map((w) => w.id)), opens, closesMode, closes: closesMode === "date" ? closes : "", release, selling },
      { method: "post" },
    );
  useEffect(() => {
    if (results && !failed.length) onDone();
  }, [f.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 4, background: "#fff8fa", border: `1px solid ${PINK}`, borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" }}>
      <div style={{ fontWeight: 700, marginBottom: "8px" }}>
        Change {n} product{n === 1 ? "" : "s"} at once <span style={{ ...small, fontWeight: 400 }}>· blank fields stay as they are</span>
      </div>
      <div style={{ display: "flex", gap: "14px", alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Pre-orders open (Pacific)">
          <input type="datetime-local" aria-label="Bulk opening time" value={opens} onChange={(e) => setOpens(e.target.value)} style={input} />
        </Field>
        <Field label="Pre-orders close">
          <select aria-label="Bulk closing" value={closesMode} onChange={(e) => setClosesMode(e.target.value)} style={input}>
            <option value="keep">Keep as is</option>
            <option value="release">On each one's release date</option>
            <option value="date">At this time…</option>
            <option value="none">No closing time</option>
          </select>
        </Field>
        {closesMode === "date" && (
          <Field label="Closing time (Pacific)">
            <input type="datetime-local" aria-label="Bulk closing time" value={closes} onChange={(e) => setCloses(e.target.value)} style={input} />
          </Field>
        )}
        <Field label="Release date (in Shopify)">
          <input type="date" aria-label="Bulk release date" value={release} onChange={(e) => setRelease(e.target.value)} style={input} />
        </Field>
        <Field label="Continue selling when out of stock">
          <select aria-label="Bulk continue selling" value={selling} onChange={(e) => setSelling(e.target.value)} style={input}>
            <option value="keep">Leave as it is</option>
            <option value="on">Turn on</option>
            <option value="off">Turn off</option>
          </select>
        </Field>
        <s-button variant="primary" onClick={apply} disabled={nothing || (closesMode === "date" && !closes) || undefined} {...(busy ? { loading: true } : {})}>
          Apply to {n}
        </s-button>
        <s-button variant="tertiary" onClick={onDone}>
          Clear selection
        </s-button>
      </div>
      {release && (
        <div style={{ ...small, marginTop: "6px" }}>
          Setting a release date also updates each product's GT tag, shipping profile and template, like changing it anywhere else in the app.
        </div>
      )}
      {f.data?.intent === "bulk" && f.data.error && <div style={{ color: "#b42318", marginTop: "8px" }}>{f.data.error}</div>}
      {failed.length > 0 && (
        <div style={{ color: "#b42318", marginTop: "8px", fontSize: "13px" }}>
          {results.length - failed.length} updated. Not updated:
          {failed.map((r) => (
            <div key={r.id}>
              {r.title}: {r.error}
              {r.done.length > 0 && <span style={small}> (done first: {r.done.join(", ")})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
// Automatic countdowns
// ---------------------------------------------------------------------------

const REASON = {
  already: "Already has a countdown",
  vendor: "Vendor left out",
  supplier: "Supplier left out",
  removed: "Taken out of countdowns earlier",
  unticked: "Left out in an earlier preview",
};
const reasonFor = (r, vendors, suppliers) => {
  if (r.inGroup) return "already";
  if (vendors.has((r.vendor || "").trim().toLowerCase())) return "vendor";
  if (r.supplierIds.some((id) => suppliers.has(id))) return "supplier";
  return r.skip;
};
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

function Exclusions({ vendorsAll, vendors, setVendors, suppliersAll, suppliers, setSuppliers, canManage }) {
  const [q, setQ] = useState("");
  const lower = (x) => (x || "").trim().toLowerCase();
  const shownVendors = vendorsAll.filter((v) => !q || lower(v.name).includes(lower(q)));
  const toggleVendor = (name, on) =>
    setVendors((cur) => {
      const next = new Set(cur);
      on ? next.add(lower(name)) : next.delete(lower(name));
      return next;
    });
  const toggleSupplier = (id, on) =>
    setSuppliers((cur) => {
      const next = new Set(cur);
      on ? next.add(id) : next.delete(id);
      return next;
    });
  const box2 = { border: "1px solid #e3e3e3", borderRadius: "8px", maxHeight: "240px", overflowY: "auto", padding: "6px 0" };
  const item = { display: "flex", gap: "8px", alignItems: "center", padding: "4px 12px", fontSize: "13px" };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px" }}>
      <div>
        <div style={{ fontWeight: 650, fontSize: "13px", marginBottom: "4px" }}>Vendors (publishers) to leave out</div>
        <div style={{ ...small, marginBottom: "6px" }}>From each product's Vendor field in Shopify.</div>
        {vendorsAll.length > 8 && (
          <input type="search" placeholder="Find a vendor" value={q} onChange={(e) => setQ(e.target.value)} style={{ ...input, width: "100%", boxSizing: "border-box", marginBottom: "6px" }} />
        )}
        <div style={box2}>
          {vendorsAll.length === 0 && <div style={{ ...item, ...muted }}>Preview first to list the vendors.</div>}
          {shownVendors.map((v) => (
            <label key={v.name || "(none)"} style={item}>
              <input type="checkbox" disabled={!canManage} checked={vendors.has(lower(v.name))} onChange={(e) => toggleVendor(v.name, e.target.checked)} />
              <span style={{ flex: 1 }}>{v.name || <span style={muted}>No vendor</span>}</span>
              {v.count != null && <span style={muted}>{v.count}</span>}
            </label>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontWeight: 650, fontSize: "13px", marginBottom: "4px" }}>Suppliers to leave out</div>
        <div style={{ ...small, marginBottom: "6px" }}>Products on any purchase order to that supplier.</div>
        <div style={box2}>
          {suppliersAll.length === 0 && <div style={{ ...item, ...muted }}>No suppliers set up in Purchase orders.</div>}
          {suppliersAll.map((s) => (
            <label key={s.id} style={item}>
              <input type="checkbox" disabled={!canManage} checked={suppliers.has(s.id)} onChange={(e) => toggleSupplier(s.id, e.target.checked)} />
              <span style={{ flex: 1 }}>{s.name}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

function AutoJob({ job }) {
  if (!job) return null;
  const pctDone = job.total ? Math.round((job.done / job.total) * 100) : 100;
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", padding: "12px 14px", marginBottom: "14px", background: job.state === "running" ? "#f7f9ff" : "#fff" }}>
      <div style={{ fontWeight: 650, fontSize: "13px" }}>
        {job.state === "running" ? `Adding countdowns… ${job.done} of ${job.total}` : `Added ${job.added.length} countdown${job.added.length === 1 ? "" : "s"}`}
      </div>
      {job.state === "running" && (
        <div style={{ height: "6px", background: "#e8e8e8", borderRadius: "99px", marginTop: "8px", overflow: "hidden" }}>
          <div style={{ width: `${pctDone}%`, height: "100%", background: PINK, transition: "width .3s" }} />
        </div>
      )}
      {job.errors.length > 0 && (
        <details style={{ marginTop: "8px", fontSize: "13px" }}>
          <summary style={{ color: "#b42318", cursor: "pointer" }}>{job.errors.length} couldn't be added</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
            {job.errors.slice(0, 50).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AutoTab({ auto, job: initialJob, suppliers: suppliersAll, skips, canManage }) {
  const preview = useFetcher();
  const approve = useFetcher();
  const off = useFetcher();
  const saveEx = useFetcher();
  const allow = useFetcher();
  const poll = useFetcher();
  const revalidator = useRevalidator();
  const lower = (x) => (x || "").trim().toLowerCase();
  const savedVendors = new Set(auto.vendors.map(lower));
  const savedSuppliers = new Set(auto.suppliers);
  const [vendors, setVendors] = useState(savedVendors);
  const [suppliers, setSuppliers] = useState(savedSuppliers);
  const [untick, setUntick] = useState(() => new Set());
  const [showLeftOut, setShowLeftOut] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const p = preview.data?.intent === "autoPreview" ? preview.data.preview : null;
  const job = (poll.data?.intent === "autoJob" ? poll.data.job : null) ?? (approve.data?.intent === "autoApprove" ? approve.data.job : null) ?? initialJob;
  const running = job?.state === "running";

  // Follow a running job, then show the new countdowns
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => poll.submit({ intent: "autoJob" }, { method: "post" }), 2000);
    return () => clearTimeout(t);
  }, [running, job?.done, poll.data]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) revalidator.revalidate();
    wasRunning.current = running;
  }, [running]);

  const rows = (p?.rows ?? []).map((r) => ({ ...r, why: reasonFor(r, vendors, suppliers) }));
  const adding = rows.filter((r) => !r.why);
  const ticked = adding.filter((r) => !untick.has(r.productId));
  const leftOut = rows.filter((r) => r.why);
  const vendorsAll = p?.vendors ?? [...savedVendors].map((name) => ({ name, count: null }));
  const exclusionsChanged = !sameSet(vendors, savedVendors) || !sameSet(suppliers, savedSuppliers);
  const vendorNames = () => {
    // Saved with the vendor's own spelling where the preview has it
    const byLower = new Map(vendorsAll.map((v) => [lower(v.name), v.name]));
    return [...vendors].map((v) => byLower.get(v) ?? v);
  };

  const [hidePreview, setHidePreview] = useState(false);
  const runPreview = () =>
    setHidePreview(false) ||
    preview.submit({ intent: "autoPreview", vendors: JSON.stringify(vendorNames()), suppliers: JSON.stringify([...suppliers]) }, { method: "post" });
  const runApprove = () =>
    approve.submit(
      {
        intent: "autoApprove",
        vendors: JSON.stringify(vendorNames()),
        suppliers: JSON.stringify([...suppliers]),
        untick: JSON.stringify(adding.filter((r) => untick.has(r.productId)).map((r) => r.productId)),
      },
      { method: "post" },
    );
  useEffect(() => {
    if (approve.data?.intent === "autoApprove" && approve.data.ok) {
      setHidePreview(true);
      setUntick(new Set());
    }
  }, [approve.data]);

  const toggle = (id, on) =>
    setUntick((cur) => {
      const next = new Set(cur);
      on ? next.delete(id) : next.add(id);
      return next;
    });
  const error = preview.data?.error ?? approve.data?.error ?? off.data?.error ?? saveEx.data?.error ?? allow.data?.error;
  const previewShown = p && !hidePreview;

  return (
    <>
      <s-section heading="Automatic countdowns">
        {auto.on ? (
          <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", flexWrap: "wrap", justifyContent: "space-between" }}>
            <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
              <span style={pill("#e3f5e8", "#0c5132")}>On</span>{" "}
              Every product with a release date still to come gets a countdown, checked every hour.
              <div style={muted}>
                Approved {auto.approvedAt ? fmtStore(auto.approvedAt) : ""}
                {auto.approvedBy ? ` by ${auto.approvedBy}` : ""}
                {auto.lastRunAt ? ` · Last check ${fmtStore(auto.lastRunAt)}: ${auto.lastSummary ?? ""}` : ""}
              </div>
            </div>
            {canManage &&
              (confirmOff ? (
                <span style={{ display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
                  Existing countdowns stay as they are.
                  <s-button tone="critical" onClick={() => off.submit({ intent: "autoOff" }, { method: "post" })} {...(off.state !== "idle" ? { loading: true } : {})}>
                    Turn off
                  </s-button>
                  <s-button variant="tertiary" onClick={() => setConfirmOff(false)}>
                    Keep on
                  </s-button>
                </span>
              ) : (
                <s-button onClick={() => setConfirmOff(true)}>Turn off</s-button>
              ))}
          </div>
        ) : (
          <div style={{ fontSize: "13px", lineHeight: 1.55 }}>
            <p style={{ margin: "0 0 8px" }}>
              <span style={pill("#f1f1f1", "#616161")}>Off</span> When turned on, every active product with a release date still to come gets a countdown:
            </p>
            <ul style={{ margin: "0 0 8px", paddingLeft: "20px" }}>
              <li>Pre-orders open straight away. No “pre-orders are open” email goes out, since these are already on pre-order.</li>
              <li>They close at the end of the release date, and follow it if the date moves.</li>
              <li>After that the countdown comes off the page and the normal Add to cart shows. Each product's flyout can change this.</li>
              <li>“Continue selling when out of stock” is never changed. It stays however it's set on each product.</li>
              <li>New products with an upcoming release date are added every hour.</li>
            </ul>
            <p style={{ margin: 0, ...muted }}>Choose any vendors or suppliers to leave out, preview what will be added, then approve it.</p>
          </div>
        )}
      </s-section>

      <AutoJob job={job} />

      <s-section heading="Leave out">
        <Exclusions
          vendorsAll={vendorsAll}
          vendors={vendors}
          setVendors={setVendors}
          suppliersAll={suppliersAll}
          suppliers={suppliers}
          setSuppliers={setSuppliers}
          canManage={canManage}
        />
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap", alignItems: "center" }}>
          <s-button variant={p ? "secondary" : "primary"} onClick={runPreview} {...(preview.state !== "idle" ? { loading: true } : {})}>
            {p ? "Refresh preview" : auto.on ? "Preview what's next" : "Preview what will be added"}
          </s-button>
          {auto.on && canManage && exclusionsChanged && (
            <s-button
              onClick={() =>
                saveEx.submit({ intent: "autoExclusions", vendors: JSON.stringify(vendorNames()), suppliers: JSON.stringify([...suppliers]) }, { method: "post" })
              }
              {...(saveEx.state !== "idle" ? { loading: true } : {})}
            >
              Save what's left out
            </s-button>
          )}
          {preview.state !== "idle" && <span style={small}>Reading the catalog. This can take a little while.</span>}
          {saveEx.data?.ok && !exclusionsChanged && <span style={{ ...small, color: "#0c5132" }}>Saved.</span>}
        </div>
        <div style={{ ...small, marginTop: "6px" }}>Leaving something out only stops new countdowns. Ones already added stay until removed.</div>
      </s-section>

      {error && (
        <s-banner tone="critical">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      {previewShown && (
        <s-section heading={`Preview: ${ticked.length} product${ticked.length === 1 ? "" : "s"} will get a countdown`}>
          {adding.length === 0 ? (
            <s-paragraph>Nothing to add: every product with an upcoming release date already has a countdown or is left out.</s-paragraph>
          ) : (
            <>
              <div style={{ ...small, marginBottom: "8px" }}>Untick anything that shouldn't get one. Unticked products are remembered and left out from now on.</div>
              <div style={{ ...box, maxHeight: "520px" }}>
                <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: "13px" }}>
                  <thead>
                    <tr>
                      <th style={{ ...head, ...checkCol }}>
                        <input
                          type="checkbox"
                          aria-label="Tick all"
                          checked={untick.size === 0}
                          onChange={(e) => setUntick(e.target.checked ? new Set() : new Set(adding.map((r) => r.productId)))}
                        />
                      </th>
                      <th style={head}>Product</th>
                      <th style={head}>Vendor</th>
                      <th style={head}>Supplier</th>
                      <th style={head}>Release date</th>
                      <th style={head}>Countdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adding.map((r) => (
                      <tr key={r.productId} style={{ opacity: untick.has(r.productId) ? 0.5 : 1 }}>
                        <td style={{ ...cell, ...checkCol }}>
                          <input type="checkbox" aria-label={`Add ${r.title}`} checked={!untick.has(r.productId)} onChange={(e) => toggle(r.productId, e.target.checked)} />
                        </td>
                        <td style={cell}>
                          <ProductCell {...r} />
                        </td>
                        <td style={cell}>{r.vendor || <span style={muted}>—</span>}</td>
                        <td style={cell}>{r.suppliers.length ? r.suppliers.join(", ") : <span style={muted}>—</span>}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(r.release)}</td>
                        <td style={{ ...cell, ...small, whiteSpace: "nowrap" }}>Open now → closes end of {fmtDay(r.release)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {leftOut.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <button
                type="button"
                onClick={() => setShowLeftOut(!showLeftOut)}
                style={{ appearance: "none", border: 0, background: "none", padding: 0, color: "#005bd3", cursor: "pointer", font: "inherit", fontSize: "13px" }}
              >
                {showLeftOut ? "Hide" : "Show"} {leftOut.length} left out
              </button>
              {showLeftOut && (
                <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "13px", columns: "2 320px" }}>
                  {leftOut.map((r) => (
                    <li key={r.productId} style={{ breakInside: "avoid", marginBottom: "2px" }}>
                      {r.title} <span style={muted}>· {REASON[r.why]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {canManage && ticked.length > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "14px", flexWrap: "wrap" }}>
              <s-button variant="primary" onClick={runApprove} {...(approve.state !== "idle" ? { loading: true } : {})} {...(running ? { disabled: true } : {})}>
                {auto.on ? `Add these ${ticked.length} now` : `Approve and turn on (${ticked.length})`}
              </s-button>
              {!auto.on && <span style={small}>After this, new products with an upcoming release date get a countdown automatically.</span>}
            </div>
          )}
          {canManage && !auto.on && ticked.length === 0 && adding.length === 0 && (
            <div style={{ marginTop: "12px" }}>
              <s-button variant="primary" onClick={runApprove} {...(approve.state !== "idle" ? { loading: true } : {})}>
                Turn on for new products
              </s-button>
            </div>
          )}
        </s-section>
      )}

      {skips.length > 0 && (
        <s-section heading={`Left out of automatic countdowns (${skips.length})`}>
          <div style={{ ...small, marginBottom: "8px" }}>Products unticked in a preview or taken out of the countdowns. They won't get one automatically.</div>
          <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: "13px" }}>
            {skips.map((s) => (
              <li key={s.productId} style={{ display: "flex", gap: "10px", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f1f1f1" }}>
                <span style={{ flex: 1 }}>
                  {s.title ?? s.productId.split("/").pop()}
                  <span style={muted}>
                    {" "}
                    · {s.reason === "removed" ? "Taken out" : "Unticked"}
                    {s.by ? ` by ${s.by}` : ""} · {fmtStore(s.createdAt)}
                  </span>
                </span>
                {canManage && (
                  <s-button variant="tertiary" onClick={() => allow.submit({ intent: "autoAllow", productIds: JSON.stringify([s.productId]) }, { method: "post" })}>
                    Allow again
                  </s-button>
                )}
              </li>
            ))}
          </ul>
        </s-section>
      )}
    </>
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
  { id: "auto", label: "Automatic" },
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
    <s-page heading="Pre-orders" inlineSize="large">
      <PreorderTabs />
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
            {t.id === "auto" && <span style={{ ...pill(data.auto.on ? "#e3f5e8" : "#f1f1f1", data.auto.on ? "#0c5132" : "#616161"), marginLeft: "6px" }}>{data.auto.on ? "On" : "Off"}</span>}
          </button>
        ))}
      </div>

      {tab === "open" && <OpenTab windows={current} now={now} canManage={canManage} settings={data.settings} releaseProblems={data.releaseProblems} />}
      {tab === "history" && <HistoryTab windows={closed} canManage={canManage} />}
      {tab === "auto" && <AutoTab auto={data.auto} job={data.autoJob} suppliers={data.suppliers} skips={data.skips} canManage={canManage} />}
      {tab === "emails" && <EmailsTab {...data} />}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
