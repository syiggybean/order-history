import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ProductLink, QuickView } from "../components/QuickView";
import db from "../db.server";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import { daysUntil, errorMessage, todayInStore } from "../preorders.server";
import { approveSuggestions, dismissSuggestions, getBooksJob, startBooksCheck } from "../books.server";

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "releaseReview", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;

  const [pending, history, state] = await Promise.all([
    db.releaseSuggestion.findMany({ where: { shop, status: "pending" }, orderBy: { currentDate: "asc" } }),
    db.releaseSuggestion.findMany({
      where: { shop, status: { in: ["approved", "dismissed"] } },
      orderBy: { resolvedAt: "desc" },
      take: 50,
    }),
    db.preorderState.findUnique({ where: { shop } }),
  ]);

  const today = todayInStore();
  const shape = (s) => ({
    id: s.id,
    productId: s.productId,
    title: s.title,
    isbn: s.isbn,
    currentDate: s.currentDate,
    googleDate: s.googleDate,
    precision: s.precision,
    googleTitle: s.googleTitle,
    googleUrl: s.googleUrl,
    status: s.status,
    foundAt: s.createdAt.toISOString(),
    resolvedAt: s.resolvedAt?.toISOString() ?? null,
    // Positive: Google's date is later than ours
    shift: s.precision === "day" && s.currentDate ? daysUntil(s.currentDate, s.googleDate) : null,
    googleDaysAway: s.precision === "day" ? daysUntil(today, s.googleDate) : null,
  });

  return {
    pending: pending.map(shape),
    history: history.map(shape),
    lastCheck: state?.lastBooksAt
      ? { at: state.lastBooksAt.toISOString(), summary: state.lastBooksSummary ?? "" }
      : null,
    job: getBooksJob(shop),
    canManage: can(user, "releaseReview", "manage"),
    canEditDates: can(user, "releaseReview", "manage") || can(user, "preorders", "manage"),
    hasApiKey: Boolean(process.env.GOOGLE_BOOKS_API_KEY),
  };
};

// View access: see the list and progress. Manage: run checks, approve, dismiss.
const NEEDS = { job: "view", check: "manage", approve: "manage", dismiss: "manage" };

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const need = NEEDS[intent] ?? "manage";
  if (!can(user, "releaseReview", need)) return { intent, ...denied("releaseReview", need) };
  const ids = String(form.get("ids") ?? "")
    .split(",")
    .map(Number)
    .filter(Boolean);

  try {
    if (intent === "check") return { intent, job: startBooksCheck(session.shop) };
    if (intent === "job") return { intent, job: getBooksJob(session.shop) };
    if (intent === "approve") return { intent, ...(await approveSuggestions(admin, session.shop, ids)) };
    if (intent === "dismiss") return { intent, ...(await dismissSuggestions(session.shop, ids)) };
  } catch (e) {
    return { intent, error: errorMessage(e) };
  }
  return { error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1 };
const scroll = { maxHeight: "520px", overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };
const muted = { color: "#616161", fontSize: "12px" };

function fmtDate(s) {
  if (!s) return "—";
  const [y, m, d] = s.split("-").map(Number);
  if (d) return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (m) return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  return String(y);
}

function Shift({ s }) {
  if (s.precision !== "day") {
    return <span style={{ color: "#8a6116" }}>Approximate</span>;
  }
  if (s.shift === null) return "—";
  const later = s.shift > 0;
  return (
    <span style={{ color: later ? "#b42318" : "#1a5e20", fontWeight: 600 }}>
      {later ? "+" : "−"}
      {Math.abs(s.shift)} days {later ? "later" : "earlier"}
    </span>
  );
}

export default function ReleaseReview() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Release date review" /> : <ReleaseReviewPage />;
}

function ReleaseReviewPage() {
  const { pending, history, lastCheck, job: initialJob, hasApiKey, canManage, canEditDates } = useLoaderData();
  const checkFetcher = useFetcher();
  const reviewFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [job, setJob] = useState(initialJob);
  const [selected, setSelected] = useState(new Set());
  const [quickView, setQuickView] = useState(null);
  const [notice, setNotice] = useState(null); // { tone, text }

  // Drop selections that are no longer pending
  useEffect(() => {
    const ids = new Set(pending.map((p) => p.id));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
  }, [pending]);

  // Check job responses
  useEffect(() => {
    const d = checkFetcher.data;
    if (!d) return;
    if (d.error) setNotice({ tone: "critical", text: d.error });
    if (d.job) {
      setJob(d.job);
      if (d.job.state !== "running") revalidator.revalidate();
    }
  }, [checkFetcher.data]);

  // Poll while a check runs
  useEffect(() => {
    if (job?.state !== "running" || checkFetcher.state !== "idle") return;
    const t = setTimeout(() => checkFetcher.submit({ intent: "job" }, { method: "post" }), 2000);
    return () => clearTimeout(t);
  }, [job, checkFetcher.state]);

  // Approve / dismiss responses
  useEffect(() => {
    const d = reviewFetcher.data;
    if (!d) return;
    if (d.error) setNotice({ tone: "critical", text: d.error });
    else if (d.intent === "approve") {
      const text = `${d.approved} release date${d.approved === 1 ? "" : "s"} updated.`;
      setNotice(
        d.errors?.length
          ? { tone: "warning", text: `${text} ${d.errors.join(" ")}` }
          : { tone: "success", text: `${text} Tags and shipping profiles were updated to match.` },
      );
    } else if (d.intent === "dismiss") {
      setNotice({ tone: "info", text: `${d.dismissed} dismissed. They won't come back unless Google's date changes again.` });
    }
    setSelected(new Set());
  }, [reviewFetcher.data]);

  const running = job?.state === "running";
  const busy = reviewFetcher.state !== "idle";
  const busyIds = useMemo(() => {
    const ids = reviewFetcher.formData?.get("ids");
    return new Set(ids ? String(ids).split(",").map(Number) : []);
  }, [reviewFetcher.formData]);

  const submitReview = (intent, ids) => {
    setNotice(null);
    reviewFetcher.submit({ intent, ids: ids.join(",") }, { method: "post" });
  };

  const exactPending = pending.filter((p) => p.precision === "day");
  const allSelected = pending.length > 0 && selected.size === pending.length;
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const selectedExact = [...selected].filter((id) => exactPending.some((p) => p.id === id));

  return (
    <s-page heading="Release date review">
      {!hasApiKey && (
        <s-banner tone="warning" heading="No Google Books API key">
          <s-paragraph>
            Checks work without a key, but Google may cut them off partway. Add GOOGLE_BOOKS_API_KEY in Railway's
            Variables for reliable daily checks.
          </s-paragraph>
        </s-banner>
      )}

      {notice && (
        <s-banner tone={notice.tone}>
          <s-paragraph>{notice.text}</s-paragraph>
        </s-banner>
      )}

      {/* Check status */}
      <s-section heading="Google Books check">
        <s-paragraph>
          Looks up each upcoming pre-order's ISBN (from its barcode) on Google Books and lists any release date that
          doesn't match. Runs every morning after the daily pre-order run. Nothing changes until you approve it.
        </s-paragraph>
        <s-paragraph>
          <strong>Last check:</strong>{" "}
          {lastCheck ? `${new Date(lastCheck.at).toLocaleString()} · ${lastCheck.summary}` : "Not run yet"}
        </s-paragraph>
        {canManage && (
          <div style={{ marginTop: "8px" }}>
            <s-button
              onClick={() => {
                setNotice(null);
                checkFetcher.submit({ intent: "check" }, { method: "post" });
              }}
              {...(running ? { loading: true } : {})}
            >
              Check now
            </s-button>
          </div>
        )}

        {job && (
          <div style={{ marginTop: "12px" }}>
            <s-paragraph>
              <strong>
                {job.source}: {job.step}
              </strong>
              {job.total > 0 && ` · ${job.done.toLocaleString()} of ${job.total.toLocaleString()} checked`}
              {job.state !== "running" && job.total > 0 && ` · ${job.newCount} new to review`}
            </s-paragraph>
            {job.state !== "running" && (
              <s-paragraph>
                <span style={muted}>
                  {job.agrees} match · {job.differences} differ · {job.notFound} not on Google Books · {job.noDate}{" "}
                  with no date on Google · {job.noIsbn.length} without an ISBN
                </span>
              </s-paragraph>
            )}
            {job.stoppedEarly && (
              <div style={{ marginTop: "8px" }}>
                <s-banner tone="warning">
                  <s-paragraph>{job.stoppedEarly}</s-paragraph>
                </s-banner>
              </div>
            )}
            {job.errors.length > 0 && (
              <div style={{ marginTop: "8px" }}>
                <s-banner tone={job.state === "failed" ? "critical" : "warning"}>
                  <ul style={{ margin: 0, paddingLeft: "18px" }}>
                    {job.errors.slice(0, 10).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </s-banner>
              </div>
            )}
            {job.state !== "running" && job.noIsbn.length > 0 && (
              <details style={{ marginTop: "8px" }}>
                <summary style={{ cursor: "pointer" }}>
                  {job.noIsbn.length} upcoming pre-order{job.noIsbn.length === 1 ? " has" : "s have"} no ISBN in the
                  barcode field
                </summary>
                <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                  {job.noIsbn.map((p) => (
                    <li key={p.id}>
                      <ProductLink id={p.id} title={p.title} onOpen={setQuickView} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </s-section>

      {/* Review list */}
      <s-section heading={`To review (${pending.length})`}>
        {pending.length === 0 ? (
          <s-paragraph>Nothing to review. Every checked pre-order matches Google Books.</s-paragraph>
        ) : (
          <>
            {!canManage && (
              <s-paragraph>
                <span style={muted}>You can view these, but approving or dismissing them needs approve access.</span>
              </s-paragraph>
            )}
            {canManage && (
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
              <s-button
                variant="primary"
                onClick={() => submitReview("approve", selectedExact)}
                {...(busy ? { loading: true } : {})}
                {...(!selectedExact.length ? { disabled: true } : {})}
              >
                Approve selected{selectedExact.length ? ` (${selectedExact.length})` : ""}
              </s-button>
              <s-button
                onClick={() => submitReview("dismiss", [...selected])}
                {...(!selected.size || busy ? { disabled: true } : {})}
              >
                Dismiss selected{selected.size ? ` (${selected.size})` : ""}
              </s-button>
              <span style={muted}>Approving sets the product's release date to Google's, then updates its tag and shipping profile.</span>
            </div>
            )}

            <div style={scroll}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr>
                    {canManage && (
                      <th style={{ ...head, width: "28px" }}>
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(pending.map((p) => p.id)))}
                        />
                      </th>
                    )}
                    <th style={head}>Product</th>
                    <th style={head}>Current date</th>
                    <th style={head}>Google Books</th>
                    <th style={head}>Change</th>
                    {canManage && <th style={head}></th>}
                  </tr>
                </thead>
                <tbody>
                  {pending.map((s) => {
                    const rowBusy = busy && busyIds.has(s.id);
                    return (
                      <tr key={s.id} style={{ opacity: rowBusy ? 0.5 : 1 }}>
                        {canManage && (
                          <td style={cell}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${s.title}`}
                              checked={selected.has(s.id)}
                              onChange={() => toggle(s.id)}
                            />
                          </td>
                        )}
                        <td style={cell}>
                          <ProductLink id={s.productId} title={s.title} onOpen={setQuickView} />
                          <div style={muted}>ISBN {s.isbn}</div>
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDate(s.currentDate)}</td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          {s.googleUrl ? (
                            <a href={s.googleUrl} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                              {fmtDate(s.googleDate)}
                            </a>
                          ) : (
                            fmtDate(s.googleDate)
                          )}
                          {s.precision !== "day" && <div style={muted}>Google gives {s.precision} only</div>}
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap" }}>
                          <Shift s={s} />
                          {s.googleDaysAway !== null && s.googleDaysAway <= 0 && (
                            <div style={{ ...muted, color: "#b42318" }}>Already released per Google</div>
                          )}
                        </td>
                        {canManage && (
                        <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                          {s.precision === "day" ? (
                            <s-button
                              variant="primary"
                              onClick={() => submitReview("approve", [s.id])}
                              {...(busy ? { disabled: true } : {})}
                            >
                              Approve
                            </s-button>
                          ) : (
                            <s-button onClick={() => setQuickView(s.productId)} {...(busy ? { disabled: true } : {})}>
                              Set date
                            </s-button>
                          )}{" "}
                          <s-button
                            variant="tertiary"
                            onClick={() => submitReview("dismiss", [s.id])}
                            {...(busy ? { disabled: true } : {})}
                          >
                            Dismiss
                          </s-button>
                        </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </s-section>

      {/* History */}
      <s-section heading="Recently reviewed">
        {history.length === 0 ? (
          <s-paragraph>No reviews yet.</s-paragraph>
        ) : (
          <div style={{ ...scroll, maxHeight: "320px" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={head}>When</th>
                  <th style={head}>Result</th>
                  <th style={head}>Product</th>
                  <th style={head}>Date change</th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => (
                  <tr key={s.id}>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{new Date(s.resolvedAt).toLocaleString()}</td>
                    <td style={cell}>{s.status === "approved" ? "Approved" : "Dismissed"}</td>
                    <td style={cell}>
                      <ProductLink id={s.productId} title={s.title} onOpen={setQuickView} />
                    </td>
                    <td style={cell}>
                      {fmtDate(s.currentDate)} → {fmtDate(s.googleDate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {quickView && (
        <QuickView productId={quickView} canEdit={canEditDates} onClose={() => setQuickView(null)} onSaved={() => revalidator.revalidate()} />
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
