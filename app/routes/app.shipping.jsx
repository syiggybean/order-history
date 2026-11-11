import { useContext, useEffect, useRef, useState } from "react";
import { MethodBadge, MethodRulesContext } from "../components/shipping/MethodBadge";
import { LabelPrintingHelp, MethodRulesSettings } from "../components/shipping/Labels";
import { PackingComputers, PrintProvider } from "../components/shipping/Printing";
import {
  AGENT_VERSION,
  PrintError,
  addStation,
  appUrl,
  fallbackText,
  jobStatus,
  listStations,
  myStationId,
  newInstallCode,
  queuePrint,
  recentJobs,
  refreshPrinters,
  rememberStation,
  removeStation,
  retryJob,
  saveStation,
  stationReady,
  testPrint,
  uninstallCommand,
} from "../print.server";
import { slipsPdf } from "../slips-pdf.server";
import { checkShipped, createMerge, customerPlan, listMerges, mergeCandidates, saveBoxes, searchCustomers, undoMerge } from "../merge.server";
import { MergeTab } from "../components/shipping/Merge";
import { benchContext, benchLink, benchTakeScans, benchUnlink, pickPhoneLink, videosFor } from "../camera.server";
import { DEFAULT_METHOD_RULES } from "../components/shipping/methods";
import { IN_APP_LABELS } from "../components/shipping/features";
import { redirect, useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
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
import { completeBatch, flowPickAll, logBulkLabelOverride, setFlowMode, findBox, getBox, labelCheck, overridePack, packQueue, packScan, packingSlips, savePackage, sealBox, savePackageSettings, unpack } from "../pack.server";
import { createPortal } from "react-dom";
import { assertInBatch, batchLabelFile, bulkStatus, buyLabel, labelFile, startBulkLabels } from "../labels.server";
import { flagOrder, listFlags, openFlagCount, reopenFlag, resolveFlag } from "../flags.server";
import { enterSandbox, inSandbox, leaveSandbox, resetSandbox, sandboxAdmin, sandboxShopOf, sandboxSummary } from "../sandbox.server";
import { EnterSandboxButton, SandboxBanner, SandboxSettings } from "../components/shipping/Sandbox";
import { BatchHeader, BatchList, RemoveBar, SelectionBar } from "../components/shipping/Batches";
import { PickList } from "../components/shipping/PickList";
import { PackageSettings } from "../components/shipping/Packages";
import {
  addToBatch,
  assignBatch,
  assignableStaff,
  batchAllowed,
  cancelBatch,
  finishPicking,
  getBatch,
  listBatches,
  openBatches,
  pickList,
  removeFromBatch,
  renameBatch,
  reopenPicking,
  runAutoBatch,
  saveAutoBatchSettings,
  setBatchPriority,
  batchLock,
  batchLocks,
  getBatchRow,
  scanPick,
  setPicked,
} from "../batches.server";
import { GreenButton, Items, MOTION_CSS, PINK, ProductName, QuickViewContext, STORE_TZ, ago, box, cell, fmtDate, head, input, muted, pill, small, thumb, useParamSetter } from "../components/shipping/ui";
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
  saveMethodRules,
  saveShippingSettings,
  saveReadyBeforeRelease,
  shippingOverview,
  startFullRead,
  suggestProducts,
  productTiles,
  doublePairs,
  productVariants,
  syncStatus,
  lookupOrder,
  resyncOrderByName,
} from "../shipping.server";
import { OrderLookupBox } from "../components/shipping/OrderLookup";
import { ProductPicker } from "../components/shipping/ProductPicker";

// Locks for the batches on screen (the batch itself is loaded for its priority)
async function batchLocksFor(shop, list, user, early) {
  const full = list.every((b) => b.number != null) ? list : await Promise.all(list.map((b) => getBatchRow(shop, b.id)));
  return batchLocks(shop, full.filter(Boolean), user, { early });
}

const releaseDayLabel = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

const PAGE_SIZE = 50;
const TABS = ["ready", "waiting", "batches", "review", "merge", "stock", "settings"];

const filterFrom = (params) => ({
  q: params.get("q") || "",
  method: params.get("method") || "",
  country: params.get("country") || "",
  product: params.get("product") || "",
  productName: params.get("pname") || "",
  variant: params.get("product") ? params.get("variant") || "" : "",
  // Combinations: also containing these products (with their names, for the chips)
  with: params.get("product") ? (params.get("with") || "").split(",").filter(Boolean).slice(0, 5) : [],
  withNames: params.get("product") ? (params.get("wnames") || "").split("|").slice(0, 5) : [],
  singles: params.get("singles") === "1",
  doubles: params.get("singles") !== "1" && params.get("doubles") === "1",
  pair: params.get("singles") !== "1" && params.get("doubles") === "1" ? params.get("pair") || "" : "",
  sort: params.get("sort") === "newest" ? "newest" : "oldest",
});

export const loader = async ({ request }) => {
  // Bins moved to Stock: send old links there
  {
    const p = new URL(request.url).searchParams;
    if (p.get("tab") === "bins") {
      const next = new URLSearchParams();
      for (const k of ["q", "missing"]) if (p.get(k)) next.set(k, p.get(k));
      for (const k of ["shop", "host", "embedded", "id_token", "locale"]) if (p.get(k)) next.set(k, p.get(k));
      throw redirect(`/app/stock${next.toString() ? `?${next}` : ""}`);
    }
  }
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
      ? listShipments(shop, { ...filter, state: tab }, { pageSize: PAGE_SIZE, viewer, understock: can(user, "shipping", "understock") })
      : batchId && !view
        ? listShipments(shop, { batchId, sort: filter.sort }, { pageSize: PAGE_SIZE, viewer, understock: can(user, "shipping", "understock") })
        : null,
    tab === "settings" ? recentEvents(shop, 60) : null,
    tab === "batches" && !batchId && !hiddenBatch
      ? listBatches(shop, { show: params.get("show") || "live", onlyFor: restricted || mine ? user.id : null })
      : null,
    batchId && !view ? getBatch(shop, batchId) : null,
    batchId && view === "pick" ? pickList(shop, batchId) : null,
    null, // bins: now on the Stock page
    listBatches(shop, { show: "live", onlyFor: restricted ? user.id : null }),
    tab === "ready" && canBatches ? openBatches(shop) : null,
    tab === "review" ? listFlags(shop, { status: params.get("status") === "resolved" ? "resolved" : "open" }) : null,
    openFlagCount(shop),
  ]);
  // What stops this person picking / packing (release dates, higher-priority batches)
  const early = can(user, "shipping", "pickEarly");
  const lockBatches = batchId ? [{ id: batchId }] : (batches ?? []);
  const lockMap = lockBatches.length ? await batchLocksFor(shop, lockBatches, user, early) : new Map();
  const canMerge = can(user, "shipping", "merge");
  const mergeAdmin = sandboxOn ? sandboxAdmin(admin, shop) : admin;
  const merge =
    tab === "merge" && canMerge
      ? params.get("customer")
        ? { plan: await customerPlan(shop, mergeAdmin, params.get("customer")), merges: [] }
        : { ...(await mergeCandidates(shop, mergeAdmin)), merges: await listMerges(shop) }
      : null;
  return {
    merge,
    batchLockList: Object.fromEntries(lockMap),
    lock: batchId ? (lockMap.get(batchId) ?? null) : null,
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
    // People a batch can be assigned to: on a batch, and on the batch list (To ship)
    staff: canBatches && ((batchId && !view) || (tab === "batches" && !batchId && (params.get("show") || "live") === "live")) ? await assignableStaff(shop) : [],
    sandbox: sandboxOn ? await sandboxSummary(session.shop) : null,
    // For "Review in Shopify": the order page in Shopify admin
    shopAdmin: `https://admin.shopify.com/store/${session.shop.replace(/\.myshopify\.com$/, "")}`,
    pack: batchId && view === "pack" ? await packQueue(shop, batchId, { debug: can(user, "debug", "view") }).catch(() => null) : null,
    box:
      batchId && view === "pack" && params.get("box")
        ? await getBox(shop, batchId, Number(params.get("box"))).catch(() => null)
        : null,
    slips:
      batchId && view === "slips"
        ? await packingSlips(shop, sandboxOn ? sandboxAdmin(admin, shop) : admin, batchId, (params.get("slips") || "").split(",").filter(Boolean)).catch(() => null)
        : null,
    sync: syncStatus(shop),
    // Doubles: the most common pairs; product filter: its variants
    pairs: (tab === "ready" || tab === "waiting") && filter.doubles ? await doublePairs(shop, { ...filter, state: tab }) : null,
    // Suggestions under the product search (top products; with a product chosen, what's most often alongside)
    tiles: (tab === "ready" || tab === "waiting") && !filter.doubles ? await productTiles(shop, { ...filter, state: tab }) : null,
    variants: (tab === "ready" || tab === "waiting") && filter.product ? await productVariants(shop, { ...filter, state: tab }) : null,
    // Direct printing: the packing computers (always the real shop, even in sandbox)
    printing: {
      stations: await listStations(session.shop),
      myStationId: await myStationId(session.shop, viewer),
      jobs: tab === "settings" ? await recentJobs(session.shop) : null,
      uninstall: uninstallCommand(appUrl(request)),
      agentVersion: AGENT_VERSION,
    },
    can: {
      settings: can(user, "shipping", "settings"),
      shipOutside: can(user, "shipping", "shipOutside"),
      batches: canBatches,
      pick: can(user, "shipping", "pick"),
      review: can(user, "shipping", "review"),
      pack: can(user, "shipping", "pack"),
      ship: can(user, "shipping", "ship"),
      override: can(user, "shipping", "override"),
      priority: can(user, "shipping", "priority"),
      pickEarly: can(user, "shipping", "pickEarly"),
      understock: can(user, "shipping", "understock"),
      merge: can(user, "shipping", "merge"),
      completeBatch: can(user, "shipping", "completeBatch"),
      bulkLabels: can(user, "shipping", "bulkLabels"),
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
  outsideCheck: "shipOutside",
  settings: "settings",
  sync: "settings",
  autoSettings: "settings",
  readyBeforeRelease: "settings",
  addToBatch: "batches",
  removeFromBatch: "batches",
  cancelBatch: "batches",
  renameBatch: "batches",
  autoBatch: "batches",
  scan: "pick",
  setPicked: "pick",
  finishPicking: "pick",
  reopenPicking: "pick",
  assignBatch: "batches",
  setPriority: "priority",
  ackNotice: "view",
  recheckOrder: "view",
  lookupOrder: "view",
  resyncOrder: "view",
  keepAddress: "view",
  findBox: "view",
  packScan: "pack",
  // Pack camera (its own window)
  cameraLink: "pack",
  pickPhoneLink: "pick",
  mergeOrders: "merge",
  findCustomers: "merge",
  saveBoxes: "merge",
  undoMerge: "merge",
  cameraContext: "pack",
  cameraScans: "pack",
  cameraUnlink: "pack",
  boxVideos: "pack",
  sealBox: "pack",
  unpack: "pack",
  labelCheck: "pack",
  // In-app labels: buying needs Ship; printing a bought label, Pack or Ship
  buyLabel: "ship",
  buyLabels: "ship",
  bulkLabelStatus: ["pack", "ship"],
  labelFile: ["pack", "ship"],
  batchLabelFile: ["pack", "ship"],
  methodRules: "settings",
  productSuggest: "view",
  savePackage: "pack",
  packageSettings: "settings",
  overridePack: "override",
  // Flow mode: turned on/off by someone who can both pick and pack (checked below)
  setFlow: "pack",
  flowPickAll: "override",
  completeBatch: "completeBatch",
  bulkLabelsOverride: "bulkLabels",
  flagOrder: "review",
  resolveFlag: "review",
  reopenFlag: "review",
  // Direct printing (packing computers)
  agentPrint: ["pick", "pack", "ship", "batches"],
  printJobs: "view",
  printStations: "view",
  setMyStation: "view",
  retryPrint: ["pick", "pack", "ship", "batches"],
  testPrint: ["settings", "pack", "ship"],
  addStation: "settings",
  saveStation: "settings",
  removeStation: "settings",
  installCode: "settings",
  refreshPrinters: "settings",
};

export const action = async ({ request }) => {
  const { session, admin: realAdmin, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!NEEDS[intent]) return { intent, error: "Unknown action" };
  if (!IN_APP_LABELS && (intent === "buyLabel" || intent === "buyLabels")) return { intent, error: "Labels are bought on Shopify's own pages for now." };
  const needs = [NEEDS[intent]].flat();
  if (!needs.some((c) => can(user, "shipping", c))) return { intent, ...denied("shipping", needs[0]) };
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
  // Release dates and priority order: pick / pack the right batch first
  const stage = PICK_INTENTS.has(intent) ? "pick" : PACK_INTENTS.has(intent) ? "pack" : null;
  if (stage && id) {
    const lock = await batchLock(shop, id, user, { early: can(user, "shipping", "pickEarly") });
    if (lock?.[stage]) return { intent, ok: false, error: lock[stage], locked: true };
  }
  if (intent === "resetSandbox") {
    if (!sandboxOn) return { intent, error: "You're not in sandbox mode." };
    return { intent, ok: true, ...(await resetSandbox(session.shop, user)) };
  }
  if (intent === "sync" && sandboxOn) return { intent, error: "Reading from Shopify is off in sandbox. Use Reset copy in the sandbox bar for fresh data." };
  try {
    if (intent === "productSuggest") {
      return {
        intent,
        q: String(form.get("q") ?? ""),
        products: await suggestProducts(shop, {
          q: form.get("q"),
          state: String(form.get("state") ?? "ready"),
          singles: form.get("singles") === "1",
          doubles: form.get("doubles") === "1",
          withIds: String(form.get("with") ?? ""),
        }),
      };
    }
    if (intent === "more") {
      const filter = JSON.parse(String(form.get("filter") ?? "{}"));
      const page = Number(form.get("page") ?? 2);
      return { intent, ...(await listShipments(shop, filter, { page, pageSize: PAGE_SIZE, viewer: staffKeyOf(user), understock: can(user, "shipping", "understock") })) };
    }
    if (intent === "outside") {
      await allowOutsideBatch(shop, admin, id, user, form.get("reason"));
      return { intent, ok: true, id };
    }
    if (intent === "clearOutside") {
      await clearOutsideBatch(shop, id, user);
      return { intent, ok: true, id };
    }
    // Shipped outside a batch: has Shopify got the label yet? (and a merged box's other orders go with it)
    if (intent === "outsideCheck") return { intent, ok: true, id, ...(await checkShipped(shop, admin, id)) };
    if (intent === "readyBeforeRelease") {
      await saveReadyBeforeRelease(shop, form.get("hours"), user);
      runNow(shop, { full: false }).catch(() => {});
      return { intent, ok: true };
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
    if (intent === "lookupOrder") return { intent, ...(await lookupOrder(shop, admin, form.get("q"))) };
    if (intent === "resyncOrder") {
      if (sandboxOn) return { intent, error: "Reading from Shopify is off in sandbox. Leave sandbox to re-sync an order." };
      return { intent, resynced: true, ...(await resyncOrderByName(shop, realAdmin, form.get("q"))) };
    }
    if (intent === "recheckOrder") return { intent, ok: true, ...(await recheckOrder(shop, admin, id)) };
    if (intent === "keepAddress") return { intent, ok: true, ...(await keepAddress(shop, id, user)) };
    if (intent === "ackNotice") return { intent, ok: true, ...(await ackNotice(shop, id, String(form.get("context") ?? "view"), user)) };
    if (intent === "findBox") return { intent, ...(await findBox(shop, id, String(form.get("code") ?? ""))) };
    if (intent === "packScan")
      return {
        intent,
        ...(await packScan(shop, id, Number(form.get("shipmentId")), String(form.get("code") ?? ""), user, {
          via: form.get("via") === "visual" ? "visual" : "barcode",
          holdForSeal: form.get("holdForSeal") === "1",
        })),
      };
    if (intent === "sealBox") return { intent, ...(await sealBox(shop, id, Number(form.get("shipmentId")), user)) };
    if (intent === "cameraLink")
      return { intent, ok: true, ...(await benchLink(session.shop, shop, user, appUrl(request), { batchId: form.get("batchId") || null, shipmentId: form.get("shipmentId") || null })) };
    if (intent === "findCustomers") return { intent, q: String(form.get("q") ?? ""), customers: await searchCustomers(shop, form.get("q")) };
    if (intent === "saveBoxes") {
      const plan = JSON.parse(String(form.get("plan") ?? "{}"));
      return { intent, ok: true, ...(await saveBoxes(shop, admin, { customerId: String(form.get("customer") ?? ""), boxes: plan.boxes ?? [] }, user)) };
    }
    if (intent === "mergeOrders") {
      const riders = JSON.parse(String(form.get("riders") ?? "[]"));
      return { intent, ok: true, ...(await createMerge(shop, { mainShipmentId: form.get("main"), riders, method: form.get("method") || null }, user)) };
    }
    if (intent === "undoMerge") {
      await undoMerge(shop, id, user);
      return { intent, ok: true };
    }
    if (intent === "pickPhoneLink") return { intent, ok: true, ...(await pickPhoneLink(session.shop, shop, user, appUrl(request), id)) };
    if (intent === "cameraContext") {
      await benchContext(session.shop, shop, user, { batchId: form.get("batchId") || null, shipmentId: form.get("shipmentId") || null });
      return { intent, ok: true };
    }
    if (intent === "cameraScans") return { intent, ok: true, ...(await benchTakeScans(session.shop, shop, user)) };
    if (intent === "cameraUnlink") return { intent, ok: true, ...(await benchUnlink(session.shop, shop, user)) };
    if (intent === "boxVideos") return { intent, ok: true, shipmentId: Number(form.get("shipmentId")), videos: await videosFor(session.shop, form.get("shipmentId")) };
    if (intent === "bulkLabelsOverride") return { intent, ok: true, ...(await logBulkLabelOverride(shop, id, user)) };
    if (intent === "completeBatch") {
      // A batch held for its release date: only people allowed to pick early
      const lock = await batchLock(shop, id, user, { early: can(user, "shipping", "pickEarly") });
      if (lock?.releaseDay && !can(user, "shipping", "pickEarly")) return { intent, error: lock.pick ?? "This batch waits for its release date." };
      return { intent, ok: true, ...(await completeBatch(shop, id, form.get("reason"), user)) };
    }
    if (intent === "overridePack") return { intent, ...(await overridePack(shop, id, Number(form.get("shipmentId")), form.get("reason"), user)) };
    if (intent === "flowPickAll") return { intent, ...(await flowPickAll(shop, id, Number(form.get("shipmentId")), user)) };
    if (intent === "setFlow") {
      if (!can(user, "shipping", "pick")) return { intent, error: "Flow mode needs both the Pick and Pack permissions." };
      return { intent, ...(await setFlowMode(shop, id, form.get("on") === "true", user)) };
    }
    if (intent === "labelCheck") return { intent, ...(await labelCheck(shop, admin, id, Number(form.get("shipmentId")))) };
    if (intent === "buyLabel") {
      const sid = Number(form.get("shipmentId"));
      await assertInBatch(shop, id, sid);
      const r = await buyLabel(shop, admin, sid, { shipDate: form.get("shipDate") || null }, user);
      const check = r.ok ? await labelCheck(shop, admin, id, sid).catch(() => null) : null;
      return { intent, ...r, shipped: check?.shipped ?? false };
    }
    if (intent === "buyLabels") {
      const override = JSON.parse(String(form.get("override") ?? "null"));
      const job = await startBulkLabels(shop, id, { override, notify: form.get("notify") === null ? undefined : form.get("notify") === "1", shipDate: form.get("shipDate") || null }, user);
      return { intent, ok: true, job };
    }
    if (intent === "bulkLabelStatus") return { intent, job: bulkStatus(shop, id) };
    if (intent === "labelFile") {
      const sid = Number(form.get("shipmentId"));
      await assertInBatch(shop, id, sid);
      return { intent, ok: true, purpose: String(form.get("purpose") ?? "print"), shipmentId: sid, file: await labelFile(shop, admin, sid, user) };
    }
    if (intent === "batchLabelFile") return { intent, ok: true, purpose: String(form.get("purpose") ?? "print"), file: await batchLabelFile(shop, admin, id, user) };
    if (intent === "agentPrint") return { intent, ...(await printOnStation({ shop, printShop: session.shop, admin, user, form, id })) };
    if (intent === "printJobs") return { intent, jobs: await jobStatus(session.shop, JSON.parse(String(form.get("ids") ?? "[]"))) };
    if (intent === "printStations") return { intent, stations: await listStations(session.shop), ...(form.get("jobs") === "1" ? { jobs: await recentJobs(session.shop) } : {}) };
    if (intent === "setMyStation") return (await rememberStation(session.shop, staffKeyOf(user), Number(form.get("stationId")) || null), { intent, ok: true });
    if (intent === "retryPrint") return { intent, ...(await retryJob(session.shop, id, user)) };
    if (intent === "testPrint") return { intent, role: String(form.get("role")), ...(await testPrint(session.shop, id, ["slip", "barcode"].includes(form.get("role")) ? String(form.get("role")) : "label", user)) };
    if (intent === "addStation") return { intent, ok: true, ...(await addStation(session.shop, form.get("name"), user, appUrl(request))) };
    if (intent === "installCode") return { intent, ok: true, ...(await newInstallCode(session.shop, id, appUrl(request))) };
    if (intent === "removeStation") return { intent, ok: true, ...(await removeStation(session.shop, id)) };
    if (intent === "refreshPrinters") return { intent, ok: true, ...(await refreshPrinters(session.shop, id)) };
    if (intent === "saveStation") {
      const input = {};
      for (const k of ["name", "labelPrinter", "slipPrinter", "barcodePrinter", "labelOptions", "slipOptions", "slipSize"]) if (form.has(k)) input[k] = String(form.get(k));
      return { intent, ok: true, station: await saveStation(session.shop, id, input) };
    }
    if (intent === "methodRules") {
      await saveMethodRules(shop, JSON.parse(String(form.get("rules") ?? "{}")), user);
      return { intent, ok: true };
    }
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
          {
            step: String(form.get("step")),
            weightUnit: String(form.get("weightUnit")),
            dimUnit: String(form.get("dimUnit")),
            boxes: form.get("boxes"),
            packedTag: form.get("packedTag") === "1",
            labelBoxId: form.get("labelBoxId") || null,
            labelNotify: form.has("labelNotify") ? form.get("labelNotify") === "1" : undefined,
          },
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
    if (intent === "setPriority") return { intent, ok: true, ...(await setBatchPriority(shop, id, form.get("priority"), user)) };
    if (intent === "autoBatch") return { intent, ok: true, ...(await runAutoBatch(shop, user)) };
    if (intent === "autoSettings") {
      await saveAutoBatchSettings(
        shop,
        {
          enabled: form.get("enabled") === "1",
          time: String(form.get("time") ?? ""),
          singles: form.get("singles") === "1",
          min: form.get("min"),
          identical: form.get("identical") === "1",
          identicalMin: form.get("identicalMin"),
          multiples: form.get("multiples") === "1",
          multiMin: form.get("multiMin"),
          multiMaxOther: form.get("multiMaxOther"),
          multiMaxItems: form.get("multiMaxItems"),
          release: form.get("release") === "1",
          releaseDays: form.get("releaseDays"),
        },
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
    if (intent === "sync") {
      return { intent, ok: true, ...startFullRead(shop) };
    }
  } catch (e) {
    if (!(e instanceof ShippingError) && !(e instanceof PrintError)) console.error(`[shipping] ${intent}:`, e);
    return { intent, id, error: e?.message ?? String(e) };
  }
  return { intent, error: "Unknown action" };
};

// Send a label, a batch's labels, or packing slips to this person's packing computer.
// Returns { job } when queued, or { fallback, text } when the browser should print instead.
async function printOnStation({ shop, printShop, admin, user, form, id }) {
  const what = String(form.get("what") ?? "");
  const role = what === "slips" ? "slip" : "label";
  if (!["label", "labels", "slips"].includes(what)) return { error: "Unknown print" };
  if (role === "label" && !["pack", "ship"].some((c) => can(user, "shipping", c))) return denied("shipping", "pack");
  const stationId = Number(form.get("stationId")) || null;
  const ready = await stationReady(printShop, stationId, role);
  if (!ready.ready) return { what, fallback: ready.reason, text: fallbackText(ready) };
  let doc;
  let count = 1;
  if (what === "label") {
    const sid = Number(form.get("shipmentId"));
    await assertInBatch(shop, id, sid);
    const f = await labelFile(shop, admin, sid, user);
    doc = { title: f.filename.replace(/\.\w+$/, ""), format: f.format, bytes: Buffer.from(f.data, "base64") };
  } else if (what === "labels") {
    const f = await batchLabelFile(shop, admin, id, user);
    count = f.count;
    doc = { title: f.filename.replace(/\.\w+$/, ""), format: f.format, bytes: Buffer.from(f.data, "base64") };
  } else {
    const ids = String(form.get("ids") ?? "").split(",").filter(Boolean);
    const data = await packingSlips(shop, admin, id, ids);
    if (!data.slips.length) return { what, error: "There are no packing slips to print." };
    count = data.slips.length;
    let bytes;
    try {
      bytes = await slipsPdf(data, ready.station.slipSize === "4x6" ? "4x6" : "letter");
    } catch (e) {
      console.error("[print] slips PDF:", e?.message ?? e);
      return { what, fallback: "server", text: "The slips couldn't be made into a file on the server" };
    }
    doc = { title: count === 1 ? `Packing slip ${data.slips[0].orderName}` : `${count} packing slips ${data.batch.tag}`, format: "PDF", bytes };
  }
  await rememberStation(printShop, staffKeyOf(user), stationId);
  return { what, count, ...(await queuePrint(printShop, stationId, { ...doc, role, kind: what }, user)) };
}

// Picking and packing steps (blocked by a release date still to come, or a higher-priority batch)
const PICK_INTENTS = new Set(["scan", "setPicked", "finishPicking"]);
const PACK_INTENTS = new Set(["packScan", "sealBox", "overridePack", "flowPickAll"]);

// Actions on a batch (its id is in "id"): people limited to their assigned batches only get theirs
const BATCH_INTENTS = new Set([
  "scan", "setPicked", "finishPicking", "reopenPicking", "packScan", "findBox", "overridePack", "unpack", "labelCheck", "savePackage",
  "buyLabel", "buyLabels", "bulkLabelStatus", "labelFile", "batchLabelFile", "agentPrint",
  "removeFromBatch", "cancelBatch", "renameBatch", "assignBatch", "addToBatch", "setPriority", "sealBox", "pickPhoneLink", "completeBatch", "bulkLabelsOverride",
]);

// Busy, local-only actions don't reload the whole page
const LOCAL = new Set(["bulkLabelsOverride", "findCustomers", "more", "order", "scan", "setPicked", "setBin", "exportBins", "packScan", "findBox", "ackNotice", "recheckOrder", "keepAddress", "labelCheck", "savePackage", "productSuggest", "labelFile", "batchLabelFile", "bulkLabelStatus",
  "agentPrint", "printJobs", "printStations", "setMyStation", "retryPrint", "testPrint"]);
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
  const admin = useContext(ShopAdminContext);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const busy = fetcher.state !== "idle";
  if (s.override) {
    const others = s.merge?.role === "box" ? (s.merge.orders ?? []).map((o) => o.orderName) : [];
    const checked = fetcher.data?.intent === "outsideCheck" ? fetcher.data : null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", maxWidth: "240px" }}>
        <span style={pill("#e8f0fe", "#1c4a9c")}>Let through</span>
        <div style={small}>
          {s.override.by ?? "Staff"}: {s.override.reason}
        </div>
        {/* Buying the label: on the order in Shopify, like from a batch's Pack page */}
        {admin && (
          <GreenButton href={`${admin}/orders/${s.orderNumber}`} target="_blank">
            Buy label in Shopify ↗
          </GreenButton>
        )}
        {others.length > 0 && (
          <div style={small}>
            This box also holds {others.join(", ")}'s items. Shopify's label page only lists {s.orderName}; they're marked shipped with the same tracking once
            the label's bought.
          </div>
        )}
        <s-button
          variant="tertiary"
          onClick={() => fetcher.submit({ intent: "outsideCheck", id: String(s.id) }, { method: "post" })}
          {...(busy && fetcher.formData?.get("intent") === "outsideCheck" ? { loading: true } : {})}
        >
          Bought it? Check Shopify
        </s-button>
        {checked && (
          <div style={{ ...small, color: checked.shipped ? "#1a5e20" : "#7a4f01" }}>
            {checked.shipped
              ? `Shipped ✓${checked.merged.length ? ` · ${checked.merged.join(", ")} marked shipped too` : ""}`
              : "Shopify doesn't show a label for it yet."}
          </div>
        )}
        {fetcher.data?.error && <span style={{ color: "#b42318", fontSize: "12px" }}>{fetcher.data.error}</span>}
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
  // Understocked items: a merged box's own plus the merged-in orders'
  const under = [];
  for (const u of [...(s.understocked ?? []), ...(s.merge?.orders ?? []).flatMap((o) => o.understocked ?? [])]) {
    if (!under.some((x) => x.title === u.title)) under.push(u);
  }
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
        {s.merge?.orders?.map((o) => (
          <div key={o.shipmentId} style={small}>
            + <OrderLink orderId={o.orderId} orderNumber={o.orderNumber} name={o.orderName} />
          </div>
        ))}
        {s.part && <div style={small}>Part {s.part}</div>}
        <div style={small}>{fmtDate(s.orderCreatedAt)}</div>
      </td>
      <td style={cell}>{s.customerName ?? <span style={muted}>—</span>}</td>
      <td style={cell}>
        <Items lines={s.merge?.role === "box" ? [...s.lines, ...s.merge.items] : s.lines} />
      </td>
      <td style={cell}>
        {s.shippingMethod ? <MethodBadge method={s.shippingMethod} /> : <span style={muted}>—</span>}
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
        {s.merge?.role === "box" && (
          <div style={{ marginTop: "4px" }}>
            <span style={pill("#eef3ff", "#1c4a9c")}>Merged box</span>
            <div style={small}>
              {[s.orderName, ...(s.merge.orders ?? []).map((o) => o.orderName)].join(" + ")} ship together
            </div>
            {(s.merge.orders ?? [])
              .filter((o) => o.waitingReason)
              .map((o) => (
                <div key={o.shipmentId} style={{ ...small, color: "#7a4f01" }}>
                  {o.orderName}: {o.waitingReason}
                </div>
              ))}
          </div>
        )}
        {s.merge?.role === "part" && (
          <div style={{ marginTop: "4px" }}>
            <span style={pill("#eef3ff", "#1c4a9c")}>In {s.merge.into}'s box</span>
            <div style={small}>Merged: this order isn't batched on its own until that box ships.</div>
          </div>
        )}
        {under.length > 0 && (
          <div style={{ marginTop: "4px" }}>
            <span
              style={pill("#fde7e9", "#8e1f0b")}
              title={under.map((u) => `${u.title}: ${u.ordered} on open orders, ${u.inStock} in stock`).join("\n")}
            >
              Understocked
            </span>
            <div style={{ ...small, color: "#8e1f0b" }}>
              {under.map((u) => `${u.title}: ${u.ordered} ordered, ${u.inStock} in stock`).join(" · ")}
            </div>
          </div>
        )}
        {!waiting && s.releaseDay && (
          <div style={{ marginTop: "4px" }}>
            <span style={pill("#fff1e3", "#8a4b00")} title="Shown ahead of its release date: it can't be picked or packed before then">
              Releases {releaseDayLabel(s.releaseDay)}
            </span>
          </div>
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
        {state !== "batch" && [filter.q, filter.method, filter.country, filter.product, filter.singles, filter.doubles].some(Boolean) ? " Try clearing the filters." : ""}
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

function Filters({ filter, overview, state = "ready", pairs = null, variants = null, tiles = null }) {
  const [params, setParams] = useSearchParams();
  const navigation = useNavigation();
  const [q, setQ] = useState(filter.q);
  const timer = useRef(null);
  // Several URL params at once ({ key: value | null })
  const setMany = (patch) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { preventScrollReset: true, replace: true },
    );
  const set = (k, v) => setMany({ [k]: v });
  const toggle = (on) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    borderRadius: "999px",
    border: `1px solid ${on ? "#303030" : "#c9c9c9"}`,
    background: on ? "#303030" : "#fff",
    color: on ? "#fff" : "#303030",
    cursor: "pointer",
    fontSize: "13px",
  });
  const showVariants = filter.product && variants && (variants.length > 1 || filter.variant);
  const setCombo = (ids, names) => setMany({ with: ids.length ? ids.join(",") : null, wnames: ids.length ? names.map((n) => String(n).replace(/\|/g, "/")).join("|") : null });
  return (
    <>
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
        doubles={filter.doubles}
        onPick={(p) => setMany({ product: p?.productId ?? null, pname: p ? p.title ?? "" : null, variant: null, with: null, wnames: null })}
      />
      {/* Combinations: shipments that also contain these products */}
      {filter.product && (
        <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
          {filter.with.map((id, i) => (
            <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "4px 6px 4px 10px", borderRadius: "999px", background: "#f1f1f1", fontSize: "13px", fontWeight: 600 }}>
              <span style={{ color: "#616161", fontWeight: 400 }}>+</span> {filter.withNames[i] || "Product"}
              <button
                type="button"
                aria-label={`Remove ${filter.withNames[i] || "product"}`}
                onClick={() => setCombo(filter.with.filter((_, j) => j !== i), filter.withNames.filter((_, j) => j !== i))}
                style={{ border: 0, background: "none", cursor: "pointer", fontSize: "15px", lineHeight: 1, color: "#616161", padding: "0 2px" }}
              >
                ×
              </button>
            </span>
          ))}
          {filter.with.length < 5 && (
            <ProductPicker
              key={`with:${filter.with.join(",")}`}
              value=""
              name=""
              state={state}
              singles={filter.singles}
              doubles={filter.doubles}
              withIds={[filter.product, ...filter.with]}
              placeholder="+ and another product"
              label="Also contains product"
              clearOnPick
              onPick={(p) => p && setCombo([...filter.with, p.productId], [...filter.withNames, p.title ?? ""])}
            />
          )}
        </span>
      )}
      {showVariants && (
        <select value={filter.variant} onChange={(e) => set("variant", e.target.value)} style={{ ...input, maxWidth: "260px" }} aria-label="Variant">
          <option value="">All variants ({variants.reduce((n, v) => n + v.shipments, 0)})</option>
          {variants.map((v) => (
            <option key={v.variantId} value={v.variantId}>
              {v.title}
              {v.sku ? ` · ${v.sku}` : ""} ({v.shipments})
            </option>
          ))}
          {filter.variant && !variants.some((v) => v.variantId === filter.variant) && <option value={filter.variant}>Chosen variant (0)</option>}
        </select>
      )}
      <label style={toggle(filter.singles)} title="Shipments with just one item in them">
        <input type="checkbox" checked={filter.singles} onChange={(e) => setMany({ singles: e.target.checked ? "1" : null, doubles: null, pair: null })} style={{ margin: 0 }} />
        Singles
      </label>
      <label style={toggle(filter.doubles)} title="Shipments with exactly two items: shows the most common pairs">
        <input type="checkbox" checked={filter.doubles} onChange={(e) => setMany({ doubles: e.target.checked ? "1" : null, singles: null, pair: null })} style={{ margin: 0 }} />
        Doubles
      </label>
      <select value={filter.sort} onChange={(e) => set("sort", e.target.value === "newest" ? "newest" : "")} style={input} aria-label="Order">
        <option value="oldest">Oldest orders first</option>
        <option value="newest">Newest orders first</option>
      </select>
      {navigation.state === "loading" && <span style={muted}>Loading…</span>}
    </div>
    {filter.doubles && pairs && <PairList pairs={pairs} chosen={filter.pair} onChoose={(key) => set("pair", key)} />}
    {tiles && (!filter.product || filter.with.length < 5) && (
      <ProductTiles
        tiles={tiles}
        chosenName={[filter.productName, ...filter.withNames].filter(Boolean).join(" + ")}
        onChoose={(p) =>
          filter.product
            ? setCombo([...filter.with, p.productId], [...filter.withNames, p.title ?? ""])
            : setMany({ product: p.productId, pname: p.title ?? "", variant: null, with: null, wnames: null })
        }
      />
    )}
    </>
  );
}

// Under the product search: the products with the most orders, or (with products
// chosen) the ones most often in the same box. Picking one adds it to the search.
function ProductTiles({ tiles, chosenName, onChoose }) {
  if (!tiles.products.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", margin: "-2px 0 12px" }}>
      <span style={{ ...small, marginRight: "2px" }}>{tiles.paired ? `Most often with ${chosenName || "your products"}:` : "Most orders:"}</span>
      {tiles.products.map((p) => (
        <button
          key={p.productId}
          type="button"
          onClick={() => onChoose(p)}
          title={tiles.paired ? `Also contains ${p.title}` : `Show orders with ${p.title}`}
          style={{ appearance: "none", display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px 3px 4px", border: "1px solid #dcdcdc", borderRadius: "999px", background: "#fff", font: "inherit", fontSize: "12px", cursor: "pointer", maxWidth: "260px" }}
        >
          {p.imageUrl ? (
            <img src={p.imageUrl} alt="" style={{ width: "20px", height: "20px", objectFit: "cover", borderRadius: "50%", flexShrink: 0 }} />
          ) : (
            <span style={{ width: "20px", height: "20px", borderRadius: "50%", background: "#f1f1f1", flexShrink: 0 }} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tiles.paired ? "+ " : ""}
            {p.title}
          </span>
          <span style={{ color: "#616161", fontVariantNumeric: "tabular-nums" }}>{p.shipments.toLocaleString()}</span>
        </button>
      ))}
    </div>
  );
}

// Doubles: the biggest pairings, as tiles; picking one filters the list to it (ready to batch)
function PairList({ pairs, chosen, onChoose }) {
  if (!pairs.pairs.length) return <div style={{ ...small, marginBottom: "10px" }}>No two-item shipments here.</div>;
  const name = (i) => `${i.title}${i.variantTitle ? ` – ${i.variantTitle}` : ""}`;
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ ...small, marginBottom: "6px" }}>
        Biggest pairs: {pairs.shipments.toLocaleString()} two-item shipment{pairs.shipments === 1 ? "" : "s"} in {pairs.combinations.toLocaleString()} combination
        {pairs.combinations === 1 ? "" : "s"}
        {pairs.combinations > pairs.pairs.length ? ` (top ${pairs.pairs.length})` : ""}. Pick one to show just those, then select and batch them.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "8px" }}>
        {pairs.pairs.map((g) => {
          const on = chosen === g.key;
          return (
            <button
              key={g.key}
              type="button"
              aria-pressed={on}
              onClick={() => onChoose(on ? "" : g.key)}
              title={g.items.map((i) => `${i.qty} × ${name(i)}`).join("\n")}
              style={{
                appearance: "none",
                display: "flex",
                gap: "8px",
                alignItems: "center",
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: "10px",
                border: `${on ? 2 : 1}px solid ${on ? "#303030" : "#e3e3e3"}`,
                background: on ? "#f4f4f4" : "#fff",
                cursor: "pointer",
                font: "inherit",
              }}
            >
              <span style={{ display: "inline-flex", flexShrink: 0 }}>
                {g.items.map((i, n) => (
                  <img key={n} src={i.imageUrl || undefined} alt="" style={{ ...thumb, width: "34px", height: "34px", marginLeft: n ? "-10px" : 0, border: "2px solid #fff" }} />
                ))}
              </span>
              <span style={{ minWidth: 0, flex: 1, fontSize: "13px", lineHeight: 1.3 }}>
                {g.items.map((i, n) => (
                  <span key={n} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {i.qty > 1 ? <strong>{i.qty} × </strong> : n ? <span style={muted}>+ </span> : null}
                    {name(i)}
                  </span>
                ))}
              </span>
              <span style={{ fontWeight: 700, fontSize: "15px", flexShrink: 0 }}>{g.shipments}</span>
            </button>
          );
        })}
      </div>
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
  batch_done: "Batch shipped",
  batch_priority: "Batch priority",
  batch_completed: "Batch marked packed",
  boxes_planned: "Boxes planned",
  orders_merged: "Orders merged",
  orders_unmerged: "Merge undone",
  merged_shipped: "Shipped in a merged box",
  ready_before_release: "Pre-order timing",
  batch_renamed: "Batch renamed",
  batch_assigned: "Batch assigned",
  batch_picked: "Batch picked",
  batch_pick_reopened: "Picking reopened",
  auto_batch: "Auto-batching",
  auto_batch_settings: "Auto-batching settings",
  bins_imported: "Bins imported",
};

function SettingsTab({ overview, events, sync: status, canSettings, sandboxOn, printing, canPrint }) {
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

      <ReleaseSettings st={st} canSettings={canSettings} />

      <AutoBatchSettings st={st} canSettings={canSettings} />

      <PackageSettings st={st} canSettings={canSettings} />

      <MethodRulesSettings rules={st.methodRules} methods={overview?.methods ?? []} canSettings={canSettings} />

      <PackingComputers printing={printing} canSettings={canSettings} canPrint={canPrint} />

      {IN_APP_LABELS && <LabelPrintingHelp />}

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
                    <td style={cell}>{e.orderName ? <OrderLink orderId={e.orderId} orderNumber={e.orderNumber} name={e.orderName} /> : "—"}</td>
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

// Pre-orders: how soon before the release date they show in Ready to ship
function ReleaseSettings({ st, canSettings }) {
  const fetcher = useFetcher();
  const saved = String(st.readyBeforeReleaseHours ?? 48);
  const [hours, setHours] = useState(saved);
  useEffect(() => setHours(saved), [saved]);
  const dirty = hours !== saved;
  return (
    <s-section heading="Pre-orders">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <span>Show pre-orders in Ready to ship</span>
        <input
          type="number"
          min="0"
          max="720"
          step="1"
          value={hours}
          disabled={!canSettings}
          onChange={(e) => setHours(e.target.value)}
          style={{ ...input, width: "80px" }}
          aria-label="Hours before release"
        />
        <span>hours before their release date (0: on the release date).</span>
      </div>
      <div style={{ ...small, marginTop: "6px" }}>
        So they can be batched and prepared early. They're marked with their release date, can't be picked or packed before it (except by people allowed to
        pick early), and stay on hold in Shopify until then when holds are on. Stock still has to be in for them to count as ready.
      </div>
      {canSettings && (
        <div style={{ marginTop: "10px", display: "flex", gap: "8px", alignItems: "center" }}>
          <s-button
            variant="primary"
            onClick={() => fetcher.submit({ intent: "readyBeforeRelease", hours }, { method: "post" })}
            {...(fetcher.state !== "idle" ? { loading: true } : {})}
            {...(!dirty ? { disabled: true } : {})}
          >
            Save
          </s-button>
          {fetcher.data?.intent === "readyBeforeRelease" && fetcher.data.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
          {fetcher.data?.intent === "readyBeforeRelease" && fetcher.data.ok && !dirty && fetcher.state === "idle" && (
            <span style={{ color: "#1a5e20" }}>Saved. The Ready list updates in a minute or two.</span>
          )}
        </div>
      )}
    </s-section>
  );
}

const AUTO_FIELDS = {
  enabled: (st) => st.autoBatchEnabled,
  time: (st) => st.autoBatchTime,
  singles: (st) => st.autoSingleItem,
  min: (st) => String(st.autoSingleMin),
  identical: (st) => Boolean(st.autoIdentical),
  identicalMin: (st) => String(st.autoIdenticalMin ?? 10),
  multiples: (st) => Boolean(st.autoMultiples),
  multiMin: (st) => String(st.autoMultiMin ?? 20),
  multiMaxOther: (st) => String(st.autoMultiMaxOther ?? 3),
  multiMaxItems: (st) => String(st.autoMultiMaxItems ?? 25),
  release: (st) => Boolean(st.autoRelease),
  releaseDays: (st) => String(st.autoReleaseDays ?? 3),
};
const autoFrom = (st) => Object.fromEntries(Object.entries(AUTO_FIELDS).map(([k, f]) => [k, f(st)]));

function AutoBatchSettings({ st, canSettings }) {
  const fetcher = useFetcher();
  const saved = autoFrom(st);
  const [v, setV] = useState(saved);
  const savedKey = JSON.stringify(saved);
  useEffect(() => setV(JSON.parse(savedKey)), [savedKey]);
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const dirty = JSON.stringify(v) !== savedKey;
  const row = { display: "flex", gap: "10px", alignItems: "flex-start", flexWrap: "wrap" };
  const num = (k, label, { min = 1, max = 5000, on = true, width = "70px" } = {}) => (
    <input type="number" min={min} max={max} value={v[k]} disabled={!canSettings || !on} onChange={set(k)} style={{ ...input, width, padding: "3px 6px" }} aria-label={label} />
  );
  const rule = { display: "flex", gap: "10px", alignItems: "flex-start" };
  return (
    <s-section heading="Auto-batching">
      <s-paragraph>
        <span style={muted}>
          Builds batches on its own, oldest orders first, up to 250 per batch. The rules run in this order and each order goes into one batch at most. Runs from
          the Batches tab whenever you like, and once a day if the schedule is on. Shipments already in a batch are never moved; orders flagged for review wait. New orders that fit an auto-batch that's still open (not being picked yet) join it,
          even when there aren't enough of them to make a new batch.
        </span>
      </s-paragraph>
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "10px" }}>
        <label style={rule}>
          <input type="checkbox" checked={v.singles} disabled={!canSettings} onChange={set("singles")} style={{ marginTop: "4px" }} />
          <span>
            <strong>Single items:</strong> when more than {num("min", "Single items minimum", { on: v.singles })} shipments of one item (one unit, nothing
            else in the box) are ready, they go into a batch named after the item, e.g. "Lore Vol. 1 singles".
          </span>
        </label>
        <label style={rule}>
          <input type="checkbox" checked={v.identical} disabled={!canSettings} onChange={set("identical")} style={{ marginTop: "4px" }} />
          <span>
            <strong>Identical orders:</strong> when at least {num("identicalMin", "Identical orders minimum", { min: 2, on: v.identical })} orders have exactly
            the same items and quantities, they're batched together, e.g. "Lore Vol. 1 + Lore Vol. 2 identical".
          </span>
        </label>
        <div style={rule}>
          <input type="checkbox" checked={v.multiples} disabled={!canSettings} onChange={set("multiples")} style={{ marginTop: "4px" }} aria-label="Multiples" />
          <span>
            <strong>Multiples:</strong> orders with more than one item that share an anchor item (the most common item first), e.g. "Lore Vol. 3 multiples".
            <span style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", marginTop: "6px", ...small, color: "#303030" }}>
              <span>At least {num("multiMin", "Multiples minimum orders", { min: 2, on: v.multiples })} orders</span>
              <span>Up to {num("multiMaxOther", "Other items per order", { min: 0, max: 50, on: v.multiples, width: "60px" })} other items in each order</span>
              <span>Up to {num("multiMaxItems", "Different items per batch", { max: 500, on: v.multiples, width: "60px" })} different items per batch</span>
            </span>
          </span>
        </div>
        <label style={rule}>
          <input type="checkbox" checked={v.release} disabled={!canSettings} onChange={set("release")} style={{ marginTop: "4px" }} />
          <span>
            <strong>Upcoming releases:</strong> pre-orders releasing in the next {num("releaseDays", "Days before release", { max: 60, on: v.release, width: "60px" })}{" "}
            days are batched ahead with the rules above (one batch per release date, e.g. "Lore Vol. 4 singles · releases Nov 12"). Those batches can't be picked
            or packed until the release date, except by people allowed to pick early.
          </span>
        </label>
        <label style={{ ...row, alignItems: "center" }}>
          <input type="checkbox" checked={v.enabled} disabled={!canSettings} onChange={set("enabled")} />
          <span>
            Run every day at <input type="time" value={v.time} disabled={!canSettings || !v.enabled} onChange={set("time")} style={input} aria-label="Time" /> (store
            time, Los Angeles)
          </span>
        </label>
        <div style={small}>Last run: {st.lastAutoBatchAt ? fmtDate(st.lastAutoBatchAt, true) : "never"}</div>
        {canSettings && (
          <div style={{ ...row, alignItems: "center" }}>
            <s-button
              variant="primary"
              onClick={() =>
                fetcher.submit(
                  { intent: "autoSettings", ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "boolean" ? (x ? "1" : "") : x])) },
                  { method: "post" },
                )
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

function BatchDetail({ batch, list, filter, allowed, staff, me, lock }) {
  const [selected, setSelected] = useState(() => new Set());
  const [removed, setRemoved] = useState(null); // what the last "Take out" did
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
      <BatchHeader batch={batch} canBatches={allowed.batches} canPick={allowed.pick} canPack={allowed.pack} staff={staff} me={me} canPriority={allowed.priority} lock={lock} canComplete={allowed.completeBatch} />
      {editable && (
        <RemoveBar
          batch={batch}
          ids={[...selected]}
          onDone={(r) => {
            setSelected(new Set());
            setRemoved(r);
          }}
        />
      )}
      {removed?.removed > 0 && (
        <div style={{ margin: "0 0 10px" }}>
          <s-banner tone={removed.unpacked?.length || removed.skipped?.length ? "warning" : "success"} heading={`${removed.removed} taken out of ${batch.tag}; back on Ready to ship`} dismissible onDismiss={() => setRemoved(null)}>
            {removed.unpacked?.length > 0 && (
              <s-paragraph>
                {removed.unpacked.join(", ")} {removed.unpacked.length === 1 ? "was" : "were"} packed: take the items out of {removed.unpacked.length === 1 ? "that box" : "those boxes"} and back to the shelf. {removed.unpacked.length === 1 ? "It's" : "They're"} picked and packed again in the next batch.
              </s-paragraph>
            )}
            {removed.skipped?.length > 0 && <s-paragraph>Left in the batch: {removed.skipped.join(", ")}.</s-paragraph>}
          </s-banner>
        </div>
      )}
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
  const { tab, filter, overview, list, events, sync, can: allowed, batches, batch, pick, bins, binQuery, show, liveBatchCount, openBatches, flags, flagStatus, flagCount, sandbox, pack, box: packBox, slips, shopAdmin, restricted, mine, hiddenBatch, me, staff, printing, pairs, variants, tiles, batchLockList, lock, merge } =
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
    ...(allowed.merge ? [{ id: "merge", label: "Order Merge" }] : []),
    { id: "stock", label: "Stock vs orders" },
    { id: "settings", label: "Settings and activity" },
  ];
  const shownTab = tab;
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
    <PrintProvider printing={printing}>
    <MethodRulesContext.Provider value={overview?.settings?.methodRules ?? DEFAULT_METHOD_RULES}>
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
            aria-selected={shownTab === t.id}
            style={tabStyle(shownTab === t.id)}
            onClick={() =>
              setParams(
                (p) => {
                  const n = new URLSearchParams(p);
                  n.set("tab", t.id);
                  for (const k of ["batch", "view", "show", "q", "missing", "status", "box", "slips", "mine", "customer"]) if (t.id !== tab) n.delete(k);
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
        <OrderLookupBox
          onGo={(t, name, batchId) =>
            go(
              t === "batches"
                ? { tab: t, batch: batchId ?? null, view: null, q: null, box: null, slips: null }
                : { tab: t, q: name, batch: null, view: null, method: null, country: null, product: null, pname: null, variant: null, with: null, wnames: null, singles: null, doubles: null, pair: null },
              { replace: false },
            )
          }
        />
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
          <Filters filter={filter} overview={overview} state={tab} pairs={pairs} variants={variants} tiles={tiles} />
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
            identical: overview.settings.autoIdentical,
            multiples: overview.settings.autoMultiples,
            release: overview.settings.autoRelease,
            releaseDays: overview.settings.autoReleaseDays,
          }}
          locks={batchLockList}
          canPriority={allowed.priority}
          staff={staff}
          me={me}
        />
      )}
      {tab === "batches" && batch && <BatchDetail batch={batch} list={list} filter={filter} allowed={allowed} staff={staff} me={me} lock={lock} />}
      {tab === "batches" && pick && <PickList key={pick.batch.id} data={pick} canPick={allowed.pick} lock={lock?.pick ?? null} />}
      {tab === "batches" && pack && <PackStation key={pack.batch.id} data={pack} boxData={packBox} can={{ pack: allowed.pack, ship: allowed.ship, override: allowed.override, pick: allowed.pick, bulkLabels: allowed.bulkLabels }} sandbox={Boolean(sandbox)} lock={lock?.pack ?? null} />}
      {tab === "batches" && slips && <Slips data={slips} />}
      {tab === "batches" && !batches && !batch && !pick && !pack && !slips && (
        <s-paragraph>{hiddenBatch ? "That batch isn't assigned to you. Ask a lead to assign it if you should be working on it." : "That batch couldn't be found."}</s-paragraph>
      )}
      {tab === "review" && flags && <ReviewTab flags={flags} status={flagStatus} canReview={allowed.review} />}
      {tab === "merge" && (allowed.merge ? <MergeTab data={merge} /> : <s-paragraph>Order Merge needs the "Merge orders" permission.</s-paragraph>)}
      {tab === "stock" && <StockTab overview={overview} />}
      {tab === "settings" && <SettingsTab overview={overview} events={events} sync={sync} canSettings={allowed.settings} sandboxOn={Boolean(sandbox)} printing={printing} canPrint={allowed.pack || allowed.ship} />}
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
    </MethodRulesContext.Provider>
    </PrintProvider>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
