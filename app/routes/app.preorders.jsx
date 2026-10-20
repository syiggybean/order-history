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
//   product quick view:           view access to pre-orders, release review, shipping or wishlists
//   saving a release date:        manage access to pre-orders or release review
const NEEDS = { scan: "view", poll: "view", job: "view", apply: "manage" };

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const bulkId = form.get("bulkId");

  if (intent === "product" && !can(user, "preorders", "view") && !can(user, "releaseReview", "view") && !can(user, "shipping", "view") && !can(user, "wishlist", "view")) {
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
      const plan = await buildPlan(admin, bulkId, profiles);
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
          noRelease: plan.noRelease,
        },
      };
    }

    if (intent === "apply") {
      return { intent, job: startApply(session.shop, bulkId) };
    }

    if (intent === "job") {
      return { intent, job: getJob(session.shop) };
    }

    if (intent === "product") {
      const details = await getProductDetails(admin, form.get("productId"));
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
    if (d.job) {
      setJob(d.job);
      if (d.job.state !== "running") revalidator.revalidate(); // refresh the activity log
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

  const applyClick = () => {
    setError(null);
    applyFetcher.submit({ intent: "apply", bulkId }, { method: "post" });
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
          Scans every product with a release date and lists the tag and shipping profile changes needed. Nothing changes
          until you click Apply.
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
                <strong>All tags and shipping profiles are already correct.</strong>
              </s-paragraph>
            ) : (
              <>
                <s-paragraph>
                  <strong>
                    {plan.changes.length.toLocaleString()} product{plan.changes.length === 1 ? "" : "s"} need changes:
                  </strong>{" "}
                  {plan.tagCount.toLocaleString()} tag change{plan.tagCount === 1 ? "" : "s"},{" "}
                  {plan.moveCount.toLocaleString()} shipping profile move{plan.moveCount === 1 ? "" : "s"}.
                </s-paragraph>
                <div style={{ ...scroll, marginTop: "8px" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%" }}>
                    <thead>
                      <tr>
                        <th style={head}>Product</th>
                        <th style={head}>Release date</th>
                        <th style={head}>Days</th>
                        <th style={head}>Tag</th>
                        <th style={head}>Shipping profile</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.changes.map((c) => (
                        <tr key={c.id}>
                          <td style={cell}>
                            <ProductLink id={c.id} title={c.title} onOpen={openQuickView} />
                          </td>
                          <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(c.release)}</td>
                          <td style={cell}>{c.days}</td>
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
                              <span style={{ color: "#6d7175" }}>{c.fromProfile} (no change)</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
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

            {pendingWork > 0 && !canManage && (
              <div style={{ marginTop: "16px" }}>
                <s-paragraph>
                  <span style={{ color: "#616161" }}>You can view these changes, but applying them needs manage access.</span>
                </s-paragraph>
              </div>
            )}

            {pendingWork > 0 && canManage && (
              <div style={{ marginTop: "16px" }}>
                <s-button
                  variant="primary"
                  onClick={applyClick}
                  {...(applying ? { loading: true } : {})}
                  {...(!profilesReady ? { disabled: true } : {})}
                >
                  Apply changes
                </s-button>
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
