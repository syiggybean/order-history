import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { ProductThumb, preloadImages } from "../components/shipping/ui";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { MilestoneError, RANGES, createDrafts, dismiss, getSettings, loadDetails, saveMarkup, suggestions } from "../milestone.server";

// Milestone: what's been invoiced on Milestone's B2B site that the shop
// doesn't sell yet, with a draft product made in one go.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "purchaseOrders", "view");
  if (noAccess) return { noAccess: true };
  const settings = await getSettings(session.shop);
  return {
    canCreate: can(user, "purchaseOrders", "generate"),
    yenRate: settings.yenRate ?? null,
    markupPercent: settings.markupPercent ?? null,
    ranges: RANGES,
    lastRunAt: settings.lastRunAt?.toISOString() ?? null,
    loginSet: Boolean(process.env.MILESTONE_EMAIL && process.env.MILESTONE_PASSWORD),
  };
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "purchaseOrders", "view")) return denied("purchaseOrders", "view");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const shop = session.shop;
  try {
    if (intent === "details") return { intent, ok: true, ...(await loadDetails(shop, JSON.parse(String(form.get("codes") ?? "[]")))) };
    if (intent === "check") return { intent, ok: true, ...(await suggestions(shop, admin, { range: String(form.get("range") ?? "3") })) };
    if (!can(user, "purchaseOrders", "generate")) return denied("purchaseOrders", "generate");
    if (intent === "markup") return { intent, ok: true, markupPercent: await saveMarkup(shop, form.get("markup")) };
    if (intent === "dismiss" || intent === "undismiss") {
      await dismiss(shop, JSON.parse(String(form.get("codes") ?? "[]")).map(String), user, intent === "undismiss");
      return { intent, ok: true };
    }
    if (intent === "create") return { intent, ok: true, results: await createDrafts(shop, admin, JSON.parse(String(form.get("items") ?? "[]")), user) };
  } catch (e) {
    if (!(e instanceof MilestoneError)) console.error(`[milestone] ${intent}:`, e);
    return { intent, error: e instanceof MilestoneError ? e.message : errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

export const headers = (headersArgs) => boundary.headers(headersArgs);

// ---------------------------------------------------------------------------

const cellS = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
const headS = { ...cellS, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 1 };
const small = { fontSize: "12px", color: "#616161" };
const input = { padding: "6px 8px", border: "1px solid #c9c9c9", borderRadius: "8px", font: "inherit", fontSize: "13px", boxSizing: "border-box" };
const pill = (bg, fg) => ({ background: bg, color: fg, borderRadius: "999px", padding: "2px 8px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });
const yenFmt = (n) => (n == null ? "—" : `¥${Number(n).toLocaleString("en-US")}`);
const dayFmt = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const adminLink = (productId) => `shopify:admin/products/${String(productId).split("/").pop()}`;

export default function Milestone() {
  const data = useLoaderData();
  const check = useFetcher();
  const create = useFetcher();
  const mark = useFetcher();
  const markupSave = useFetcher();
  const [range, setRange] = useState("3");
  // Price = cost × (1 + markup%), saved for next time; empty uses Milestone's retail price
  const [markup, setMarkup] = useState(data.markupPercent == null ? "" : String(data.markupPercent));
  // Fetched with each check (today's rate); can be changed for this check
  const [rate, setRate] = useState("");
  const [picked, setPicked] = useState(() => new Set());
  const [edits, setEdits] = useState({}); // msCode → { title, price, cost, sku }
  const [show, setShow] = useState("new");
  const [done, setDone] = useState({}); // msCode → result of creating
  const [hidden, setHidden] = useState({}); // msCode → dismissed here

  const result = check.data?.intent === "check" && check.data.ok ? check.data : null;
  // Milestone product pages (maker, prices, photos) not read this week load a
  // batch at a time after the list, so Milestone isn't read too fast
  const more = useFetcher();
  const [queue, setQueue] = useState([]);
  const [extra, setExtra] = useState({}); // msCode → details
  const [failed, setFailed] = useState({}); // msCode → why
  const inflight = useRef(null);
  useEffect(() => {
    setQueue(result?.pending ?? []);
    setExtra({});
    setFailed({});
  }, [result]);
  useEffect(() => {
    if (more.state !== "idle" || inflight.current || !queue.length) return;
    const batch = queue.slice(0, 10);
    inflight.current = batch;
    setQueue(queue.slice(10));
    more.submit({ intent: "details", codes: JSON.stringify(batch) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [more.state, queue]);
  useEffect(() => {
    const d = more.data;
    const batch = inflight.current;
    if (d?.intent !== "details" || !batch) return;
    inflight.current = null;
    if (d.ok) {
      setExtra((e) => ({ ...e, ...d.details }));
      setFailed((f) => ({ ...f, ...d.errors }));
      setQueue((q) => [...(d.later ?? []), ...q]);
    } else {
      // Couldn't sign in or similar: the rest would fail the same way
      setQueue((q) => {
        setFailed((f) => ({ ...f, ...Object.fromEntries([...batch, ...q].map((c) => [c, d.error])) }));
        return [];
      });
    }
  }, [more.data]);
  const totalPending = result?.pending?.length ?? 0;
  const loadedCount = Object.keys(extra).length + Object.keys(failed).length;
  const items = useMemo(
    () =>
      (result?.items ?? []).map((x) =>
        extra[x.msCode] ? { ...x, details: extra[x.msCode], maker: extra[x.msCode].maker ?? x.maker } : failed[x.msCode] ? { ...x, details: null, detailsError: failed[x.msCode] } : x,
      ),
    [result, extra, failed],
  );
  useEffect(() => {
    if (result?.yenRate) setRate(String(Math.round(result.yenRate * 1e6) / 1e6));
  }, [result]);
  // Full-size photos load in the background as soon as the list arrives, so
  // hovering shows them sharp straight away
  useEffect(() => {
    preloadImages(items.map((x) => x.details?.images?.[0]));
  }, [items]);
  useEffect(() => {
    if (create.data?.intent !== "create") return;
    const next = { ...done };
    for (const r of create.data.results ?? []) next[r.msCode] = r;
    setDone(next);
    setPicked(new Set([...picked].filter((c) => !next[c]?.ok)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [create.data]);

  if (data.noAccess) return <NoAccess />;
  const statusOf = (x) => (done[x.msCode]?.ok ? "created" : hidden[x.msCode] === true ? "dismissed" : hidden[x.msCode] === false ? "new" : x.status);
  const counts = items.reduce((n, x) => ((n[statusOf(x)] = (n[statusOf(x)] ?? 0) + 1), n), {});
  const shown = items.filter((x) => (show === "all" ? true : statusOf(x) === show));
  const val = (x, k, fallback) => edits[x.msCode]?.[k] ?? fallback;
  const setVal = (x, k, v) => setEdits({ ...edits, [x.msCode]: { ...(edits[x.msCode] ?? {}), [k]: v } });
  const r = Number(rate) || null;
  const m = markup.trim() === "" || !(Number(markup) >= 0) ? null : Number(markup);
  // The invoice price is what was paid; Milestone's page price if it's missing
  const wholesaleOf = (x) => x.wholesaleYen ?? x.details?.wholesaleYen ?? null;
  const costOf = (x) => val(x, "cost", wholesaleOf(x) && r ? (Math.round(wholesaleOf(x) * r * 100) / 100).toFixed(2) : "");
  const priceOf = (x) => {
    if (edits[x.msCode]?.price != null) return edits[x.msCode].price;
    if (m != null) {
      const c = Number(costOf(x));
      return c > 0 ? (Math.round(c * (1 + m / 100) * 100) / 100).toFixed(2) : "";
    }
    return x.details?.retailYen && r ? (Math.round(x.details.retailYen * r * 100) / 100).toFixed(2) : "";
  };
  // This item's markup: what was typed, or worked out from its price and cost
  const markupOf = (x) => {
    if (edits[x.msCode]?.markup != null) return edits[x.msCode].markup;
    const c = Number(costOf(x));
    const p = Number(priceOf(x));
    return c > 0 && p > 0 ? String(Math.round((p / c - 1) * 1000) / 10) : "";
  };
  // Typing a price works out the markup; typing a markup works out the price
  const setPrice = (x, v) => setEdits({ ...edits, [x.msCode]: { ...(edits[x.msCode] ?? {}), price: v, markup: undefined } });
  const setRowMarkup = (x, v) => {
    const c = Number(costOf(x));
    const mm = Number(v);
    const price = v.trim() !== "" && mm >= 0 && c > 0 ? (Math.round(c * (1 + mm / 100) * 100) / 100).toFixed(2) : edits[x.msCode]?.price;
    setEdits({ ...edits, [x.msCode]: { ...(edits[x.msCode] ?? {}), markup: v, price } });
  };
  const setCost = (x, v) => {
    // A markup typed for this item keeps its price following the cost
    const e = edits[x.msCode] ?? {};
    const mm = Number(e.markup);
    const price = e.markup != null && e.markup.trim() !== "" && mm >= 0 && Number(v) > 0 ? (Math.round(Number(v) * (1 + mm / 100) * 100) / 100).toFixed(2) : e.price;
    setEdits({ ...edits, [x.msCode]: { ...e, cost: v, price } });
  };
  const pickable = shown.filter((x) => statusOf(x) === "new");

  const createPicked = () => {
    const list = items
      .filter((x) => picked.has(x.msCode))
      .map((x) => ({
        msCode: x.msCode,
        jan: x.jan,
        title: val(x, "title", x.title || x.details?.title),
        maker: x.maker,
        category: x.details?.category ?? null,
        price: priceOf(x),
        cost: costOf(x),
        sku: val(x, "sku", x.jan ?? ""),
        images: x.details?.images ?? [],
      }));
    create.submit({ intent: "create", items: JSON.stringify(list) }, { method: "post" });
  };
  const missingPrice = items.filter((x) => picked.has(x.msCode) && !(Number(priceOf(x)) > 0)).length;
  const error = check.data?.error ?? create.data?.error ?? mark.data?.error ?? markupSave.data?.error;

  return (
    <s-page heading="Milestone" inlineSize="large">
      <s-section>
        <s-paragraph>
          Reads your invoices on Milestone's B2B site and suggests the invoiced items the shop doesn't sell yet (no product with that JAN code as its
          barcode or SKU). Pick the ones to add and they're made in Shopify as draft products with Milestone's photos, the maker as vendor and the JAN as
          barcode. Nothing is published.
        </s-paragraph>
        {!data.loginSet && (
          <s-banner tone="warning">
            <s-paragraph>Add MILESTONE_EMAIL and MILESTONE_PASSWORD (Milestone's B2B login) in Railway first.</s-paragraph>
          </s-banner>
        )}
        <div style={{ display: "flex", gap: "16px", alignItems: "flex-end", flexWrap: "wrap", marginTop: "10px" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Invoices from
            <select value={range} onChange={(e) => setRange(e.target.value)} style={{ ...input, width: "150px" }}>
              {Object.entries(data.ranges ?? {}).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <s-button variant="primary" onClick={() => check.submit({ intent: "check", range }, { method: "post" })} {...(check.state !== "idle" ? { loading: true } : {})}>
            {result ? "Check again" : "Check Milestone"}
          </s-button>
          {data.canCreate && result && (
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              Dollars per yen
              <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Enter a rate" inputMode="decimal" style={{ ...input, width: "110px" }} />
            </label>
          )}
          {data.canCreate && (
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              Markup %
              <input
                value={markup}
                onChange={(e) => setMarkup(e.target.value.replace(/[^\d.]/g, ""))}
                onBlur={() => {
                  if (String(data.markupPercent ?? "") !== markup.trim()) markupSave.submit({ intent: "markup", markup: markup.trim() }, { method: "post" });
                }}
                placeholder="Retail price"
                inputMode="decimal"
                aria-label="Markup percentage"
                style={{ ...input, width: "110px" }}
              />
            </label>
          )}
          <span style={small}>
            {check.state !== "idle"
              ? "Signing in to Milestone and reading the invoices…"
              : result
                ? `Checked ${new Date(result.checkedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                : data.lastRunAt
                  ? `Last checked ${new Date(data.lastRunAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                  : ""}
          </span>
        </div>
        {result && totalPending > 0 && (
          <div style={{ ...small, marginTop: "6px", display: "flex", gap: "8px", alignItems: "center" }}>
            {loadedCount < totalPending || queue.length || inflight.current ? (
              <span>
                Reading Milestone's product pages (photos, maker, retail price): {Math.min(loadedCount, totalPending)} of {totalPending}. Milestone limits
                how fast it can be read, so this takes a moment; pages read are kept for a week.
              </span>
            ) : Object.keys(failed).length ? (
              <>
                <span>{Object.keys(failed).length} product page{Object.keys(failed).length === 1 ? "" : "s"} couldn't be read.</span>
                <s-button
                  variant="tertiary"
                  onClick={() => {
                    const again = Object.keys(failed);
                    setFailed({});
                    setQueue(again);
                  }}
                >
                  Try those again
                </s-button>
              </>
            ) : null}
          </div>
        )}
        <div style={{ ...small, marginTop: "6px" }}>
          {result?.yenRate
            ? `Today's rate from the ${result.rateSource}${result.rateDate ? ` (${result.rateDate})` : ""}: ¥1 = $${(Math.round(result.yenRate * 1e6) / 1e6).toString()}, so ¥1,000 = $${(result.yenRate * 1000).toFixed(2)}. `
            : result
              ? "Couldn't get today's exchange rate: enter one above. "
              : "Each check uses today's yen to dollar exchange rate. "}
          Cost is the invoiced price at that rate.{" "}
          {m != null
            ? `Price is cost plus ${m}% (×${(1 + m / 100).toFixed(2)}). Clear the markup to use Milestone's retail price instead.`
            : "Price is Milestone's retail price at that rate, or enter a markup % to price from cost."}{" "}
          Change any of them before creating: type a price and its markup is worked out, or type a markup and the price is.
        </div>
      </s-section>

      {error && (
        <s-banner tone="critical">
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      )}

      {result?.unread?.length > 0 && (
        <s-banner tone="warning">
          <s-paragraph>
            Couldn't read {result.unread.length} invoice{result.unread.length === 1 ? "" : "s"}: {result.unread.map((u) => `${u.number} (${u.error})`).join("; ")}
          </s-paragraph>
        </s-banner>
      )}

      {result && (
        <s-section heading={`Invoiced items (${items.length}) from ${result.invoiceCount} invoice${result.invoiceCount === 1 ? "" : "s"}${result.since ? ` since ${dayFmt(result.since)}` : ""}`}>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}>
            {[
              ["new", `Not in the shop (${counts.new ?? 0})`],
              ["created", `Created (${counts.created ?? 0})`],
              ["inShop", `Already sold (${counts.inShop ?? 0})`],
              ["dismissed", `Not selling (${counts.dismissed ?? 0})`],
              ["all", `All (${items.length})`],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setShow(id)}
                style={{
                  appearance: "none",
                  font: "inherit",
                  fontSize: "12px",
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: "999px",
                  cursor: "pointer",
                  border: `1px solid ${show === id ? "#1a1a1a" : "#d4d4d4"}`,
                  background: show === id ? "#1a1a1a" : "#fff",
                  color: show === id ? "#fff" : "#303030",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {data.canCreate && picked.size > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", padding: "10px 12px", marginBottom: "10px", background: "#f1f6ff", borderRadius: "10px" }}>
              <strong style={{ fontSize: "13px" }}>{picked.size} picked</strong>
              <s-button variant="primary" onClick={createPicked} {...(create.state !== "idle" ? { loading: true } : {})} {...(missingPrice ? { disabled: true } : {})}>
                Create {picked.size} draft product{picked.size === 1 ? "" : "s"}
              </s-button>
              <s-button
                variant="tertiary"
                onClick={() => {
                  mark.submit({ intent: "dismiss", codes: JSON.stringify([...picked]) }, { method: "post" });
                  setHidden({ ...hidden, ...Object.fromEntries([...picked].map((c) => [c, true])) });
                  setPicked(new Set());
                }}
              >
                Not selling these
              </s-button>
              {missingPrice > 0 && <span style={{ ...small, color: "#b42318" }}>{missingPrice} without a price: enter one.</span>}
            </div>
          )}

          {shown.length === 0 ? (
            <s-paragraph>Nothing here.</s-paragraph>
          ) : (
            <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", overflow: "auto", maxHeight: "70vh" }}>
              <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: "13px" }}>
                <thead>
                  <tr>
                    {data.canCreate && (
                      <th style={{ ...headS, width: "34px" }}>
                        <input
                          type="checkbox"
                          aria-label="Pick all"
                          checked={pickable.length > 0 && pickable.every((x) => picked.has(x.msCode))}
                          onChange={(e) => setPicked(e.target.checked ? new Set(pickable.map((x) => x.msCode)) : new Set())}
                        />
                      </th>
                    )}
                    {["Item", "Codes", "Invoiced", "Retail / invoiced", "Cost", "Price", "Markup", "SKU", ""].map((h, i) => (
                      <th key={i} style={headS}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((x) => {
                    const st = statusOf(x);
                    const editable = data.canCreate && st === "new";
                    const res = done[x.msCode];
                    const img = x.details?.images?.[0];
                    return (
                      <tr key={x.msCode} style={{ background: picked.has(x.msCode) ? "#f7fbff" : undefined }}>
                        {data.canCreate && (
                          <td style={cellS}>
                            {st === "new" && (
                              <input
                                type="checkbox"
                                aria-label={`Pick ${x.title}`}
                                checked={picked.has(x.msCode)}
                                onChange={(e) => {
                                  const next = new Set(picked);
                                  e.target.checked ? next.add(x.msCode) : next.delete(x.msCode);
                                  setPicked(next);
                                }}
                              />
                            )}
                          </td>
                        )}
                        <td style={{ ...cellS, minWidth: "280px" }}>
                          <div style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
                            {img ? (
                              // Hover for the full-size photo
                              <ProductThumb
                                src={img.replace(/(\.\w+)$/, "_350x350$1")}
                                large={img}
                                size={56}
                                style={{ objectFit: "contain", borderRadius: 6, background: "#f6f6f6", flexShrink: 0 }}
                              />
                            ) : (
                              <div style={{ width: 56, height: 56, borderRadius: 6, background: "#f1f1f1", flexShrink: 0 }} />
                            )}
                            <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, flex: 1 }}>
                              {editable ? (
                                <input
                                  value={val(x, "title", x.title || x.details?.title)}
                                  onChange={(e) => setVal(x, "title", e.target.value)}
                                  aria-label="Product title"
                                  style={{ ...input, width: "100%" }}
                                />
                              ) : (
                                <strong>{x.title}</strong>
                              )}
                              <span style={small}>
                                {[x.maker, x.details?.category].filter(Boolean).join(" · ")}
                                {x.details?.images?.length ? ` · ${x.details.images.length} photo${x.details.images.length === 1 ? "" : "s"}` : ""}
                              </span>
                              <span>
                                {st === "inShop" && (
                                  <a href={adminLink(x.productId)} target="_top" style={{ ...pill("#e3f5e8", "#0c5132"), textDecoration: "none" }}>
                                    In the shop: {x.inShop?.title} ↗
                                  </a>
                                )}
                                {st === "created" && (
                                  <a href={adminLink(res?.productId ?? x.productId)} target="_top" style={{ ...pill("#e6f4ff", "#0b4f8a"), textDecoration: "none" }}>
                                    Draft created ↗
                                  </a>
                                )}
                                {st === "dismissed" && <span style={pill("#f1f1f1", "#616161")}>Not selling{x.markedBy ? ` (${x.markedBy})` : ""}</span>}
                                {res && !res.ok && <span style={{ color: "#b42318", fontSize: "12px" }}>{res.error}</span>}
                                {x.detailsError && <span style={{ ...small, color: "#8a4b00" }}>Couldn't read its Milestone page: {x.detailsError}</span>}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td style={{ ...cellS, whiteSpace: "nowrap" }}>
                          <div>JAN {x.jan ?? "—"}</div>
                          <a href={`https://b2b.mile-stone.jp/en/products/${x.msCode}`} target="_blank" rel="noreferrer" style={small}>
                            {x.msCode} ↗
                          </a>
                        </td>
                        <td style={{ ...cellS, whiteSpace: "nowrap" }}>
                          {x.quantity} pcs
                          <div style={small} title={(x.invoices ?? []).map((v) => `${v.number} (${dayFmt(v.day)})`).join("\n")}>
                            {x.invoices?.[0]?.number ?? ""} · {dayFmt(x.invoiceDay)}
                            {x.invoices?.length > 1 ? ` +${x.invoices.length - 1} more` : ""}
                          </div>
                        </td>
                        <td style={{ ...cellS, whiteSpace: "nowrap" }}>
                          {yenFmt(x.details?.retailYen)}
                          <div style={small}>{yenFmt(wholesaleOf(x))}</div>
                        </td>
                        <td style={cellS}>
                          {editable ? (
                            <input value={costOf(x)} onChange={(e) => setCost(x, e.target.value)} inputMode="decimal" aria-label="Cost" placeholder="0.00" style={{ ...input, width: "80px" }} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={cellS}>
                          {editable ? (
                            <input value={priceOf(x)} onChange={(e) => setPrice(x, e.target.value)} inputMode="decimal" aria-label="Retail price" placeholder="0.00" style={{ ...input, width: "80px" }} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ ...cellS, whiteSpace: "nowrap" }}>
                          {editable ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                              <input
                                value={markupOf(x)}
                                onChange={(e) => setRowMarkup(x, e.target.value.replace(/[^\d.-]/g, ""))}
                                inputMode="decimal"
                                aria-label="Markup percentage"
                                placeholder="—"
                                style={{ ...input, width: "64px" }}
                              />
                              %
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={cellS}>
                          {editable ? (
                            <input value={val(x, "sku", x.jan ?? "")} onChange={(e) => setVal(x, "sku", e.target.value)} aria-label="SKU" style={{ ...input, width: "130px" }} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ ...cellS, whiteSpace: "nowrap" }}>
                          {data.canCreate && st === "dismissed" && (
                            <s-button
                              variant="tertiary"
                              onClick={() => {
                                mark.submit({ intent: "undismiss", codes: JSON.stringify([x.msCode]) }, { method: "post" });
                                setHidden({ ...hidden, [x.msCode]: false });
                              }}
                            >
                              Suggest again
                            </s-button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </s-section>
      )}
    </s-page>
  );
}
