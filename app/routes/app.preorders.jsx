import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ProductLink, QuickView } from "../components/QuickView";
import db from "../db.server";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import {
  DAILY_HOUR,
  buildPlan,
  dayInStore,
  daysUntil,
  errorMessage,
  getDailyState,
  getJob,
  getProductDetails,
  loadProfiles,
  scanStatus,
  setReleaseDate,
  startApply,
  startScan,
  switchToPreorderTemplate,
  todayInStore,
} from "../preorders.server";

export const loader = async ({ request }) => {
  const { admin, session, user, noAccess } = await loadWithAccess(request, "preorders", "view");
  if (noAccess) return { noAccess: true };
  const canManage = can(user, "preorders", "manage");

  let profiles = null;
  let profileError = null;
  try {
    profiles = await loadProfiles(admin);
  } catch (e) {
    profileError = errorMessage(e);
  }

  const log = await db.preorderLog.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const daily = await getDailyState(session.shop);

  return {
    canManage,
    today: todayInStore(),
    dailyHour: DAILY_HOUR,
    profiles,
    profileError,
    daily: daily
      ? { at: daily.lastDailyAt?.toISOString() ?? null, summary: daily.lastDailySummary ?? null }
      : null,
    job: getJob(session.shop),
    log: log.map((l) => {
      // Older entries kept the release date inside the text, e.g.
      // "(release 2027-01-12)" or "· Release 2027-01-12". Read it from
      // there when the release column is empty, then strip it for display.
      const release = l.release ?? l.detail.match(/release (\d{4}-\d{2}-\d{2})/i)?.[1] ?? null;
      const detail = l.detail
        .replace(/\s*\(release \d{4}-\d{2}-\d{2}\)/i, "")
        .replace(/\s*·\s*Release \d{4}-\d{2}-\d{2}$/, "");

      return {
        ...l,
        detail,
        createdAt: l.createdAt.toISOString(),
        // Days until release on the day the change was made (for auditing)
        days: release ? daysUntil(dayInStore(l.createdAt), release) : null,
      };
    }),
  };
};

// Who can do what here:
//   view (pre-orders):            see the page, scan and preview
//   manage (pre-orders):          apply changes
//   product quick view:           view access to pre-orders, release review, shipping, wishlists or reporting
//   saving a release date:        manage access to pre-orders or release review
const NEEDS = { scan: "view", poll: "view", job: "view", apply: "manage", switchTemplate: "manage" };
const idsFrom = (form) => {
  try {
    const ids = JSON.parse(String(form.get("ids") ?? "null"));
    return Array.isArray(ids) ? ids.map(String) : null;
  } catch {
    return null;
  }
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const bulkId = form.get("bulkId");

  if (intent === "product" && !["preorders", "releaseReview", "shipping", "wishlist", "analytics"].some((f) => can(user, f, "view"))) {
    return { intent, ...denied("preorders", "view") };
  }
  if (intent === "saveRelease" && !can(user, "preorders", "manage") && !can(user, "releaseReview", "manage")) {
    return { intent, ...denied("preorders", "manage") };
  }
  if (NEEDS[intent] && !can(user, "preorders", NEEDS[intent])) {
    return { intent, ...denied("preorders", NEEDS[intent]) };
  }

  try {
    if (intent === "scan") {
      return { intent, bulkId: await startScan(admin) };
    }

    if (intent === "poll") {
      const op = await scanStatus(admin, bulkId);
      if (op?.status !== "COMPLETED") {
        return { intent, status: op?.status ?? "UNKNOWN", objectCount: op?.objectCount ?? "0", errorCode: op?.errorCode };
      }
      const profiles = await loadProfiles(admin);
      const plan = await buildPlan(admin, bulkId, profiles, session.shop);
      return {
        intent,
        status: "COMPLETED",
        plan: {
          today: plan.today,
          scanned: plan.scanned,
          archived: plan.archived,
          withRelease: plan.withRelease,
          changes: plan.changes.map(({ moveVariantIds, add, remove, toProfileId, ...rest }) => rest),
          tagCount: plan.changes.filter((c) => c.tagChange).length,
          moveCount: plan.changes.filter((c) => c.toProfile).length,
          templateCount: plan.changes.filter((c) => c.templateChange).length,
          noRelease: plan.noRelease,
          otherTemplate: plan.otherTemplate,
        },
      };
    }

    if (intent === "apply") {
      // ids: one product or a selection (none = everything); templatesOnly: just the template part
      return { intent, job: startApply(session.shop, bulkId, { onlyIds: idsFrom(form), templatesOnly: form.get("templatesOnly") === "1" }) };
    }

    if (intent === "switchTemplate") {
      return { intent, ...(await switchToPreorderTemplate(session.shop, admin, idsFrom(form), user)) };
    }

    if (intent === "job") {
      return { intent, job: getJob(session.shop) };
    }

    if (intent === "product") {
      const details = await getProductDetails(admin, form.get("productId"), session.shop);
      if (!details) return { intent, error: "This product no longer exists." };
      return { intent, details };
    }

    if (intent === "saveRelease") {
      const result = await setReleaseDate(admin, session.shop, form.get("productId"), form.get("release"));
      return { intent, ...result };
    }
  } catch (e) {
    return { intent, error: errorMessage(e) };
  }

  return { error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "6px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0 };
const scroll = { maxHeight: "420px", overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };

function fmtDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function Preorders() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Pre-orders" /> : <PreordersPage />;
}

function PreordersPage() {
  const { canManage, today, dailyHour, profiles, profileError, daily, job: initialJob, log } = useLoaderData();
  const scanFetcher = useFetcher();
  const applyFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [bulkId, setBulkId] = useState(null);
  const [scan, setScan] = useState(null); // { status, objectCount }
  const [plan, setPlan] = useState(null);
  const [job, setJob] = useState(initialJob);
  const [error, setError] = useState(null);
  const [quickView, setQuickView] = useState(null); // product ID
  const [planStale, setPlanStale] = useState(false);

  const openQuickView = (id) => setQuickView(id);
  const onQuickViewSaved = () => {
    if (plan) setPlanStale(true);
    revalidator.revalidate(); // refresh the activity log
  };

  // Scan responses
  useEffect(() => {
    const d = scanFetcher.data;
    if (!d) return;
    if (d.error) {
      setError(d.error);
      setScan(null);
      return;
    }
    if (d.intent === "scan") {
      setBulkId(d.bulkId);
      setScan({ status: "RUNNING", objectCount: "0" });
    }
    if (d.intent === "poll") {
      if (d.status === "COMPLETED") {
        setScan(null);
        setPlan(d.plan);
        setPlanStale(false);
      } else if (["FAILED", "CANCELED", "EXPIRED"].includes(d.status)) {
        setScan(null);
        setError(`The catalog scan ${d.status.toLowerCase()}${d.errorCode ? ` (${d.errorCode})` : ""}.`);
      } else {
        setScan({ status: d.status, objectCount: d.objectCount });
      }
    }
  }, [scanFetcher.data]);

  // Keep polling the scan while it runs
  useEffect(() => {
    if (!scan || !bulkId || scanFetcher.state !== "idle") return;
    const t = setTimeout(() => scanFetcher.submit({ intent: "poll", bulkId }, { method: "post" }), 2000);
    return () => clearTimeout(t);
  }, [scan, bulkId, scanFetcher.state]);

  // Apply responses
  useEffect(() => {
    const d = applyFetcher.data;
    if (!d) return;
    if (d.error) setError(d.error);
    if (d.error) setPendingApply(null);
    if (d.job) {
      setJob(d.job);
      if (d.job.state !== "running") {
        revalidator.revalidate(); // refresh the activity log
        // Take what went through off the list
        if (pendingApply) {
          setPlan((p) => (p ? withoutApplied(p, pendingApply, d.job) : p));
          setPendingApply(null);
        }
      }
    }
  }, [applyFetcher.data]);

  // Keep polling the job while it runs
  useEffect(() => {
    if (job?.state !== "running" || applyFetcher.state !== "idle") return;
    const t = setTimeout(() => applyFetcher.submit({ intent: "job" }, { method: "post" }), 2000);
    return () => clearTimeout(t);
  }, [job, applyFetcher.state]);

  const startScanClick = () => {
    setError(null);
    setPlan(null);
    scanFetcher.submit({ intent: "scan" }, { method: "post" });
  };

  // ids: one product or a selection (null = every listed change); templatesOnly: just the template part
  const [pendingApply, setPendingApply] = useState(null);
  const applyClick = ({ ids = null, templatesOnly = false } = {}) => {
    setError(null);
    setPendingApply({ ids, templatesOnly });
    applyFetcher.submit(
      { intent: "apply", bulkId, ...(ids ? { ids: JSON.stringify(ids) } : {}), ...(templatesOnly ? { templatesOnly: "1" } : {}) },
      { method: "post" },
    );
  };

  const scanning = Boolean(scan) || (scanFetcher.state !== "idle" && !plan);
  const applying = job?.state === "running";
  const profilesReady = profiles && profiles.missing.length === 0;
  const pendingWork = plan ? plan.changes.length : 0;

  return (
    <s-page heading="Pre-orders">
      {error && (
        <s-banner tone="critical" heading="Something went wrong">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      {/* 1. Shipping profiles */}
      <s-section heading="Shipping profiles">
        {profileError ? (
          <s-banner tone="critical" heading="Couldn't read shipping profiles">
            <s-paragraph>{profileError}</s-paragraph>
            <s-paragraph>The app may still need the shipping permissions approved. Reopen it from Apps in Shopify admin.</s-paragraph>
          </s-banner>
        ) : (
          <>
            <s-paragraph>
              Products move to the profile matching their tag. Under 30 days from release, or already released, they go
              back to General. Release dates are counted from today ({fmtDay(today)}, Pacific time).
            </s-paragraph>
            <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "8px" }}>
              <thead>
                <tr>
                  <th style={head}>Days until release</th>
                  <th style={head}>Tag</th>
                  <th style={head}>Shipping profile</th>
                </tr>
              </thead>
              <tbody>
                {[...profiles.tiers].reverse().map((t, i, arr) => {
                  const next = arr[i + 1];
                  const range = next ? `${t.minDays}–${next.minDays - 1}` : `${t.minDays}+`;
                  return (
                    <tr key={t.tag}>
                      <td style={cell}>{range}</td>
                      <td style={cell}>{t.tag}</td>
                      <td style={cell}>{t.profile ? t.profile.name : <strong style={{ color: "#b42318" }}>Not found</strong>}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td style={cell}>Under 30, or released</td>
                  <td style={cell}>(none)</td>
                  <td style={cell}>{profiles.general ? profiles.general.name : <strong style={{ color: "#b42318" }}>Not found</strong>}</td>
                </tr>
              </tbody>
            </table>
            {!profilesReady && (
              <div style={{ marginTop: "12px" }}>
                <s-banner tone="warning" heading="Some profiles are missing">
                  <s-paragraph>
                    Couldn't find a shipping profile for: {profiles.missing.join(", ")}. Profile names need to contain
                    the tag's number, like "GT30Days" or "GT 30 Days". Changes can't be applied until every profile is
                    found.
                  </s-paragraph>
                </s-banner>
              </div>
            )}
          </>
        )}
      </s-section>

      {/* Automatic updates */}
      <s-section heading="Automatic updates">
        <s-paragraph>
          Tags and shipping profiles update automatically in two ways: every morning at {dailyHour} AM Pacific for the
          whole catalog, and within a few seconds whenever a product is created or edited.
        </s-paragraph>
        <s-paragraph>
          <strong>Last daily run:</strong>{" "}
          {daily?.at ? `${new Date(daily.at).toLocaleString()} · ${daily.summary ?? ""}` : "Not run yet"}
        </s-paragraph>
      </s-section>

      {/* 2. Scan and preview */}
      <s-section heading="Check the catalog">
        <s-paragraph>
          Scans every product with a release date and lists the tag, shipping profile and product template changes
          needed. Products releasing in the future (or with a pre-order countdown) use the theme's "preorder"
          template; released ones go back to the default. Nothing changes until you click Apply.
        </s-paragraph>
        <div style={{ marginTop: "8px" }}>
          <s-button
            onClick={startScanClick}
            {...(scanning ? { loading: true } : {})}
            {...(applying ? { disabled: true } : {})}
          >
            {plan ? "Scan again" : "Scan catalog"}
          </s-button>
        </div>
        {scan && (
          <div style={{ marginTop: "8px" }}>
            <s-paragraph>Scanning… {Number(scan.objectCount).toLocaleString()} items read so far.</s-paragraph>
          </div>
        )}

        {plan && (
          <div style={{ marginTop: "16px" }}>
            <s-paragraph>
              {planStale && (
                <span style={{ display: "block", marginBottom: "6px", color: "#8a6116" }}>
                  A release date was edited since this scan. Scan again to refresh the list.
                </span>
              )}
              Scanned {plan.scanned.toLocaleString()} products
              {plan.archived > 0 && ` (${plan.archived.toLocaleString()} archived, skipped)`}.{" "}
              {plan.withRelease.toLocaleString()} active or draft products have a release date.
            </s-paragraph>

            {plan.changes.length === 0 ? (
              <s-paragraph>
                <strong>All tags, shipping profiles and templates are already correct.</strong>
              </s-paragraph>
            ) : (
              <ChangesTable
                plan={plan}
                canManage={canManage}
                busy={applying || applyFetcher.state !== "idle"}
                ready={profilesReady}
                onOpen={openQuickView}
                onApply={applyClick}
              />
            )}

            {plan.noRelease.length > 0 && (
              <div style={{ marginTop: "12px" }}>
                <s-banner tone="warning" heading={`${plan.noRelease.length} product${plan.noRelease.length === 1 ? " has" : "s have"} a GT tag but no release date`}>
                  <s-paragraph>These are left alone. Add a release date, or remove the tag by hand.</s-paragraph>
                </s-banner>
                <div style={{ ...scroll, maxHeight: "220px", marginTop: "8px" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <tbody>
                      {plan.noRelease.map((p) => (
                        <tr key={p.id}>
                          <td style={cell}>
                            <ProductLink id={p.id} title={p.title} onOpen={openQuickView} />
                          </td>
                          <td style={cell}>{p.tags.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {plan.otherTemplate?.length > 0 && (
              <OtherTemplates
                rows={plan.otherTemplate}
                canManage={canManage}
                onOpen={openQuickView}
                onSwitched={(ids) => {
                  const done = new Set(ids);
                  setPlan((p) => (p ? { ...p, otherTemplate: p.otherTemplate.filter((x) => !done.has(x.id)) } : p));
                  revalidator.revalidate(); // activity log
                }}
              />
            )}

            {pendingWork > 0 && !canManage && (
              <div style={{ marginTop: "16px" }}>
                <s-paragraph>
                  <span style={{ color: "#616161" }}>You can view these changes, but applying them needs manage access.</span>
                </s-paragraph>
              </div>
            )}
          </div>
        )}
      </s-section>

      {/* 3. Progress */}
      {job && (
        <s-section heading="Last run">
          <s-paragraph>
            <strong>
              {job.source ?? "Manual"}: {job.step}
            </strong>
            {job.total > 0 && ` · ${job.retagged.toLocaleString()} of ${job.total.toLocaleString()} products retagged`}
            {` · ${job.moved.toLocaleString()} product${job.moved === 1 ? "" : "s"} moved to a new shipping profile`}
            {job.templated > 0 && ` · ${job.templated.toLocaleString()} template${job.templated === 1 ? "" : "s"} changed`}
          </s-paragraph>
          {Object.keys(job.byProfile ?? {}).length > 0 && (
            <ul style={{ margin: "4px 0 8px", paddingLeft: "18px" }}>
              {Object.entries(job.byProfile).map(([name, n]) => (
                <li key={name}>
                  {name}: {n.toLocaleString()} product{n === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          )}
          {job.state === "done" && job.errors.length === 0 && (
            <s-banner tone="success" heading="All changes applied" />
          )}
          {job.errors.length > 0 && (
            <s-banner tone={job.state === "failed" ? "critical" : "warning"} heading={`${job.errors.length} problem${job.errors.length === 1 ? "" : "s"}`}>
              <ul style={{ margin: 0, paddingLeft: "18px" }}>
                {job.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </s-banner>
          )}
        </s-section>
      )}

      {/* 4. Activity log */}
      <s-section heading="Activity">
        {log.length === 0 ? (
          <s-paragraph>No changes yet.</s-paragraph>
        ) : (
          <div style={scroll}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={head}>When</th>
                  <th style={head}>Source</th>
                  <th style={head} title="Days until release on the day of the change">
                    Days
                  </th>
                  <th style={head}>Product</th>
                  <th style={head}>Change</th>
                </tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id}>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString()}</td>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{l.action}</td>
                    <td style={cell}>{l.days ?? "—"}</td>
                    <td style={cell}>
                      <ProductLink id={l.productId} title={l.title} onOpen={openQuickView} />
                    </td>
                    <td style={cell}>{l.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {quickView && (
        <QuickView productId={quickView} canEdit={canManage} onClose={() => setQuickView(null)} onSaved={onQuickViewSaved} />
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);

// The plan after an apply: rows that went through are removed (or, for
// "templates only", lose their template part)
export function withoutApplied(plan, { ids, templatesOnly }, job) {
  if (job?.state === "failed") return plan;
  const failed = new Set(job?.failedIds ?? []);
  const picked = ids ? new Set(ids) : null;
  const changes = plan.changes.flatMap((c) => {
    if ((picked && !picked.has(c.id)) || failed.has(c.id)) return [c];
    if (!templatesOnly) return [];
    if (!c.templateChange) return [c];
    const rest = { ...c, templateChange: false };
    return rest.tagChange || rest.toProfile ? [rest] : [];
  });
  return {
    ...plan,
    changes,
    tagCount: changes.filter((c) => c.tagChange).length,
    moveCount: changes.filter((c) => c.toProfile).length,
    templateCount: changes.filter((c) => c.templateChange).length,
  };
}

const check = { width: "16px", height: "16px", margin: 0, cursor: "pointer" };
const bar = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "8px 10px", background: "#f1f8ff", border: "1px solid #b5d4f4", borderRadius: "8px", marginTop: "8px" };
const srOnly = { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

// Selected product IDs (only ones still listed count)
function useSelection(rows) {
  const [picked, setPicked] = useState(() => new Set());
  const listed = new Set(rows.map((r) => r.id));
  const selected = [...picked].filter((id) => listed.has(id));
  const toggle = (id) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const all = selected.length > 0 && selected.length === rows.length;
  const toggleAll = () => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)));
  const clear = () => setPicked(new Set());
  return { selected, has: (id) => picked.has(id) && listed.has(id), toggle, all, toggleAll, clear };
}

function ChangesTable({ plan, canManage, busy, ready, onOpen, onApply }) {
  const sel = useSelection(plan.changes);
  // Start fresh after each apply (the list changes) or new scan
  useEffect(() => sel.clear(), [plan]);
  const n = sel.selected.length;
  const selectedTemplates = plan.changes.filter((c) => sel.has(c.id) && c.templateChange).length;
  const off = busy || !ready;
  return (
    <>
      <s-paragraph>
        <strong>
          {plan.changes.length.toLocaleString()} product{plan.changes.length === 1 ? "" : "s"} need changes:
        </strong>{" "}
        {plan.tagCount.toLocaleString()} tag change{plan.tagCount === 1 ? "" : "s"},{" "}
        {plan.moveCount.toLocaleString()} shipping profile move{plan.moveCount === 1 ? "" : "s"},{" "}
        {(plan.templateCount ?? 0).toLocaleString()} template change{plan.templateCount === 1 ? "" : "s"}.
      </s-paragraph>

      {canManage && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "8px" }}>
          <s-button variant="primary" onClick={() => onApply()} {...(busy ? { loading: true } : {})} {...(!ready ? { disabled: true } : {})}>
            Apply all changes
          </s-button>
          {plan.templateCount > 0 && (
            <s-button onClick={() => onApply({ templatesOnly: true })} {...(off ? { disabled: true } : {})}>
              Change all {plan.templateCount.toLocaleString()} template{plan.templateCount === 1 ? "" : "s"} only
            </s-button>
          )}
        </div>
      )}

      {canManage && n > 0 && (
        <div style={bar} role="region" aria-label="Selected products">
          <strong>{n.toLocaleString()} selected</strong>
          <s-button variant="primary" onClick={() => onApply({ ids: sel.selected })} {...(off ? { disabled: true } : {})}>
            Apply changes to selected
          </s-button>
          {selectedTemplates > 0 && (
            <s-button onClick={() => onApply({ ids: sel.selected, templatesOnly: true })} {...(off ? { disabled: true } : {})}>
              Templates only ({selectedTemplates.toLocaleString()})
            </s-button>
          )}
          <s-button variant="tertiary" onClick={sel.clear}>
            Clear
          </s-button>
        </div>
      )}

      <div style={{ ...scroll, marginTop: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {canManage && (
                <th style={{ ...head, width: "28px" }}>
                  <input type="checkbox" style={check} checked={sel.all} onChange={sel.toggleAll} aria-label="Select all products" />
                </th>
              )}
              <th style={head}>Product</th>
              <th style={head}>Release date</th>
              <th style={head}>Days</th>
              <th style={head}>Tag</th>
              <th style={head}>Shipping profile</th>
              <th style={head}>Template</th>
              {canManage && (
                <th style={head}>
                  <span style={srOnly}>Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {plan.changes.map((c) => (
              <tr key={c.id} style={sel.has(c.id) ? { background: "#f1f8ff" } : undefined}>
                {canManage && (
                  <td style={cell}>
                    <input type="checkbox" style={check} checked={sel.has(c.id)} onChange={() => sel.toggle(c.id)} aria-label={`Select ${c.title}`} />
                  </td>
                )}
                <td style={cell}>
                  <ProductLink id={c.id} title={c.title} onOpen={onOpen} />
                </td>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>{c.release ? fmtDay(c.release) : "—"}</td>
                <td style={cell}>{c.days ?? "—"}</td>
                <td style={cell}>
                  {c.tagChange ? (
                    <>
                      {c.fromTag ?? "none"} → <strong>{c.toTag ?? "none"}</strong>
                    </>
                  ) : (
                    <span style={{ color: "#6d7175" }}>{c.toTag ?? "none"} (no change)</span>
                  )}
                </td>
                <td style={cell}>
                  {c.toProfile ? (
                    <>
                      {c.fromProfile} → <strong>{c.toProfile}</strong>
                    </>
                  ) : (
                    <span style={{ color: "#6d7175" }}>{c.fromProfile ?? "—"} (no change)</span>
                  )}
                </td>
                <td style={cell}>
                  {c.templateChange ? (
                    <>
                      {c.fromTemplate} → <strong>{c.toTemplate}</strong>
                    </>
                  ) : (
                    <span style={{ color: "#6d7175" }}>No change</span>
                  )}
                </td>
                {canManage && (
                  <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                    <s-button
                      variant="tertiary"
                      onClick={() => onApply({ ids: [c.id] })}
                      {...(off ? { disabled: true } : {})}
                      accessibilityLabel={`Apply changes to ${c.title}`}
                    >
                      Apply
                    </s-button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OtherTemplates({ rows, canManage, onOpen, onSwitched }) {
  const fetcher = useFetcher();
  const sel = useSelection(rows);
  const [failed, setFailed] = useState([]);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    const d = fetcher.data;
    if (d?.intent !== "switchTemplate") return;
    setFailed(d.failed ?? (d.error ? [{ id: null, error: d.error }] : []));
    if (d.switched?.length) {
      onSwitched(d.switched);
      sel.clear();
    }
  }, [fetcher.data]);
  const doSwitch = (ids) => fetcher.submit({ intent: "switchTemplate", ids: JSON.stringify(ids) }, { method: "post" });
  const titleOf = (id) => rows.find((r) => r.id === id)?.title ?? "A product";
  const n = sel.selected.length;
  return (
    <div style={{ marginTop: "12px" }}>
      <s-banner
        tone="warning"
        heading={`${rows.length} pre-order product${rows.length === 1 ? " uses" : "s use"} a different custom template`}
      >
        <s-paragraph>
          These are left on their own template, so they won't show the countdown unless that template has the blocks too.
          {canManage ? " Switch them to the preorder template here: one at a time, a selection, or all at once." : ""} Once
          released, a switched product goes to the default product template, not back to its old one.
        </s-paragraph>
      </s-banner>

      {canManage && (
        <div style={{ ...bar, ...(n ? {} : { background: "transparent", border: 0, padding: "8px 0 0" }) }}>
          {n > 0 ? (
            <>
              <strong>{n.toLocaleString()} selected</strong>
              <s-button variant="primary" onClick={() => doSwitch(sel.selected)} {...(busy ? { loading: true } : {})}>
                Switch selected to preorder
              </s-button>
              <s-button variant="tertiary" onClick={sel.clear}>
                Clear
              </s-button>
            </>
          ) : (
            <s-button onClick={() => doSwitch(rows.map((r) => r.id))} {...(busy ? { loading: true } : {})}>
              Switch all {rows.length.toLocaleString()} to preorder
            </s-button>
          )}
        </div>
      )}

      {failed.length > 0 && (
        <div style={{ marginTop: "8px" }}>
          <s-banner tone="critical" heading={`${failed.length} couldn't be switched`}>
            <ul style={{ margin: 0, paddingLeft: "18px" }}>
              {failed.slice(0, 10).map((f, i) => (
                <li key={i}>
                  {f.id ? `${titleOf(f.id)}: ` : ""}
                  {f.error}
                </li>
              ))}
            </ul>
          </s-banner>
        </div>
      )}

      <div style={{ ...scroll, maxHeight: "260px", marginTop: "8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {canManage && (
                <th style={{ ...head, width: "28px" }}>
                  <input type="checkbox" style={check} checked={sel.all} onChange={sel.toggleAll} aria-label="Select all products on other templates" />
                </th>
              )}
              <th style={head}>Product</th>
              <th style={head}>Current template</th>
              {canManage && (
                <th style={head}>
                  <span style={srOnly}>Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} style={sel.has(p.id) ? { background: "#f1f8ff" } : undefined}>
                {canManage && (
                  <td style={cell}>
                    <input type="checkbox" style={check} checked={sel.has(p.id)} onChange={() => sel.toggle(p.id)} aria-label={`Select ${p.title}`} />
                  </td>
                )}
                <td style={cell}>
                  <ProductLink id={p.id} title={p.title} onOpen={onOpen} />
                </td>
                <td style={cell}>{p.template}</td>
                {canManage && (
                  <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                    <s-button
                      variant="tertiary"
                      onClick={() => doSwitch([p.id])}
                      {...(busy ? { disabled: true } : {})}
                      accessibilityLabel={`Switch ${p.title} to preorder`}
                    >
                      Switch to preorder
                    </s-button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
