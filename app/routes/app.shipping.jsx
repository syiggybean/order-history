import { useContext, useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import { QuickView } from "../components/QuickView";
import { OrderLink, OrderViewContext } from "../components/shipping/OrderLink";
import { OrderQuickView } from "../components/shipping/OrderQuickView";
import { FlagMarker, ReviewTab } from "../components/shipping/Review";
import { NOTICE_BG, NOTICE_EDGE, NoticeModal, NoticeTag, ShopAdminContext } from "../components/shipping/Notice";
import { PackStation } from "../components/shipping/Pack";
import { Slips } from "../components/shipping/Slips";
import { findBox, getBox, labelCheck, overridePack, packQueue, packScan, packingSlips, savePackage, savePackageSettings, unpack } from "../pack.server";
import { createPortal } from "react-dom";
import { flagOrder, listFlags, openFlagCount, reopenFlag, resolveFlag } from "../flags.server";
import { enterSandbox, inSandbox, leaveSandbox, resetSandbox, sandboxAdmin, sandboxShopOf, sandboxSummary } from "../sandbox.server";
import { EnterSandboxButton, SandboxBanner, SandboxSettings } from "../components/shipping/Sandbox";
import { BatchHeader, BatchList, RemoveBar, SelectionBar } from "../components/shipping/Batches";
import { BinsTab } from "../components/shipping/Bins";
import { PickList } from "../components/shipping/PickList";
import { PackageSettings } from "../components/shipping/Packages";
import {
  addToBatch,
  assignBatch,
  assignableStaff,
  batchAllowed,
  cancelBatch,
  exportBins,
  finishPicking,
  getBatch,
  importBins,
  listBatches,
  listBins,
  openBatches,
  pickList,
  removeFromBatch,
  renameBatch,
  reopenPicking,
  runAutoBatch,
  saveAutoBatchSettings,
  scanPick,
  setBin,
  setPicked,
} from "../batches.server";
import { Items, MOTION_CSS, PINK, ProductName, QuickViewContext, STORE_TZ, ago, box, cell, fmtDate, head, input, muted, pill, small, thumb, useParamSetter } from "../components/shipping/ui";
import {
  ShippingError,
  allowOutsideBatch,
  clearOutsideBatch,
  ackNotice,
  keepAddress,
  recheckOrder,
  listShipments,
  orderDetails,
  staffKeyOf,
  recentEvents,
  runNow,
  saveShippingSettings,
  shippingOverview,
  startFullRead,
  suggestProducts,
  syncStatus,
} from "../shipping.server";
import { ProductPicker } from "../components/shipping/ProductPicker";

const PAGE_SIZE = 50;
const TABS = ["ready", "waiting", "batches", "review", "stock", "bins", "settings"];

const filterFrom = (params) => ({
  q: params.get("q") || "",
  method: params.get("method") || "",
  country: params.get("country") || "",
  product: params.get("product") || "",
  productName: params.get("pname") || "",
  singles: params.get("singles") === "1",
  sort: params.get("sort") === "newest" ? "newest" : "oldest",
});

export const loader = async ({ request }) => {
  const { session, user, noAccess, admin } = await loadWithAccess(request, "shipping", "view");
  if (noAccess) return { noAccess: true };
  // Sandbox mode: this person works on the practice copy
  const sandboxOn = await inSandbox(session.shop, user);
  const shop = sandboxOn ? sandboxShopOf(session.shop) : session.shop;
  const params = new URL(request.url).searchParams;
  // "Only their assigned batches" (never applies to owners and admins)
  const restricted = can(user, "shipping", "assignedOnly") && !user?.isOwner && !user?.isAdmin;
  const tab = TABS.includes(params.get("tab")) ? params.get("tab") : restricted ? "batches" : "ready";
  const filter = filterFrom(params);
  const askedBatch = tab === "batches" && params.get("batch") ? Number(params.get("batch")) : null;
  const hiddenBatch = Boolean(askedBatch && restricted && !(await batchAllowed(shop, askedBatch, user.id)));
  const batchId = hiddenBatch ? null : askedBatch;
  const mine = params.get("mine") === "1";
  const view = ["pick", "pack", "slips"].includes(params.get("view")) ? params.get("view") : null;
  const viewer = staffKeyOf(user);
  const canBatches = can(user, "shipping", "batches");
  const [overview, list, events, batches, batch, pick, bins, liveBatches, open, flags, flagCount] = await Promise.all([
    shippingOverview(shop),
    tab === "ready" || tab === "waiting"
      ? listShipments(shop, { ...filter, state: tab }, { pageSize: PAGE_SIZE, viewer })
      : batchId && !view
        ? listShipments(shop, { batchId, sort: filter.sort }, { pageSize: PAGE_SIZE, viewer })
        : null,
    tab === "settings" ? recentEvents(shop, 60) : null,
    tab === "batches" && !batchId && !hiddenBatch
      ? listBatches(shop, { show: params.get("show") || "live", onlyFor: restricted || mine ? user.id : null })
      : null,
    batchId && !view ? getBatch(shop, batchId) : null,
    batchId && view === "pick" ? pickList(shop, batchId) : null,
    tab === "bins" ? listBins(shop, { q: params.get("q") || "", missing: params.get("missing") === "1" }) : null,
    listBatches(shop, { show: "live", onlyFor: restricted ? user.id : null }),
    tab === "ready" && canBatches ? openBatches(shop) : null,
    tab === "review" ? listFlags(shop, { status: params.get("status") === "resolved" ? "resolved" : "open" }) : null,
    openFlagCount(shop),
  ]);
  return {
    tab,
    filter,
    overview,
    list,
    events,
    batches,
    batch,
    pick,
    bins,
    binQuery: { q: params.get("q") || "", missing: params.get("missing") === "1" },
    show: params.get("show") || "live",
    liveBatchCount: liveBatches.length,
    openBatches: open ?? [],
    flags,
    flagStatus: params.get("status") === "resolved" ? "resolved" : "open",
    flagCount,
    restricted,
    mine,
    hiddenBatch,
    me: user?.id ?? null,
    staff: batchId && !view && canBatches ? await assignableStaff(shop) : [],
    sandbox: sandboxOn ? await sandboxSummary(session.shop) : null,
    // For "Review in Shopify": the order page in Shopify admin
    shopAdmin: `https://admin.shopify.com/store/${session.shop.replace(/\.myshopify\.com$/, "")}`,
    pack: batchId && view === "pack" ? await packQueue(shop, batchId).catch(() => null) : null,
    box:
      batchId && view === "pack" && params.get("box")
        ? await getBox(shop, batchId, Number(params.get("box"))).catch(() => null)
        : null,
    slips:
      batchId && view === "slips"
        ? await packingSlips(shop, sandboxOn ? sandboxAdmin(admin, shop) : admin, batchId, (params.get("slips") || "").split(",").filter(Boolean)).catch(() => null)
        : null,
    sync: syncStatus(shop),
    can: {
      settings: can(user, "shipping", "settings"),
      shipOutside: can(user, "shipping", "shipOutside"),
      batches: canBatches,
      pick: can(user, "shipping", "pick"),
      review: can(user, "shipping", "review"),
      pack: can(user, "shipping", "pack"),
      override: can(user, "shipping", "override"),
      // Release dates can be changed from the quick view by people who manage pre-orders
      editRelease: !sandboxOn && (can(user, "preorders", "manage") || can(user, "releaseReview", "manage")),
    },
  };
};

const NEEDS = {
  more: "view",
  enterSandbox: "view",
  leaveSandbox: "view",
  resetSandbox: "view",
  order: "view",
  outside: "shipOutside",
  clearOutside: "shipOutside",
  settings: "settings",
  sync: "settings",
  autoSettings: "settings",
  addToBatch: "batches",
  removeFromBatch: "batches",
  cancelBatch: "batches",
  renameBatch: "batches",
  autoBatch: "batches",
  scan: "pick",
  setPicked: "pick",
  finishPicking: "pick",
  reopenPicking: "pick",
  setBin: "settings",
  assignBatch: "batches",
  ackNotice: "view",
  recheckOrder: "view",
  keepAddress: "view",
  findBox: "view",
  packScan: "pack",
  unpack: "pack",
  labelCheck: "pack",
  productSuggest: "view",
  savePackage: "pack",
  packageSettings: "settings",
  overridePack: "override",
  flagOrder: "review",
  resolveFlag: "review",
  reopenFlag: "review",
  importBins: "settings",
  exportBins: "view",
};

export const action = async ({ request }) => {
  const { session, admin: realAdmin, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!NEEDS[intent]) return { intent, error: "Unknown action" };
  if (!can(user, "shipping", NEEDS[intent])) return { intent, ...denied("shipping", NEEDS[intent]) };
  const id = Number(form.get("id"));

  // Entering and leaving sandbox act on the real shop
  if (intent === "enterSandbox") return (await enterSandbox(session.shop, user), { intent, ok: true });
  if (intent === "leaveSandbox") return (await leaveSandbox(session.shop, user), { intent, ok: true });
  // Everything else: in sandbox, work on the copy and keep Shopify unchanged
  const sandboxOn = await inSandbox(session.shop, user);
  const shop = sandboxOn ? sandboxShopOf(session.shop) : session.shop;
  const admin = sandboxOn ? sandboxAdmin(realAdmin, shop) : realAdmin;
  // "Only their assigned batches": no working on anyone else's batch
  const restricted = can(user, "shipping", "assignedOnly") && !user?.isOwner && !user?.isAdmin;
  if (restricted && BATCH_INTENTS.has(intent)) {
    const target = intent === "addToBatch" ? String(form.get("target") ?? "new") : String(form.get("id") ?? "");
    if (target !== "new" && !(await batchAllowed(shop, Number(target), user.id))) {
      return { intent, error: "That batch isn't assigned to you.", denied: true };
    }
  }
  if (intent === "resetSandbox") {
    if (!sandboxOn) return { intent, error: "You're not in sandbox mode." };
    return { intent, ok: true, ...(await resetSandbox(session.shop, user)) };
  }
  if (intent === "sync" && sandboxOn) return { intent, error: "Reading from Shopify is off in sandbox. Use Reset copy in the sandbox bar for fresh data." };
  try {
    if (intent === "productSuggest") {
      return { intent, q: String(form.get("q") ?? ""), products: await suggestProducts(shop, { q: form.get("q"), state: String(form.get("state") ?? "ready"), singles: form.get("singles") === "1" }) };
    }
    if (intent === "more") {
      const filter = JSON.parse(String(form.get("filter") ?? "{}"));
      const page = Number(form.get("page") ?? 2);
      return { intent, ...(await listShipments(shop, filter, { page, pageSize: PAGE_SIZE, viewer: staffKeyOf(user) })) };
    }
    if (intent === "outside") {
      await allowOutsideBatch(shop, admin, id, user, form.get("reason"));
      return { intent, ok: true, id };
    }
    if (intent === "clearOutside") {
      await clearOutsideBatch(shop, id, user);
      return { intent, ok: true, id };
    }
    if (intent === "settings") {
      await saveShippingSettings(shop, { holdMode: String(form.get("holdMode")) }, user);
      runNow(shop, { full: false }).catch(() => {});
      return { intent, ok: true };
    }
    if (intent === "order") {
      const orderId = String(form.get("orderId") ?? "");
      const order = await orderDetails(shop, admin, orderId);
      return order ? { intent, orderId, order } : { intent, orderId, error: "This order couldn't be found in Shopify." };
    }
    if (intent === "recheckOrder") return { intent, ok: true, ...(await recheckOrder(shop, admin, id)) };
    if (intent === "keepAddress") return { intent, ok: true, ...(await keepAddress(shop, id, user)) };
    if (intent === "ackNotice") return { intent, ok: true, ...(await ackNotice(shop, id, String(form.get("context") ?? "view"), user)) };
    if (intent === "findBox") return { intent, ...(await findBox(shop, id, String(form.get("code") ?? ""))) };
    if (intent === "packScan") return { intent, ...(await packScan(shop, id, Number(form.get("shipmentId")), String(form.get("code") ?? ""), user)) };
    if (intent === "overridePack") return { intent, ...(await overridePack(shop, id, Number(form.get("shipmentId")), form.get("reason"), user)) };
    if (intent === "labelCheck") return { intent, ...(await labelCheck(shop, admin, id, Number(form.get("shipmentId")))) };
    if (intent === "savePackage")
      return {
        intent,
        ...(await savePackage(
          shop,
          id,
          Number(form.get("shipmentId")),
          { weight: form.get("weight"), boxId: form.get("boxId"), boxName: form.get("boxName"), l: form.get("l"), w: form.get("w"), h: form.get("h") },
          user,
        )),
      };
    if (intent === "packageSettings")
      return {
        intent,
        ok: true,
        pkg: await savePackageSettings(
          shop,
          { step: String(form.get("step")), weightUnit: String(form.get("weightUnit")), dimUnit: String(form.get("dimUnit")), boxes: form.get("boxes"), packedTag: form.get("packedTag") === "1" },
          user,
        ),
      };
    if (intent === "unpack") return { intent, ...(await unpack(shop, id, Number(form.get("shipmentId")), user)) };
    if (intent === "flagOrder") {
      const flag = await flagOrder(shop, { orderId: String(form.get("orderId") ?? ""), orderName: String(form.get("orderName") ?? "") }, form.get("reason"), form.get("note"), user);
      return { intent, ok: true, flag };
    }
    if (intent === "resolveFlag") return { intent, ok: true, flag: await resolveFlag(shop, id, form.get("resolution"), user) };
    if (intent === "reopenFlag") {
      await reopenFlag(shop, id, user);
      return { intent, ok: true };
    }
    if (intent === "addToBatch") {
      const ids = form.get("ids") ? JSON.parse(String(form.get("ids"))) : null;
      const filter = form.get("filter") ? JSON.parse(String(form.get("filter"))) : null;
      const limit = form.get("limit") ? Number(form.get("limit")) : null;
      const r = await addToBatch(shop, { ids, filter, limit, target: String(form.get("target") || "new"), name: String(form.get("name") ?? "") }, user);
      return { intent, ok: true, ...r };
    }
    if (intent === "removeFromBatch") {
      return { intent, ok: true, ...(await removeFromBatch(shop, id, JSON.parse(String(form.get("ids") ?? "[]")), user)) };
    }
    if (intent === "cancelBatch") return { intent, ok: true, ...(await cancelBatch(shop, id, user)) };
    if (intent === "assignBatch") {
      return { intent, ok: true, ...(await assignBatch(shop, id, JSON.parse(String(form.get("staff") ?? "[]")), user)) };
    }
    if (intent === "renameBatch") {
      await renameBatch(shop, id, form.get("name"), user);
      return { intent, ok: true };
    }
    if (intent === "autoBatch") return { intent, ok: true, ...(await runAutoBatch(shop, user)) };
    if (intent === "autoSettings") {
      await saveAutoBatchSettings(
        shop,
        { enabled: form.get("enabled") === "1", time: String(form.get("time") ?? ""), singles: form.get("singles") === "1", min: form.get("min") },
        user,
      );
      return { intent, ok: true };
    }
    if (intent === "scan") return { intent, ...(await scanPick(shop, id, String(form.get("code") ?? ""), user)) };
    if (intent === "setPicked") return { intent, ok: true, ...(await setPicked(shop, id, String(form.get("key")), form.get("qty"))) };
    if (intent === "finishPicking") return { intent, ...(await finishPicking(shop, id, user, { force: form.get("force") === "1" })) };
    if (intent === "reopenPicking") {
      await reopenPicking(shop, id, user);
      return { intent, ok: true };
    }
    if (intent === "setBin") return { intent, ok: true, ...(await setBin(shop, JSON.parse(String(form.get("item"))), form.get("bin"), user)) };
    if (intent === "importBins") return { intent, ok: true, ...(await importBins(shop, admin, String(form.get("text") ?? ""), user)) };
    if (intent === "exportBins") return { intent, ok: true, csv: await exportBins(shop) };
    if (intent === "sync") {
      return { intent, ok: true, ...startFullRead(shop) };
    }
  } catch (e) {
    if (!(e instanceof ShippingError)) console.error(`[shipping] ${intent}:`, e);
    return { intent, id, error: e?.message ?? String(e) };
  }
  return { intent, error: "Unknown action" };
};

// Actions on a batch (its id is in "id"): people limited to their assigned batches only get theirs
const BATCH_INTENTS = new Set([
  "scan", "setPicked", "finishPicking", "reopenPicking", "packScan", "findBox", "overridePack", "unpack", "labelCheck", "savePackage",
  "removeFromBatch", "cancelBatch", "renameBatch", "assignBatch", "addToBatch",
]);

// Busy, local-only actions don't reload the whole page
const LOCAL = new Set(["more", "order", "scan", "setPicked", "setBin", "exportBins", "packScan", "findBox", "ackNotice", "recheckOrder", "keepAddress", "labelCheck", "savePackage", "productSuggest"]);
export const shouldRevalidate = ({ formData, defaultShouldRevalidate }) =>
  LOCAL.has(formData?.get("intent")) ? false : defaultShouldRevalidate;

// ---------------------------------------------------------------------------

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const took = (a, b) => {
  const s = Math.max(1, Math.round((new Date(b) - new Date(a)) / 1000));
  return s < 90 ? `${s} sec` : `${Math.round(s / 60)} min`;
};

function SyncProgress({ running }) {
  const reading = running.phase === "Reading open orders from Shopify";
  return (
    <div
      role="status"
      style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", marginBottom: "12px", borderRadius: "10px", background: "#fff5f7", border: `1px solid ${PINK}` }}
    >
      <span className="sh-spin" aria-hidden="true" />
      <div style={{ fontSize: "13px" }}>
        <strong>{running.full ? "Reading everything from Shopify" : "Updating shipments"}</strong>
        <span style={muted}>
          {" "}
          · {running.phase}
          {reading || running.read ? ` · ${running.read.toLocaleString()} shipment${running.read === 1 ? "" : "s"} read so far` : ""}
          {" "}· started {clock(running.startedAt)}
          {running.full ? " · you can leave this page; it carries on" : ""}
        </span>
      </div>
    </div>
  );
}

function LastRead({ last }) {
  if (!last) return null;
  if (!last.ok)
    return (
      <s-paragraph>
        <span style={{ color: "#b42318" }}>
          Last full read failed at {clock(last.finishedAt)}: {last.error}
        </span>
      </s-paragraph>
    );
  return (
    <s-paragraph>
      <span style={{ color: "#1a7f37" }}>
        Last full read finished at {clock(last.finishedAt)} (took {took(last.startedAt, last.finishedAt)}):{" "}
        {last.open.toLocaleString()} open shipment{last.open === 1 ? "" : "s"} read
        {last.closed ? `, ${last.closed} closed out` : ""} · {last.ready.toLocaleString()} ready, {last.waiting.toLocaleString()} waiting
      </span>
    </s-paragraph>
  );
}

// ---------------------------------------------------------------------------
// Shipment table
// ---------------------------------------------------------------------------


function OutsideBatch({ s, gate = (fn) => fn() }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const busy = fetcher.state !== "idle";
  if (s.override) {
    return (
      <div>
        <span style={pill("#e8f0fe", "#1c4a9c")}>Let through</span>
        <div style={small}>
          {s.override.by ?? "Staff"}: {s.override.reason}
        </div>
        <s-button variant="tertiary" onClick={() => gate(() => fetcher.submit({ intent: "clearOutside", id: String(s.id) }, { method: "post" }))}>
          Undo
        </s-button>
      </div>
    );
  }
  if (!open)
    return (
      <s-button variant="secondary" onClick={() => gate(() => setOpen(true))}>
        Ship outside a batch
      </s-button>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "200px" }}>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        style={input}
        aria-label="Reason for shipping outside a batch"
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <s-button
          variant="primary"
          onClick={() => fetcher.submit({ intent: "outside", id: String(s.id), reason }, { method: "post" })}
          {...(busy ? { loading: true } : {})}
        >
          Release hold
        </s-button>
        <s-button variant="tertiary" onClick={() => setOpen(false)}>
          Cancel
        </s-button>
      </div>
      {fetcher.data?.error && <span style={{ color: "#b42318", fontSize: "12px" }}>{fetcher.data.error}</span>}
    </div>
  );
}

const STATE_PILL = {
  batched: ["In batch", "#eef3ff", "#1c4a9c"],
  packed: ["Packed", "#e3f1df", "#1a5e20"],
  labeling: ["Labeling", "#fff4d6", "#7a4f01"],
  shipped: ["Shipped", "#f1f1f1", "#4a4a4a"],
};

// "⚑ Flag for review" on a row: opens the order flyout with the flag form ready
function FlagRowButton({ s }) {
  const openOrder = useContext(OrderViewContext);
  if (!openOrder) return null;
  return (
    <s-button variant="secondary" tone="critical" onClick={() => openOrder(s.orderId, { flag: true })}>
      ⚑ Flag for review
    </s-button>
  );
}

function ShipmentRow({ s, i, mode, canOutside, canReview, selection }) {
  const waiting = mode === "waiting";
  const checked = selection?.has(s.id) ?? false;
  const openOrder = useContext(OrderViewContext);
  const ack = useFetcher();
  // The note / address warning pops up on every click; what was clicked carries on after
  const [notice, setNotice] = useState(s.notice);
  useEffect(() => setNotice(s.notice), [s.notice]);
  const [asking, setAsking] = useState(false);
  const pending = useRef(null);
  const gate = (action) => {
    if (!notice) {
      action?.();
      return;
    }
    pending.current = action ?? null;
    setAsking(true);
  };
  const carryOn = () => {
    ack.submit({ intent: "ackNotice", id: String(s.id), context: "view" }, { method: "post" });
    setAsking(false);
    const go = pending.current;
    pending.current = null;
    go?.();
  };
  // Clicks on the row itself (not a button or box): pop up, then open the order
  const onRowClick = (e) => {
    if (!notice || asking) return;
    if (e.target.closest?.("input,button,s-button,a,select,textarea,label,[role=alertdialog]")) return;
    gate(() => openOrder?.(s.orderId));
  };
  // Order links and "Flag for review" in this row go through the same pop-up
  const gatedOpen = openOrder ? (id, opts) => gate(() => openOrder(id, opts)) : null;
  const rowBg = checked ? "#fff5f7" : notice ? NOTICE_BG : undefined;
  return (
    <OrderViewContext.Provider value={gatedOpen}>
    <tr
      className="sh-rise"
      onClick={onRowClick}
      style={{ animationDelay: `${(i % 10) * 30}ms`, background: rowBg, cursor: notice ? "pointer" : undefined }}
      title={notice ? "Has a note or an address warning: click to see it" : undefined}
    >
      {asking &&
        createPortal(
          <NoticeModal
            notice={notice}
            shipmentId={s.id}
            orderName={s.orderName}
            orderNumber={s.orderNumber}
            onCancel={() => {
              pending.current = null;
              setAsking(false);
            }}
            onContinue={carryOn}
            onNoticeChange={(n) => setNotice(n)}
          />,
          document.body,
        )}
      {selection && (
        <td style={{ ...cell, width: "28px", ...(notice ? { boxShadow: `inset 4px 0 0 ${NOTICE_EDGE}` } : {}) }}>
          <input
            type="checkbox"
            checked={checked}
            disabled={selection.disabled}
            onChange={() => gate(() => selection.toggle(s.id))}
            aria-label={`Select ${s.orderName}${s.part ? ` part ${s.part}` : ""}`}
            style={{ width: "16px", height: "16px" }}
          />
        </td>
      )}
      <td style={{ ...cell, whiteSpace: "nowrap", ...(!selection && notice ? { boxShadow: `inset 4px 0 0 ${NOTICE_EDGE}` } : {}) }}>
        <OrderLink orderId={s.orderId} orderNumber={s.orderNumber} name={s.orderName} />
        {s.part && <div style={small}>Part {s.part}</div>}
        <div style={small}>{fmtDate(s.orderCreatedAt)}</div>
      </td>
      <td style={cell}>{s.customerName ?? <span style={muted}>—</span>}</td>
      <td style={cell}>
        <Items lines={s.lines} />
      </td>
      <td style={cell}>
        {s.shippingMethod ?? <span style={muted}>—</span>}
        <div style={small}>{[s.province, s.country].filter(Boolean).join(", ")}</div>
      </td>
      <td style={cell}>
        {waiting ? (
          <span style={{ color: "#7a4f01" }}>{s.waitingReason ?? "Waiting"}</span>
        ) : mode === "batch" ? (
          <span style={pill(...(STATE_PILL[s.state] ?? [s.state, "#f1f1f1", "#4a4a4a"]).slice(1))}>{(STATE_PILL[s.state] ?? [s.state])[0]}</span>
        ) : (
          <>
            <span style={pill("#e3f1df", "#1a5e20")}>Ready</span>
            <div style={small}>since {fmtDate(s.readyAt, true)}</div>
          </>
        )}
        {s.held && <div style={small}>On hold in Shopify (this app)</div>}
        {s.holdError && <div style={{ ...small, color: "#b42318" }}>Hold problem: {s.holdError}</div>}
        {s.flag && <div style={{ ...small, color: "#b42318", fontWeight: 600 }}>{s.flag}</div>}
        <FlagMarker flags={s.review} />
        {notice && (
          <div style={{ marginTop: "4px" }}>
            <NoticeTag notice={notice} />
          </div>
        )}
        {s.tagError && <div style={{ ...small, color: "#b42318" }}>{s.tagError}</div>}
      </td>
      {(canOutside || canReview) && (
        <td style={cell}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "6px" }}>
            {canOutside && mode !== "batch" && <OutsideBatch s={s} gate={gate} />}
            {canReview && <FlagRowButton s={s} />}
          </div>
        </td>
      )}
    </tr>
    </OrderViewContext.Provider>
  );
}

function ShipmentTable({ list, filter, state, canOutside, canReview = false, selection, onRows }) {
  const fetcher = useFetcher();
  const [rows, setRows] = useState(list);
  const ref = useRef(null);
  useEffect(() => {
    setRows(list);
  }, [list]);
  useEffect(() => {
    const d = fetcher.data;
    if (d?.intent === "more" && d.shipments) {
      setRows((r) => {
        const seen = new Set(r.shipments.map((x) => x.id));
        return { ...r, shipments: [...r.shipments, ...d.shipments.filter((x) => !seen.has(x.id))], page: d.page, hasMore: d.hasMore };
      });
    }
  }, [fetcher.data]);
  useEffect(() => {
    onRows?.(rows.shipments);
  }, [rows, onRows]);

  const loading = fetcher.state !== "idle";
  const more = () => {
    if (!rows.hasMore || loading) return;
    fetcher.submit(
      { intent: "more", page: String((rows.page ?? 1) + 1), filter: JSON.stringify(state === "batch" ? filter : { ...filter, state }) },
      { method: "post" },
    );
  };
  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) more();
  };

  if (!rows.shipments.length)
    return (
      <s-paragraph>
        {state === "ready" ? "Nothing is ready to ship right now." : state === "batch" ? "This batch is empty." : "Nothing is waiting."}
        {state !== "batch" && [filter.q, filter.method, filter.country, filter.product, filter.singles].some(Boolean) ? " Try clearing the filters." : ""}
      </s-paragraph>
    );
  const loadedIds = rows.shipments.map((x) => x.id);
  const allLoaded = selection && loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));
  const headers = [
    ...(selection
      ? [
          <input
            key="all"
            type="checkbox"
            checked={allLoaded}
            disabled={selection.disabled}
            onChange={() => selection.setMany(loadedIds, !allLoaded)}
            aria-label="Select all shown"
            style={{ width: "16px", height: "16px" }}
          />,
        ]
      : []),
    "Order",
    "Customer",
    "Items",
    "Shipping",
    state === "waiting" ? "Waiting for" : "Status",
    ...((canOutside && state !== "batch") || canReview ? [""] : []),
  ];
  return (
    <>
      <div style={{ ...small, marginBottom: "6px" }}>
        {rows.total.toLocaleString()} shipment{rows.total === 1 ? "" : "s"}, {filter.sort === "newest" ? "newest" : "oldest"} orders first
      </div>
      <div ref={ref} onScroll={onScroll} style={{ ...box, maxHeight: "640px" }}>
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
            {rows.shipments.map((s, i) => (
              <ShipmentRow key={s.id} s={s} i={i} mode={state} canOutside={canOutside && state !== "batch"} canReview={canReview} selection={selection} />
            ))}
            {loading && (
              <tr>
                <td colSpan={headers.length} style={{ ...cell, ...muted, textAlign: "center" }}>
                  Loading more…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.hasMore && !loading && (
        <div style={{ marginTop: "8px" }}>
          <s-button variant="tertiary" onClick={more}>
            Load more
          </s-button>
        </div>
      )}
    </>
  );
}

function Filters({ filter, overview, state = "ready" }) {
  const [params, setParams] = useSearchParams();
  const navigation = useNavigation();
  const [q, setQ] = useState(filter.q);
  const timer = useRef(null);
  const set = (k, v) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { preventScrollReset: true, replace: true },
    );
  return (
    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "10px" }}>
      <input
        type="search"
        value={q}
        placeholder="Search order, customer or item"
        aria-label="Search shipments"
        onChange={(e) => {
          setQ(e.target.value);
          clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => set("q", v.trim()), 350);
        }}
        style={{ ...input, minWidth: "240px", flexGrow: 1, maxWidth: "360px" }}
      />
      <select value={filter.method} onChange={(e) => set("method", e.target.value)} style={input} aria-label="Shipping method">
        <option value="">All shipping methods</option>
        {overview.methods.map((m) => (
          <option key={m.method} value={m.method}>
            {m.method} ({m.count})
          </option>
        ))}
      </select>
      <select value={filter.country} onChange={(e) => set("country", e.target.value)} style={input} aria-label="Destination">
        <option value="">Anywhere</option>
        <option value="domestic">United States</option>
        <option value="international">International</option>
      </select>
      <ProductPicker
        key={filter.product}
        value={filter.product}
        name={filter.productName}
        state={state}
        singles={filter.singles}
        onPick={(p) =>
          setParams(
            (prev) => {
              const n = new URLSearchParams(prev);
              if (p) {
                n.set("product", p.productId);
                n.set("pname", p.title ?? "");
              } else {
                n.delete("product");
                n.delete("pname");
              }
              return n;
            },
            { preventScrollReset: true, replace: true },
          )
        }
      />
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "4px 10px",
          borderRadius: "999px",
          border: `1px solid ${filter.singles ? "#303030" : "#c9c9c9"}`,
          background: filter.singles ? "#303030" : "#fff",
          color: filter.singles ? "#fff" : "#303030",
          cursor: "pointer",
          fontSize: "13px",
        }}
        title="Shipments with just one item in them"
      >
        <input type="checkbox" checked={filter.singles} onChange={(e) => set("singles", e.target.checked ? "1" : "")} style={{ margin: 0 }} />
        Singles
      </label>
      <select value={filter.sort} onChange={(e) => set("sort", e.target.value === "newest" ? "newest" : "")} style={input} aria-label="Order">
        <option value="oldest">Oldest orders first</option>
        <option value="newest">Newest orders first</option>
      </select>
      {navigation.state === "loading" && <span style={muted}>Loading…</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stock and settings tabs
// ---------------------------------------------------------------------------

function StockTab({ overview }) {
  const rows = overview.products;
  return (
    <s-section heading="Stock against orders">
      <s-paragraph>
        <span style={muted}>
          Units on open shipments for each product, split into those that can ship now and those still waiting. Stock goes
          to the oldest orders first.
        </span>
      </s-paragraph>
      {rows.length === 0 ? (
        <s-paragraph>No open shipments.</s-paragraph>
      ) : (
        <div style={{ ...box, maxHeight: "640px", marginTop: "8px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Product", "Units ordered", "Ready / in batches", "Waiting", "Shipments"].map((h) => (
                  <th key={h} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.productId ?? p.title} className="sh-rise" style={{ animationDelay: `${(i % 10) * 30}ms` }}>
                  <td style={cell}>
                    <ProductName id={p.productId}>{p.title}</ProductName>
                  </td>
                  <td style={cell}>{p.ordered.toLocaleString()}</td>
                  <td style={{ ...cell, color: "#1a5e20", fontWeight: 600 }}>{p.readyUnits.toLocaleString()}</td>
                  <td style={{ ...cell, color: p.waitingUnits ? "#7a4f01" : undefined, fontWeight: p.waitingUnits ? 600 : 400 }}>
                    {p.waitingUnits.toLocaleString()}
                  </td>
                  <td style={cell}>{p.shipments.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}

const HOLD_MODES = [
  { value: "off", label: "Don't hold anything", help: "Shipments can be shipped from Shopify as usual." },
  {
    value: "notReady",
    label: "Hold shipments that aren't ready",
    help: "Unpaid orders and pre-orders without stock get a hold in Shopify, so no one can buy a label for them early. Released automatically once they're ready.",
  },
  {
    value: "untilBatched",
    label: "Hold everything until its batch ships",
    help: "Coming with the Ship step: shipments can only be shipped through a batch (or by someone allowed to ship outside a batch).",
    disabled: true,
  },
];

const EVENT_LABEL = {
  ship_outside_batch: "Shipped outside a batch",
  outside_batch_cleared: "Back to batch-only",
  hold_mode: "Hold setting changed",
  order_flagged: "Order flagged",
  notice_ack: "Read note / address warning",
  address_kept: "Kept a flagged address",
  notice_ack_pack: "Read note / address warning at packing",
  packed: "Packed",
  packed_override: "Packed without a full scan",
  label_bought: "Label bought (shipped)",
  unpacked: "Unpacked",
  sandbox_reset: "Sandbox copy made",
  sandbox_skipped: "Skipped in sandbox (not sent to Shopify)",
  flag_resolved: "Flag resolved",
  flag_reopened: "Flag reopened",
  batch_created: "Batch created",
  batch_added: "Added to batch",
  batch_removed: "Taken out of batch",
  batch_cancelled: "Batch cancelled",
  batch_renamed: "Batch renamed",
  batch_assigned: "Batch assigned",
  batch_picked: "Batch picked",
  batch_pick_reopened: "Picking reopened",
  auto_batch: "Auto-batching",
  auto_batch_settings: "Auto-batching settings",
  bins_imported: "Bins imported",
};

function SettingsTab({ overview, events, sync: status, canSettings, sandboxOn }) {
  const fetcher = useFetcher();
  const sync = useFetcher();
  const [mode, setMode] = useState(overview.settings.holdMode);
  useEffect(() => {
    setMode(overview.settings.holdMode);
  }, [overview.settings.holdMode]);
  const st = overview.settings;
  return (
    <>
      <s-section heading="Holds in Shopify">
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {HOLD_MODES.map((m) => (
            <label key={m.value} style={{ display: "flex", gap: "8px", alignItems: "flex-start", opacity: m.disabled ? 0.55 : 1 }}>
              <input
                type="radio"
                name="holdMode"
                value={m.value}
                checked={mode === m.value}
                disabled={!canSettings || m.disabled}
                onChange={() => setMode(m.value)}
                style={{ marginTop: "3px" }}
              />
              <span>
                <strong>{m.label}</strong>
                <div style={small}>{m.help}</div>
              </span>
            </label>
          ))}
        </div>
        {canSettings && (
          <div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
            <s-button
              variant="primary"
              onClick={() => fetcher.submit({ intent: "settings", holdMode: mode }, { method: "post" })}
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
              {...(mode === st.holdMode ? { disabled: true } : {})}
            >
              Save
            </s-button>
            {fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
            {fetcher.data?.ok && fetcher.state === "idle" && mode === st.holdMode && (
              <span style={{ color: "#1a5e20" }}>Saved. Holds are updated over the next few minutes.</span>
            )}
          </div>
        )}
      </s-section>

      <SandboxSettings on={sandboxOn} />

      <AutoBatchSettings st={st} canSettings={canSettings} />

      <PackageSettings st={st} canSettings={canSettings} />

      <s-section heading="Sync">
        <s-paragraph>
          Shipments are read from Shopify every 30 minutes and whenever an order changes; stock is re-checked every two
          minutes and whenever it changes.
        </s-paragraph>
        <s-paragraph>
          <span style={muted}>
            Last full read: {ago(st.lastFullSyncAt)} · Last stock check: {ago(st.lastReadyRunAt)}
          </span>
        </s-paragraph>
        {st.lastSyncError && (
          <div style={{ marginTop: "8px" }}>
            <s-banner tone="critical" heading="The last read from Shopify failed">
              <s-paragraph>{st.lastSyncError}</s-paragraph>
            </s-banner>
          </div>
        )}
        <LastRead last={status?.last} />
        {st.addressCheckError && (
          <div style={{ marginTop: "8px" }}>
            <s-banner tone="warning" heading="Invalid-address warnings are off">
              <s-paragraph>{st.addressCheckError}</s-paragraph>
            </s-banner>
          </div>
        )}
        {sandboxOn && <s-paragraph>Reading from Shopify is off in sandbox; the copy stays as it was when it was made.</s-paragraph>}
        {canSettings && !sandboxOn && (
          <div style={{ marginTop: "10px", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <s-button
              onClick={() => sync.submit({ intent: "sync" }, { method: "post" })}
              {...(sync.state !== "idle" || status?.running?.full ? { disabled: true } : {})}
            >
              Read everything from Shopify now
            </s-button>
            {status?.running?.full ? (
              <span style={muted}>A full read is running (see the progress at the top). You can leave this page; it carries on.</span>
            ) : sync.data?.error ? (
              <span style={{ color: "#b42318" }}>{sync.data.error}</span>
            ) : null}
          </div>
        )}
      </s-section>

      <s-section heading="Activity">
        {!events?.length ? (
          <s-paragraph>Nothing yet.</s-paragraph>
        ) : (
          <div style={{ ...box, maxHeight: "420px" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  {["When", "Who", "What", "Order", "Details"].map((h) => (
                    <th key={h} style={head}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={e.id} className="sh-rise" style={{ animationDelay: `${(i % 10) * 30}ms` }}>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDate(e.at, true)}</td>
                    <td style={cell}>{e.userName ?? "App"}</td>
                    <td style={cell}>{EVENT_LABEL[e.type] ?? e.type}</td>
                    <td style={cell}>{e.orderName ?? "—"}</td>
                    <td style={cell}>{e.detail ?? "—"}</td>
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
// Page
// ---------------------------------------------------------------------------

function AutoBatchSettings({ st, canSettings }) {
  const fetcher = useFetcher();
  const [enabled, setEnabled] = useState(st.autoBatchEnabled);
  const [time, setTime] = useState(st.autoBatchTime);
  const [singles, setSingles] = useState(st.autoSingleItem);
  const [min, setMin] = useState(String(st.autoSingleMin));
  useEffect(() => {
    setEnabled(st.autoBatchEnabled);
    setTime(st.autoBatchTime);
    setSingles(st.autoSingleItem);
    setMin(String(st.autoSingleMin));
  }, [st.autoBatchEnabled, st.autoBatchTime, st.autoSingleItem, st.autoSingleMin]);
  const dirty = enabled !== st.autoBatchEnabled || time !== st.autoBatchTime || singles !== st.autoSingleItem || min !== String(st.autoSingleMin);
  const row = { display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" };
  return (
    <s-section heading="Auto-batching">
      <s-paragraph>
        <span style={muted}>
          Builds batches from the Ready list on its own, oldest orders first, up to 250 per batch. Runs from the Batches tab whenever you like, and
          once a day if the schedule is on. Shipments already in a batch are never moved.
        </span>
      </s-paragraph>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "10px" }}>
        <label style={row}>
          <input type="checkbox" checked={singles} disabled={!canSettings} onChange={(e) => setSingles(e.target.checked)} />
          <span>
            <strong>Single items:</strong> when more than{" "}
            <input
              type="number"
              min="1"
              max="5000"
              value={min}
              disabled={!canSettings || !singles}
              onChange={(e) => setMin(e.target.value)}
              style={{ ...input, width: "70px" }}
              aria-label="Minimum shipments"
            />{" "}
            shipments of one item (one unit, nothing else in the box) are ready, they go into a batch named after the item, e.g. "Lore Vol. 1
            singles".
          </span>
        </label>
        <label style={row}>
          <input type="checkbox" checked={enabled} disabled={!canSettings} onChange={(e) => setEnabled(e.target.checked)} />
          <span>
            Run every day at{" "}
            <input type="time" value={time} disabled={!canSettings || !enabled} onChange={(e) => setTime(e.target.value)} style={input} aria-label="Time" /> (store
            time, Los Angeles)
          </span>
        </label>
        <div style={small}>Last run: {st.lastAutoBatchAt ? fmtDate(st.lastAutoBatchAt, true) : "never"}</div>
        {canSettings && (
          <div style={row}>
            <s-button
              variant="primary"
              onClick={() =>
                fetcher.submit({ intent: "autoSettings", enabled: enabled ? "1" : "", time, singles: singles ? "1" : "", min }, { method: "post" })
              }
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
              {...(!dirty ? { disabled: true } : {})}
            >
              Save auto-batching
            </s-button>
            {fetcher.data?.intent === "autoSettings" && fetcher.data.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
            {fetcher.data?.intent === "autoSettings" && fetcher.data.ok && !dirty && <span style={{ color: "#1a7f37" }}>Saved</span>}
          </div>
        )}
      </div>
    </s-section>
  );
}

// Ready tab: the list plus ticking shipments and adding them to a batch
function ReadyTab({ list, filter, overview, allowed, openBatches }) {
  const [selected, setSelected] = useState(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [limit, setLimit] = useState(null); // "first N matching"
  const [shown, setShown] = useState([]);
  const filterKey = JSON.stringify(filter);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    setLimit(null);
  }, [filterKey]);
  // The first N in list order are the ones that will be batched
  const firstN = new Set(limit ? shown.slice(0, limit).map((x) => x.id) : []);
  const selection = allowed.batches
    ? {
        has: (id) => (allMatching ? (limit ? firstN.has(id) : true) : selected.has(id)),
        disabled: allMatching,
        toggle: (id) =>
          setSelected((cur) => {
            const n = new Set(cur);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          }),
        setMany: (ids, on) =>
          setSelected((cur) => {
            const n = new Set(cur);
            for (const id of ids) on ? n.add(id) : n.delete(id);
            return n;
          }),
      }
    : null;
  const clear = () => {
    setSelected(new Set());
    setAllMatching(false);
    setLimit(null);
  };
  return (
    <>
      {allowed.batches && (
        <SelectionBar
          count={allMatching ? (limit ? Math.min(limit, list.total) : list.total) : selected.size}
          total={list.total}
          allMatching={allMatching}
          limit={limit}
          sort={filter.sort}
          onSelectAll={() => {
            setAllMatching(true);
            setLimit(null);
          }}
          onSelectFirst={(n) => {
            setSelected(new Set());
            setAllMatching(true);
            setLimit(n >= list.total ? null : n);
          }}
          onClear={clear}
          openBatches={openBatches}
          filter={filter}
          ids={[...selected]}
          onDone={clear}
        />
      )}
      <ShipmentTable
        key={`ready:${filterKey}`}
        list={list}
        filter={filter}
        state="ready"
        canOutside={allowed.shipOutside}
        canReview={allowed.review}
        selection={selection}
        onRows={setShown}
      />
    </>
  );
}

function BatchDetail({ batch, list, filter, allowed, staff, me }) {
  const [selected, setSelected] = useState(() => new Set());
  const editable = allowed.batches && batch.removable;
  const selection = editable
    ? {
        has: (id) => selected.has(id),
        toggle: (id) =>
          setSelected((cur) => {
            const n = new Set(cur);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          }),
        setMany: (ids, on) =>
          setSelected((cur) => {
            const n = new Set(cur);
            for (const id of ids) on ? n.add(id) : n.delete(id);
            return n;
          }),
      }
    : null;
  const bf = { batchId: batch.id, sort: filter.sort };
  return (
    <s-section>
      <BatchHeader batch={batch} canBatches={allowed.batches} canPick={allowed.pick} staff={staff} me={me} />
      {editable && <RemoveBar batch={batch} ids={[...selected]} onDone={() => setSelected(new Set())} />}
      <ShipmentTable
        key={`batch:${batch.id}:${filter.sort}`}
        list={list}
        filter={bf}
        state="batch"
        canOutside={false}
        canReview={allowed.review}
        selection={selection}
      />
    </s-section>
  );
}

export default function Shipping() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Shipping" /> : <Page />;
}

function Page() {
  const { tab, filter, overview, list, events, sync, can: allowed, batches, batch, pick, bins, binQuery, show, liveBatchCount, openBatches, flags, flagStatus, flagCount, sandbox, pack, box: packBox, slips, shopAdmin, restricted, mine, hiddenBatch, me, staff } =
    useLoaderData();
  const [, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const c = overview.counts;

  // Keep the numbers fresh while the page is open; every few seconds while reading from Shopify
  const reading = Boolean(sync?.running?.full);
  const [quickView, setQuickView] = useState(null); // product ID
  const [orderView, setOrderView] = useState(null); // { id, flag }
  const openOrder = (id, opts = {}) => setOrderView({ id, flag: Boolean(opts.flag) });
  const go = useParamSetter();
  useEffect(() => {
    const t = setInterval(() => revalidator.state === "idle" && revalidator.revalidate(), reading ? 3000 : 60000);
    return () => clearInterval(t);
  }, [revalidator, reading]);

  const tabs = [
    { id: "ready", label: "Ready to ship", n: c.ready ?? 0 },
    { id: "waiting", label: "Waiting", n: c.waiting ?? 0 },
    { id: "batches", label: "Batches", n: liveBatchCount },
    { id: "review", label: "Review", n: flagCount, alert: flagCount > 0 },
    { id: "stock", label: "Stock" },
    { id: "bins", label: "Bins" },
    { id: "settings", label: "Settings and activity" },
  ];
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
    <ShopAdminContext.Provider value={shopAdmin}>
    <QuickViewContext.Provider value={setQuickView}>
    <OrderViewContext.Provider value={openOrder}>
    <s-page heading={sandbox ? "Shipping · Sandbox" : "Shipping"}>
      {!sandbox && <EnterSandboxButton />}
      <style>{MOTION_CSS}</style>
      <div role="tablist" style={{ display: "flex", gap: "4px", borderBottom: "1px solid #e3e3e3", marginBottom: "14px", flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            style={tabStyle(tab === t.id)}
            onClick={() =>
              setParams(
                (p) => {
                  const n = new URLSearchParams(p);
                  n.set("tab", t.id);
                  for (const k of ["batch", "view", "show", "q", "missing", "status", "box", "slips", "mine"]) if (t.id !== tab) n.delete(k);
                  if (t.id === "batches" && tab === "batches") {
                    for (const k of ["batch", "view", "box", "slips"]) n.delete(k);
                  }
                  return n;
                },
                { preventScrollReset: true },
              )
            }
          >
            {t.label}
            {t.n != null &&
              (t.alert ? (
                <span style={{ marginLeft: "6px", padding: "0 7px", borderRadius: "999px", background: "#d72c0d", color: "#fff", fontSize: "12px", fontWeight: 700 }}>
                  {t.n.toLocaleString()}
                </span>
              ) : (
                <span style={{ ...muted, fontWeight: 500 }}> ({t.n.toLocaleString()})</span>
              ))}
          </button>
        ))}
      </div>

      {sandbox && <SandboxBanner summary={sandbox} />}
      {reading && <SyncProgress running={sync.running} />}

      {overview.settings.lastSyncError && tab !== "settings" && !reading && (
        <div style={{ marginBottom: "12px" }}>
          <s-banner tone="critical" heading="Couldn't read shipments from Shopify">
            <s-paragraph>{overview.settings.lastSyncError}</s-paragraph>
          </s-banner>
        </div>
      )}
      {!overview.settings.lastFullSyncAt && !reading && (
        <div style={{ marginBottom: "12px" }}>
          <s-banner tone="info" heading="Reading your open orders">
            <s-paragraph>The first read from Shopify takes a few minutes. This page refreshes on its own.</s-paragraph>
          </s-banner>
        </div>
      )}

      {(tab === "ready" || tab === "waiting") && (
        <s-section heading={tab === "ready" ? "Ready to ship" : "Waiting"}>
          <s-paragraph>
            <span style={muted}>
              {tab === "ready"
                ? "Paid shipments with every item released and in stock, not yet in a batch. Anything with a GT tag or a future release date waits, whatever the stock count."
                : "Shipments that can't go yet, and why: pre-orders not yet released, stock still to arrive, payment, or a hold in Shopify."}
            </span>
          </s-paragraph>
          <div style={{ ...small, display: "flex", alignItems: "center", gap: "8px", margin: "6px 0 10px" }}>
            <span style={{ display: "inline-block", width: "14px", height: "14px", borderRadius: "3px", background: NOTICE_BG, boxShadow: `inset 3px 0 0 ${NOTICE_EDGE}` }} />
            Orange rows have an order note or an address Shopify flagged as possibly invalid. Clicking one shows it first, every time.
          </div>
          <Filters filter={filter} overview={overview} state={tab} />
          {tab === "ready" ? (
            <ReadyTab list={list} filter={filter} overview={overview} allowed={allowed} openBatches={openBatches} />
          ) : (
            <ShipmentTable
              key={`${tab}:${JSON.stringify(filter)}`}
              list={list}
              filter={filter}
              state={tab}
              canOutside={allowed.shipOutside}
              canReview={allowed.review}
            />
          )}
        </s-section>
      )}
      {tab === "batches" && batches && (
        <BatchList
          batches={batches}
          show={show}
          restricted={restricted}
          mine={mine}
          canBatches={allowed.batches}
          autoBatch={{
            enabled: overview.settings.autoBatchEnabled,
            time: overview.settings.autoBatchTime,
            singles: overview.settings.autoSingleItem,
            min: overview.settings.autoSingleMin,
          }}
        />
      )}
      {tab === "batches" && batch && <BatchDetail batch={batch} list={list} filter={filter} allowed={allowed} staff={staff} me={me} />}
      {tab === "batches" && pick && <PickList key={pick.batch.id} data={pick} canPick={allowed.pick} />}
      {tab === "batches" && pack && <PackStation key={pack.batch.id} data={pack} boxData={packBox} can={{ pack: allowed.pack, override: allowed.override, pick: allowed.pick }} sandbox={Boolean(sandbox)} />}
      {tab === "batches" && slips && <Slips data={slips} />}
      {tab === "batches" && !batches && !batch && !pick && !pack && !slips && (
        <s-paragraph>{hiddenBatch ? "That batch isn't assigned to you. Ask a lead to assign it if you should be working on it." : "That batch couldn't be found."}</s-paragraph>
      )}
      {tab === "review" && flags && <ReviewTab flags={flags} status={flagStatus} canReview={allowed.review} />}
      {tab === "bins" && bins && <BinsTab items={bins} q={binQuery.q} missing={binQuery.missing} canEdit={allowed.settings} />}
      {tab === "stock" && <StockTab overview={overview} />}
      {tab === "settings" && <SettingsTab overview={overview} events={events} sync={sync} canSettings={allowed.settings} sandboxOn={Boolean(sandbox)} />}
      {orderView && (
        <OrderQuickView
          key={`${orderView.id}:${orderView.flag}`}
          orderId={orderView.id}
          startFlagging={orderView.flag}
          canReview={allowed.review}
          onChanged={() => revalidator.state === "idle" && revalidator.revalidate()}
          onClose={() => setOrderView(null)}
          onOpenBatch={(id) => {
            setOrderView(null);
            go({ tab: "batches", batch: id, view: null, q: null, method: null, country: null, product: null }, { replace: false });
          }}
        />
      )}
      {quickView && (
        <QuickView
          productId={quickView}
          canEdit={allowed.editRelease}
          onClose={() => setQuickView(null)}
          onSaved={() => revalidator.state === "idle" && revalidator.revalidate()}
        />
      )}
    </s-page>
    </OrderViewContext.Provider>
    </QuickViewContext.Provider>
    </ShopAdminContext.Provider>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
