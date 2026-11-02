import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { QuickView } from "../components/QuickView";
import { BinCell, ExportBins, ImportBins, ShopifySync } from "../components/shipping/Bins";
import { ProductName, ProductThumb, QuickViewContext, box, cell, head, input, muted, small, useParamSetter } from "../components/shipping/ui";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { StockError, applyCounts, defaultLocation, listStock, recentCounts, stockLocations } from "../stock.server";
import { exportBins, importBins, setBin } from "../batches.server";
import { binSyncStatus, syncAllBins } from "../bins-sync.server";

// Stock: where things live (bins) and how many there are, for stock counts.
// Permission "Stock": View · Edit bin locations · Submit counts (overwrites On hand in Shopify).

export const loader = async ({ request }) => {
  const { session, admin, user, noAccess } = await loadWithAccess(request, "stock", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const params = new URL(request.url).searchParams;
  const locations = await stockLocations(admin);
  const locationId = locations.some((l) => l.id === params.get("location")) ? params.get("location") : defaultLocation(locations);
  const query = { q: params.get("q") || "", bin: params.get("bin") || "", missing: params.get("missing") === "1" };
  let list = { rows: [], total: 0, capped: false };
  let error = null;
  try {
    if (locationId) list = await listStock(shop, admin, { ...query, locationId });
  } catch (e) {
    error = errorMessage(e);
  }
  return {
    shop,
    locations,
    locationId,
    query,
    ...list,
    error,
    sync: await binSyncStatus(shop),
    counts: await recentCounts(shop),
    canBins: can(user, "stock", "bins"),
    canCount: can(user, "stock", "count"),
    canEditDates: can(user, "preorders", "manage") || can(user, "releaseReview", "manage"),
  };
};

const NEEDS = { setBin: "bins", importBins: "bins", syncBins: "bins", exportBins: "view", applyCounts: "count" };

export const action = async ({ request }) => {
  const { session, admin, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!NEEDS[intent]) return { intent, error: "Unknown action" };
  if (!can(user, "stock", NEEDS[intent])) return { intent, ...denied("stock", NEEDS[intent]) };
  const shop = session.shop;
  try {
    if (intent === "setBin") return { intent, ok: true, ...(await setBin(shop, JSON.parse(String(form.get("item"))), form.get("bin"), user)) };
    if (intent === "importBins") return { intent, ok: true, ...(await importBins(shop, admin, String(form.get("text") ?? ""), user)) };
    if (intent === "exportBins") return { intent, ok: true, csv: await exportBins(shop) };
    if (intent === "syncBins") return { intent, ok: true, result: await syncAllBins(shop, { admin, force: true }) };
    if (intent === "applyCounts") {
      const locationId = String(form.get("locationId") ?? "");
      const locations = await stockLocations(admin);
      const loc = locations.find((l) => l.id === locationId);
      if (!loc) return { intent, error: "That location isn't available any more. Reload the page." };
      const result = await applyCounts(shop, admin, { locationId, locationName: loc.name, counts: JSON.parse(String(form.get("counts") ?? "[]")) }, user);
      return { intent, ok: true, ...result };
    }
  } catch (e) {
    if (!(e instanceof StockError)) console.error(`[stock] ${intent}:`, e);
    return { intent, error: e?.message ?? String(e) };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const num = { ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const numHead = { ...head, textAlign: "right" };
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Counts in progress are kept in this browser (per location) so a reload or a
// new search doesn't lose them. Not shared, and nothing changes until submitted.
const draftKey = (shop, loc) => `stock-counts:${shop}:${loc}`;
const readDraft = (key) => {
  try {
    return JSON.parse(window.localStorage.getItem(key) || "{}") ?? {};
  } catch {
    return {};
  }
};
const writeDraft = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private window or storage blocked: counts still work, just not kept
  }
};

export default function Stock() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Stock" />;
  return <Page />;
}

function Page() {
  const { shop, locations, locationId, query, rows, total, capped, error, sync, counts: recent, canBins, canCount, canEditDates } = useLoaderData();
  const go = useParamSetter();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [quickView, setQuickView] = useState(null);
  const [q, setQ] = useState(query.q);
  const [bin, setBinFilter] = useState(query.bin);
  const timer = useRef(null);
  const location = locations.find((l) => l.id === locationId);

  // Counts entered: { variantId: { count, seen, title, sku, bin } }
  const key = draftKey(shop, locationId);
  const [draft, setDraft] = useState({});
  useEffect(() => setDraft(readDraft(key)), [key]);
  const update = (next) => {
    setDraft(next);
    writeDraft(key, next);
  };
  const setCount = (row, value) => {
    const next = { ...draft };
    if (value === "" || value === null) delete next[row.variantId];
    else next[row.variantId] = { count: Number(value), seen: row.stocked ? row.onHand : null, title: row.variantTitle ? `${row.title} – ${row.variantTitle}` : row.title, sku: row.sku, bin: row.bin };
    update(next);
  };
  const entered = Object.entries(draft);
  const [reviewing, setReviewing] = useState(false);

  // Scan to count: each scan adds one to that item's count
  const [scanMsg, setScanMsg] = useState(null);
  const onScan = (code) => {
    const c = String(code).trim().toLowerCase();
    if (!c) return;
    const row = rows.find((r) => [r.sku, r.barcode].some((v) => v && String(v).trim().toLowerCase() === c));
    if (!row) return setScanMsg({ ok: false, text: `${code} isn't in this list. Search for it first.` });
    if (!row.tracked || row.preorderLimited) return setScanMsg({ ok: false, text: `${row.title}: can't be counted here.` });
    const now = (draft[row.variantId]?.count ?? 0) + 1;
    setCount(row, now);
    setScanMsg({ ok: true, text: `${row.title}${row.variantTitle ? ` – ${row.variantTitle}` : ""}: ${now}` });
    document.getElementById(`count-${row.variantId}`)?.scrollIntoView?.({ block: "nearest" });
  };

  const search = (patch) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => go(patch), 350);
  };

  return (
    <QuickViewContext.Provider value={setQuickView}>
      <s-page heading="Stock" inlineSize="large">
        <s-section>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <span style={small}>Location</span>
              <select value={locationId ?? ""} onChange={(e) => go({ location: e.target.value })} style={input} aria-label="Location">
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                search({ q: e.target.value.trim() });
              }}
              placeholder="Search title, SKU or barcode"
              aria-label="Search items"
              style={{ ...input, minWidth: "220px", flexGrow: 1, maxWidth: "320px" }}
            />
            <input
              value={bin}
              onChange={(e) => {
                setBinFilter(e.target.value);
                search({ bin: e.target.value.trim() });
              }}
              placeholder="Bin starts with (e.g. A-)"
              aria-label="Bins starting with"
              style={{ ...input, width: "170px" }}
            />
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <input type="checkbox" checked={query.missing} onChange={(e) => go({ missing: e.target.checked ? "1" : null })} />
              Only items without a bin
            </label>
            {navigation.state === "loading" && <span style={small}>Loading…</span>}
            <span style={{ flex: 1 }} />
            {canBins && <ImportBins />}
            <ExportBins />
          </div>
          <div style={{ marginTop: "8px" }}>
            <ShopifySync status={sync} canEdit={canBins} />
          </div>
          {error && (
            <s-banner tone="critical" heading="Couldn't load stock">
              <s-paragraph>{error}</s-paragraph>
            </s-banner>
          )}
        </s-section>

        {canCount && (
          <CountBar
            entered={entered}
            location={location}
            onScan={onScan}
            scanMsg={scanMsg}
            onReview={() => setReviewing(true)}
            onClear={() => update({})}
          />
        )}

        <s-section>
          <div style={{ ...small, marginBottom: "8px" }}>
            {total.toLocaleString()} item{total === 1 ? "" : "s"}
            {capped ? ` · showing the first ${rows.length.toLocaleString()} by bin. Filter by bin or search to see the rest.` : ""} · Numbers are live from Shopify at{" "}
            <strong>{location?.name ?? "—"}</strong>.{" "}
            <span title="On hand = available + committed (+ any reserved or damaged)">Committed is ordered but not shipped yet.</span>
          </div>
          {!rows.length ? (
            <s-paragraph>{query.q || query.bin || query.missing ? "No items match." : "No items yet. Items with a bin, and items on open orders, are listed here. Search to find anything else."}</s-paragraph>
          ) : (
            <div style={{ ...box, maxHeight: "70vh" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
                <thead>
                  <tr>
                    <th style={head}>Item</th>
                    <th style={head}>SKU / barcode</th>
                    <th style={head}>Bin</th>
                    <th style={numHead} title="Can be sold now">
                      Available
                    </th>
                    <th style={numHead} title="Ordered but not shipped yet">
                      Committed
                    </th>
                    <th style={numHead} title="Physically on the shelf: available + committed (+ reserved or damaged)">
                      On hand
                    </th>
                    {canCount && <th style={numHead}>Count</th>}
                    {canCount && (
                      <th style={numHead} title="Count − on hand">
                        Difference
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <Row key={r.variantId} r={r} index={i} canBins={canBins} canCount={canCount} entry={draft[r.variantId]} onCount={(v) => setCount(r, v)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-section>

        <RecentCounts counts={recent} />

        {reviewing && (
          <Review
            entered={entered}
            rows={rows}
            location={location}
            onClose={() => setReviewing(false)}
            onDone={(results) => {
              // Keep counts that didn't go through, so they can be checked and counted again
              const keep = Object.fromEntries(results.filter((r) => ["changed", "failed"].includes(r.status)).map((r) => [r.variantId, draft[r.variantId]]).filter(([, v]) => v));
              update(keep);
              revalidator.revalidate();
            }}
          />
        )}
        {quickView && <QuickView productId={quickView} canEdit={canEditDates} onClose={() => setQuickView(null)} onSaved={() => revalidator.revalidate()} />}
      </s-page>
    </QuickViewContext.Provider>
  );
}

function Row({ r, index, canBins, canCount, entry, onCount }) {
  const countable = r.tracked && !r.preorderLimited;
  const diff = entry && r.stocked ? entry.count - r.onHand : entry ? entry.count : null;
  const stale = entry && entry.seen !== (r.stocked ? r.onHand : null);
  return (
    <tr style={entry ? { background: "#f4f8ff" } : undefined}>
      <td style={cell}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <ProductThumb src={r.imageUrl} />
          <span>
            <ProductName id={r.productId}>{r.title}</ProductName>
            {r.variantTitle && <span style={muted}> – {r.variantTitle}</span>}
            {r.units > 0 && <div style={small}>{r.units} on open orders</div>}
            {r.preorderLimited && <div style={{ ...small, color: "#8a6116" }}>Stock managed by a pre-order countdown</div>}
            {!r.tracked && <div style={small}>Doesn't track stock</div>}
          </span>
        </div>
      </td>
      <td style={{ ...cell, ...small }}>{[r.sku, r.barcode && r.barcode !== r.sku ? r.barcode : null].filter(Boolean).join(" · ") || "—"}</td>
      <td style={cell}>
        <BinCell item={{ variantId: r.variantId, productId: r.productId, title: r.title, variantTitle: r.variantTitle, sku: r.sku, barcode: r.barcode, bin: r.bin }} canEdit={canBins} />
      </td>
      {r.stocked ? (
        <>
          <td style={{ ...num, color: r.available < 0 ? "#b42318" : undefined }}>{r.available.toLocaleString()}</td>
          <td style={num}>{r.committed.toLocaleString()}</td>
          <td style={{ ...num, fontWeight: 600 }}>{r.onHand.toLocaleString()}</td>
        </>
      ) : (
        <td colSpan={3} style={{ ...num, ...small }}>
          {r.tracked ? "Not stocked here" : "—"}
        </td>
      )}
      {canCount && (
        <td style={num}>
          {countable ? (
            <input
              id={`count-${r.variantId}`}
              data-count="1"
              inputMode="numeric"
              value={entry ? String(entry.count) : ""}
              placeholder="—"
              onChange={(e) => onCount(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const all = [...document.querySelectorAll("input[data-count]")];
                  all[all.indexOf(e.currentTarget) + 1]?.focus();
                }
              }}
              aria-label={`Count for ${r.title}${r.variantTitle ? ` – ${r.variantTitle}` : ""}`}
              style={{ ...input, width: "72px", textAlign: "right", fontWeight: 600 }}
            />
          ) : (
            <span style={small}>—</span>
          )}
        </td>
      )}
      {canCount && (
        <td style={{ ...num, fontWeight: 600, color: diff > 0 ? "#1a7f37" : diff < 0 ? "#b42318" : "#616161" }}>
          {diff === null ? "" : signed(diff)}
          {stale && (
            <div style={{ ...small, color: "#8a6116", fontWeight: 400 }} title="On hand changed after you counted">
              Changed since counted
            </div>
          )}
        </td>
      )}
    </tr>
  );
}

function CountBar({ entered, location, onScan, scanMsg, onReview, onClear }) {
  const [code, setCode] = useState("");
  const n = entered.length;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "10px",
        alignItems: "center",
        padding: "10px 14px",
        margin: "0 0 12px",
        background: n ? "#f1f8ff" : "#fff",
        border: `1px solid ${n ? "#b5d4f4" : "#e3e3e3"}`,
        borderRadius: "12px",
      }}
    >
      <strong>Count</strong>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onScan(code);
          setCode("");
        }}
        style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}
      >
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan to add 1" aria-label="Scan an item to add one to its count" autoComplete="off" style={{ ...input, width: "170px" }} />
      </form>
      {scanMsg && <span style={{ ...small, color: scanMsg.ok ? "#1a7f37" : "#b42318", fontWeight: 600 }}>{scanMsg.text}</span>}
      <span style={{ flex: 1 }} />
      <span style={small}>
        {n ? `${n} count${n === 1 ? "" : "s"} entered for ${location?.name ?? "this location"} (kept in this browser until submitted)` : "Type counts in the table, or scan items."}
      </span>
      {n > 0 && (
        <>
          <s-button variant="tertiary" onClick={onClear}>
            Clear counts
          </s-button>
          <s-button variant="primary" onClick={onReview}>
            Review and submit {n}
          </s-button>
        </>
      )}
    </div>
  );
}

// Review the changes, then confirm: this overwrites On hand in Shopify
function Review({ entered, rows, location, onClose, onDone }) {
  const fetcher = useFetcher();
  const [sure, setSure] = useState(false);
  const live = useMemo(() => new Map(rows.map((r) => [r.variantId, r])), [rows]);
  const list = entered.map(([variantId, e]) => {
    const r = live.get(variantId);
    const now = r ? (r.stocked ? r.onHand : null) : e.seen;
    return { variantId, ...e, now, diff: e.count - (now ?? 0), stale: r ? e.seen !== now : false };
  });
  const changes = list.filter((x) => x.diff !== 0 || x.now === null);
  const same = list.length - changes.length;
  const done = fetcher.data?.intent === "applyCounts" ? fetcher.data : null;
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (done?.ok) onDone(done.results);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const submit = () =>
    fetcher.submit(
      { intent: "applyCounts", locationId: location.id, counts: JSON.stringify(list.map((x) => ({ variantId: x.variantId, seen: x.seen, count: x.count }))) },
      { method: "post" },
    );

  return (
    <div role="presentation" onClick={() => !busy && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "grid", placeItems: "center", padding: "16px" }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        onClick={(e) => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: "12px", width: "min(720px, 100%)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,0.25)" }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #e3e3e3", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong id="review-title" style={{ fontSize: "16px" }}>
            {done ? "Counts submitted" : `Review ${list.length} count${list.length === 1 ? "" : "s"}`}
          </strong>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" style={{ appearance: "none", border: 0, background: "none", fontSize: "20px", cursor: "pointer" }}>
            ×
          </button>
        </div>
        <div style={{ padding: "14px 18px", overflow: "auto" }}>
          {done ? (
            <Results done={done} />
          ) : (
            <>
              <div role="alert" style={{ padding: "12px 14px", borderRadius: "8px", background: "#fff1e3", borderLeft: "4px solid #d72c0d", marginBottom: "12px" }}>
                <strong>This overwrites stock in Shopify.</strong>
                <div style={{ marginTop: "4px" }}>
                  Each count replaces the item's <strong>On hand</strong> at <strong>{location?.name}</strong>. Whatever Shopify has now is overwritten, and
                  Available becomes count − committed. This can't be undone from here.
                </div>
              </div>
              {changes.length > 0 ? (
                <div style={{ ...box, maxHeight: "45vh" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
                    <thead>
                      <tr>
                        <th style={head}>Item</th>
                        <th style={head}>Bin</th>
                        <th style={numHead}>On hand now</th>
                        <th style={numHead}>Count</th>
                        <th style={numHead}>Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((x) => (
                        <tr key={x.variantId}>
                          <td style={cell}>
                            {x.title}
                            {x.sku && <div style={small}>{x.sku}</div>}
                            {x.stale && <div style={{ ...small, color: "#8a6116" }}>Changed since counted: will be skipped</div>}
                          </td>
                          <td style={cell}>{x.bin ?? "—"}</td>
                          <td style={num}>{x.now === null ? "Not stocked" : x.now}</td>
                          <td style={{ ...num, fontWeight: 600 }}>{x.count}</td>
                          <td style={{ ...num, fontWeight: 600, color: x.diff > 0 ? "#1a7f37" : x.diff < 0 ? "#b42318" : "#616161" }}>{signed(x.diff)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <s-paragraph>Every count matches what Shopify has. Nothing will change.</s-paragraph>
              )}
              {same > 0 && (
                <div style={{ ...small, marginTop: "8px" }}>
                  {same} more match what Shopify has and won't change.
                </div>
              )}
              <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", marginTop: "14px" }}>
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} style={{ marginTop: "3px" }} />
                <span>
                  I understand this will overwrite On hand in Shopify at {location?.name} for {changes.length} item{changes.length === 1 ? "" : "s"}.
                </span>
              </label>
              {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "8px" }}>{fetcher.data.error}</div>}
            </>
          )}
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid #e3e3e3", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          {done ? (
            <s-button variant="primary" onClick={onClose}>
              Done
            </s-button>
          ) : (
            <>
              <s-button variant="tertiary" onClick={onClose} {...(busy ? { disabled: true } : {})}>
                Keep counting
              </s-button>
              <s-button variant="primary" tone="critical" onClick={submit} {...(!sure || busy ? { disabled: true } : {})} {...(busy ? { loading: true } : {})}>
                Overwrite {changes.length} in Shopify
              </s-button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS = {
  applied: ["Updated", "#1a7f37"],
  unchanged: ["Already right", "#616161"],
  changed: ["Skipped: changed", "#8a6116"],
  skipped: ["Skipped", "#8a6116"],
  failed: ["Failed", "#b42318"],
};

function Results({ done }) {
  const problems = done.results.filter((r) => ["changed", "skipped", "failed"].includes(r.status));
  return (
    <>
      <div role="status" style={{ padding: "10px 12px", borderRadius: "8px", background: problems.length ? "#fff1e3" : "#f1f8f5", marginBottom: "10px" }}>
        <strong>
          {done.applied} updated in Shopify{done.unchanged ? `, ${done.unchanged} already right` : ""}
          {problems.length ? `, ${problems.length} not changed` : ""}.
        </strong>
        {problems.length > 0 && <div style={{ marginTop: "4px" }}>Counts that didn't go through are kept so you can check them and count again.</div>}
      </div>
      <div style={{ ...box, maxHeight: "50vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
          <thead>
            <tr>
              <th style={head}>Item</th>
              <th style={numHead}>Before</th>
              <th style={numHead}>Count</th>
              <th style={head}>Result</th>
            </tr>
          </thead>
          <tbody>
            {[...problems, ...done.results.filter((r) => !problems.includes(r))].map((r) => (
              <tr key={r.variantId}>
                <td style={cell}>
                  {r.title}
                  {r.error && <div style={{ ...small, color: STATUS[r.status]?.[1] }}>{r.error}</div>}
                </td>
                <td style={num}>{r.before ?? "—"}</td>
                <td style={{ ...num, fontWeight: 600 }}>{r.counted}</td>
                <td style={{ ...cell, color: STATUS[r.status]?.[1], fontWeight: 600 }}>{STATUS[r.status]?.[0] ?? r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RecentCounts({ counts }) {
  const [open, setOpen] = useState(null);
  if (!counts.length) return null;
  return (
    <s-section heading="Recent counts">
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
        <tbody>
          {counts.map((c) => (
            <Fragment key={c.id}>
              <tr>
                <td style={cell}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === c.id ? null : c.id)}
                    aria-expanded={open === c.id}
                    style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" }}
                  >
                    {open === c.id ? "▾" : "▸"} {when(c.at)}
                  </button>
                </td>
                <td style={cell}>{c.userName ?? "—"}</td>
                <td style={cell}>{c.locationName ?? "—"}</td>
                <td style={cell}>
                  {c.applied} updated{c.failed ? <span style={{ color: "#8a6116" }}> · {c.failed} not changed</span> : ""}
                </td>
              </tr>
              {open === c.id && (
                <tr>
                  <td colSpan={4} style={{ ...cell, background: "#fafafa" }}>
                    {c.items.map((r) => (
                      <div key={r.variantId} style={small}>
                        {r.title}
                        {r.bin ? ` (${r.bin})` : ""}: {r.before ?? "—"} → {r.counted} · {STATUS[r.status]?.[0] ?? r.status}
                        {r.error ? ` · ${r.error}` : ""}
                      </div>
                    ))}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </s-section>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
