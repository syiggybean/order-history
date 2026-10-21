import { Fragment, useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigation, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { denied, can, getStaff, loadWithAccess } from "../permissions.server";
import { NoAccess } from "../components/NoAccess";
import { getSyncStatus, kick, setPaused } from "../inventory-sync.server";
import { KIND_OPTIONS, SINCE_OPTIONS, itemName, listChanges, whoItems, whoSummary } from "../inventory-history.server";
import { UndoError, listUndos, previewUndo, undoChange } from "../inventory-undo.server";
import { catalogDetail, kickCatalog } from "../catalog.server";

const PAGE_SIZE = 10;

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "inventory", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const params = new URL(request.url).searchParams;
  const since = params.get("since") ?? "30d";
  const sinceKey = SINCE_OPTIONS[since] ? since : "30d";
  const kind = KIND_OPTIONS[params.get("show")] ? params.get("show") : "all";

  kick(shop); // make sure the sync is running (e.g. right after a deploy)
  kickCatalog(shop); // products/variants created or deleted (who, and past ones)

  const [status, recent, who, undos] = await Promise.all([
    getSyncStatus(shop),
    listChanges(shop, { kind }, { page: 1, pageSize: PAGE_SIZE }),
    whoSummary(shop, sinceKey),
    listUndos(shop, { page: 1, pageSize: PAGE_SIZE }),
  ]);
  const sinceOptions = Object.entries(SINCE_OPTIONS).map(([value, o]) => ({ value, label: o.label }));
  return {
    status,
    recent: { ...recent, kind },
    kind,
    kindOptions: Object.entries(KIND_OPTIONS).map(([value, o]) => ({ value, label: o.label })),
    who,
    undos,
    since: sinceKey,
    sinceOptions,
    isAdmin: Boolean(user?.isAdmin),
    canUndo: can(user, "inventory", "undo"),
  };
};

export const action = async ({ request }) => {
  const { session, admin, user } = await getStaff(request);
  if (!can(user, "inventory", "view")) return denied("inventory", "view");
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
  const since = String(form.get("since") ?? "30d");
  const page = Number(form.get("page") ?? 1);
  const who = form.has("whoApp") || form.has("whoStaff")
    ? { app: String(form.get("whoApp") ?? "") || null, staff: String(form.get("whoStaff") ?? "") || null }
    : null;

  if (intent === "pause" || intent === "resume") {
    if (!user?.isAdmin) return { error: "Only app admins can pause or resume loading history." };
    await setPaused(shop, intent === "pause");
    return { intent, ok: true };
  }
  if (intent === "undoPreview" || intent === "undo") {
    const key = String(form.get("key") ?? "");
    if (!can(user, "inventory", "undo")) return { intent, key, ...denied("inventory", "undo") };
    try {
      if (intent === "undoPreview") return { intent, key, preview: await previewUndo(shop, admin, key) };
      return { intent, key, ok: true, ...(await undoChange(shop, admin, user, key)) };
    } catch (e) {
      if (e instanceof UndoError) return { intent, key, error: e.message };
      console.error("Undo failed:", e);
      return { intent, key, error: "Something went wrong. Please try again." };
    }
  }
  if (intent === "undos") {
    return { intent, ...(await listUndos(shop, { page, pageSize: PAGE_SIZE })) };
  }
  if (intent === "recent") {
    const kind = KIND_OPTIONS[form.get("show")] ? String(form.get("show")) : "all";
    return { intent, page, kind, ...(await listChanges(shop, { kind }, { page, pageSize: PAGE_SIZE })) };
  }
  if (intent === "whoItems") {
    return { intent, who, since, items: await whoItems(shop, who, since) };
  }
  if (intent === "catalogDetail") {
    const detail = await catalogDetail(shop, form.get("id"));
    return detail ? { intent, detail } : { intent, error: "That entry couldn't be found." };
  }
  if (intent === "itemChanges") {
    const inventoryItemId = String(form.get("inventoryItemId"));
    const [result, name] = await Promise.all([
      listChanges(shop, { inventoryItemId }, { page, pageSize: PAGE_SIZE }),
      page === 1 ? itemName(shop, inventoryItemId) : null,
    ]);
    return { intent, who, page, inventoryItemId, name: name?.name ?? null, ...result };
  }
  return { error: "Unknown action" };
};

// Fetchers that only read (Show more, drill-down, undo check) don't need the
// whole page reloaded afterwards. Reloading would also reset "Show more" lists.
const READ_ONLY_INTENTS = new Set(["recent", "undos", "whoItems", "itemChanges", "undoPreview", "catalogDetail"]);
export const shouldRevalidate = ({ formData, defaultShouldRevalidate }) => {
  if (formData && READ_ONLY_INTENTS.has(String(formData.get("intent")))) return false;
  return defaultShouldRevalidate;
};

// When the page refreshes, put the fresh first page on top of what's already
// been loaded with "Show more" instead of throwing the extra pages away
function mergeFresh(prev, fresh, listKey, idKey) {
  if (!prev || (prev.page ?? 1) <= 1 || prev.kind !== fresh.kind) return fresh;
  const freshIds = new Set(fresh[listKey].map((x) => x[idKey]));
  const older = prev[listKey].filter((x) => !freshIds.has(x[idKey]) && !x.pending);
  return { ...prev, [listKey]: [...fresh[listKey], ...older] };
}

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap" };
const muted = { color: "#616161" };
const box = { overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };
const linkBtn = {
  appearance: "none", background: "none", border: 0, padding: 0, font: "inherit",
  color: "#005bd3", textDecoration: "underline", cursor: "pointer", textAlign: "left",
};
const selectStyle = { font: "inherit", padding: "4px 8px", borderRadius: "8px", border: "1px solid #c9c9c9" };
const changeColor = (n) => (n > 0 ? "#1a5e20" : n < 0 ? "#b42318" : undefined);
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const fmtTime = (iso) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const sameWho = (c, who) => who && (c.app ?? null) === (who.app ?? null) && (c.staff ?? null) === (who.staff ?? null);

// Rows float up and fade in as they arrive. Only newly added rows animate,
// because React keeps the rows that were already on screen.
const MOTION_CSS = `
@keyframes ohRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes ohPulse { 0%, 100% { opacity: .45; } 50% { opacity: .9; } }
.oh-rise { animation: ohRise .38s cubic-bezier(.2, .7, .3, 1) both; }
.oh-skel { display: block; height: 10px; border-radius: 6px; background: #e3e3e3; animation: ohPulse 1.1s ease-in-out infinite; }
.oh-skel-row { animation: ohRise .3s ease-out both; }
@media (prefers-reduced-motion: reduce) { .oh-rise, .oh-skel, .oh-skel-row { animation: none; } }
`;

function Table({ headers, children, maxHeight, onScroll, scrollRef, dim = false }) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{ ...box, ...(maxHeight ? { maxHeight } : {}), opacity: dim ? 0.55 : 1, transition: "opacity .2s ease" }}
    >
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} style={head}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function ChangeParts({ parts }) {
  if (!parts?.length) return "—";
  return parts.map((p, i) => (
    <span key={p.state} style={{ whiteSpace: "nowrap" }}>
      {i > 0 && <span style={muted}>, </span>}
      <strong style={{ color: i === 0 ? changeColor(p.change) : undefined }}>{signed(p.change)}</strong>{" "}
      <span style={i === 0 ? undefined : muted}>{p.label}</span>
    </span>
  ));
}


// What we know about a created or deleted product/variant
function CatalogPanel({ id, onItem, onClose }) {
  const fetcher = useFetcher();
  useEffect(() => {
    fetcher.submit({ intent: "catalogDetail", id: String(id) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const d = fetcher.data?.detail;
  if (fetcher.data?.error) return <div style={{ color: "#8e1f0b" }}>{fetcher.data.error}</div>;
  if (!d) return <div style={muted}>Loading…</div>;
  const p = d.product;
  const deletedNow = d.action === "deleted";
  const field = (label, value) =>
    value ? (
      <div style={{ display: "flex", gap: "8px", fontSize: "13px" }}>
        <span style={{ ...muted, width: "110px", flexShrink: 0 }}>{label}</span>
        <span>{value}</span>
      </div>
    ) : null;
  const shown = d.variants;
  return (
    <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
      {p?.imageUrl && (
        <img src={p.imageUrl} alt="" style={{ width: "96px", height: "96px", objectFit: "cover", borderRadius: "8px", border: "1px solid #e3e3e3", background: "#fff" }} />
      )}
      <div style={{ flex: 1, minWidth: "260px", display: "grid", gap: "4px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
          <strong style={{ fontSize: "15px" }}>
            {d.productTitle ?? (d.likelyTitle ? `Probably “${d.likelyTitle}”` : d.subject === "product" ? "Product name not recorded" : "Product not recorded")}
          </strong>
          {d.subject === "variant" && <span style={muted}>{d.variantTitle ? `· ${d.variantTitle}` : "· variant name not recorded"}</span>}
          {d.exists === false && <span style={{ ...muted, fontSize: "12px" }}>(product no longer in Shopify)</span>}
          {d.exists && d.productId && (
            <a href={`shopify:admin/products/${d.productId.split("/").pop()}`} target="_top" style={{ color: "#005bd3", fontSize: "13px" }}>
              Open product
            </a>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" style={linkBtn} onClick={onClose}>
            Close
          </button>
        </div>
        {field(deletedNow ? "Deleted" : "Created", `${fmtTime(d.at)}${d.who ? ` by ${d.who}` : ""}`)}
        {field("SKU", d.subject === "variant" ? d.sku : null)}
        {p && field("Vendor", p.vendor)}
        {p && field("Type", p.productType)}
        {p && field("Tags", p.tags)}
        {p && field("Status", p.status ? p.status[0].toUpperCase() + p.status.slice(1) : null)}
        {p && field("First created", p.createdAt ? fmtTime(p.createdAt) : null)}
        {d.nameSource && field("How we know", d.nameSource)}
        {d.pair && (
          <div style={{ marginTop: "4px", padding: "8px 10px", borderRadius: "8px", background: "#fff8e6", border: "1px solid #f3e3a1", fontSize: "13px" }}>
            <strong>{d.action === "deleted" ? "Re-created" : "Replaced a deleted product"}</strong>
            {" · "}
            {d.action === "deleted"
              ? `A product${d.pair.title ? ` named “${d.pair.title}”` : ""} was created ${Math.abs(d.pair.seconds)} second${Math.abs(d.pair.seconds) === 1 ? "" : "s"} ${d.pair.seconds >= 0 ? "later" : "earlier"}`
              : `A product${d.pair.title ? ` named “${d.pair.title}”` : ""} was deleted ${Math.abs(d.pair.seconds)} second${Math.abs(d.pair.seconds) === 1 ? "" : "s"} ${d.pair.seconds >= 0 ? "later" : "earlier"}`}
            {d.pair.who ? ` by ${d.pair.who}` : ""}.
            {d.action === "deleted" && d.likelyTitle && " That's why this one is probably the same product. "}
            {d.pair.exists && d.pair.productId && (
              <>
                {" "}
                <a href={`shopify:admin/products/${d.pair.productId.split("/").pop()}`} target="_top" style={{ color: "#005bd3" }}>
                  Open the new product
                </a>
              </>
            )}
            <div style={{ ...muted, fontSize: "12px", marginTop: "2px" }}>
              Deletions and creations at the same moment often mean an app or sync re-created the product. Use Show → “Products deleted and re-created” to see them all.
            </div>
          </div>
        )}
        {d.shopifyMessage && field("Shopify's log", `“${d.shopifyMessage}”`)}
        {p?.copiedAt && (
          <div style={{ ...muted, fontSize: "12px" }}>
            Details as last seen {fmtTime(p.copiedAt)}.
          </div>
        )}
        {d.lookup && (
          <div
            style={{
              fontSize: "13px",
              marginTop: "4px",
              padding: "6px 10px",
              borderRadius: "8px",
              background: d.lookup.state === "error" ? "#fde7e9" : d.lookup.state === "done" ? "#f1f1f1" : "#eaf4ff",
              color: d.lookup.state === "error" ? "#8e1f0b" : "#303030",
            }}
          >
            {d.lookup.state === "working" || d.lookup.state === "waiting" ? "⏳ " : ""}
            {d.lookup.text}
          </div>
        )}
        {!p && !d.variants.length && !d.lookup && !d.pair && (
          <div style={{ ...muted, fontSize: "12px" }}>
            Nothing else was recorded: this happened before the app kept copies of products.
          </div>
        )}
      </div>
      {shown.length > 0 && (
        <div style={{ flexBasis: "100%", overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Variant", "SKU", "Barcode", "Price", ""].map((h) => (
                  <th key={h} style={{ ...cell, fontWeight: 600, padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.id} style={v.isThis ? { background: deletedNow ? "#fde7e9" : "#e3f1df" } : undefined}>
                  <td style={{ ...cell, padding: "6px 8px" }}>
                    {v.title && v.title !== "Default Title" ? v.title : <span style={muted}>—</span>}
                    {v.isThis && <strong style={{ marginLeft: "6px", fontSize: "12px" }}>{deletedNow ? "← this one was deleted" : "← this one was added"}</strong>}
                    {!v.isThis && v.deletedAt && <span style={{ ...muted, fontSize: "12px" }}> (deleted {fmtTime(v.deletedAt)})</span>}
                  </td>
                  <td style={{ ...cell, padding: "6px 8px" }}>{v.sku ?? "—"}</td>
                  <td style={{ ...cell, padding: "6px 8px" }}>{v.barcode ?? "—"}</td>
                  <td style={{ ...cell, padding: "6px 8px" }}>{v.price ? `$${v.price}` : "—"}</td>
                  <td style={{ ...cell, padding: "6px 8px", textAlign: "right" }}>
                    {onItem && v.inventoryItemId && (
                      <button type="button" style={linkBtn} onClick={() => onItem(v.inventoryItemId)}>
                        Stock history
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Product or variant created / deleted
function CatalogTag({ catalog }) {
  const deleted = catalog.action === "deleted";
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        borderRadius: "8px",
        fontSize: "12px",
        fontWeight: 600,
        whiteSpace: "nowrap",
        background: deleted ? "#fde7e9" : "#e3f1df",
        color: deleted ? "#8e1f0b" : "#1a5e20",
      }}
    >
      {deleted ? "Deleted" : "Created"}
    </span>
    {catalog.recreated && (
      <span
        title="A product was deleted and another created at the same moment"
        style={{ display: "inline-block", marginTop: "4px", padding: "1px 8px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap", background: "#fff1d6", color: "#7a4f01" }}
      >
        Re-created
      </span>
    )}
    </span>
  );
}

const undoTag = {
  display: "inline-block",
  marginRight: "6px",
  padding: "0 6px",
  borderRadius: "8px",
  background: "#e0f0ff",
  fontSize: "12px",
};

const confirmBox = {
  padding: "12px 14px",
  margin: "4px 0 6px",
  background: "#f7f7f7",
  border: "1px solid #e3e3e3",
  borderRadius: "8px",
};

// One undo at a time per table: Undo → check what it will do → confirm
function useUndo(onUndone) {
  const fetcher = useFetcher();
  const [target, setTarget] = useState(null); // the change being undone
  const d = fetcher.data?.key === target?.key ? fetcher.data : null;
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (d?.intent === "undo" && d.ok) {
      const done = target;
      setTarget(null);
      onUndone?.({ change: done, after: d.after });
    }
  }, [fetcher.data]);

  return {
    target,
    data: d,
    busy,
    start: (c) => {
      setTarget(c);
      fetcher.submit({ intent: "undoPreview", key: c.key }, { method: "post" });
    },
    confirm: () => fetcher.submit({ intent: "undo", key: target.key }, { method: "post" }),
    cancel: () => setTarget(null),
  };
}

function UndoPanel({ undo, colSpan }) {
  const { data, busy } = undo;
  const preview = data?.intent === "undoPreview" ? data.preview : null;
  let body;
  if (data?.error) {
    body = (
      <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: "#b42318" }}>Couldn't undo: {data.error}</span>
        <s-button variant="tertiary" onClick={undo.cancel}>
          Close
        </s-button>
      </div>
    );
  } else if (!preview) {
    body = <span style={muted}>Checking current stock…</span>;
  } else {
    const where = undo.target.location ? ` at ${undo.target.location}` : "";
    body = (
      <>
        <div style={{ fontWeight: 600, marginBottom: "4px" }}>Undo this change?</div>
        <div>
          This makes a {signed(preview.delta)} adjustment. Available stock{where} goes from {preview.current} to{" "}
          {preview.after}.
        </div>
        {preview.after < 0 && (
          <div style={{ color: "#b42318", marginTop: "4px" }}>Stock will be below zero afterwards.</div>
        )}
        <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
          <s-button variant="primary" tone="critical" onClick={undo.confirm} {...(busy ? { loading: true } : {})}>
            Undo change
          </s-button>
          <s-button onClick={undo.cancel} {...(busy ? { disabled: true } : {})}>
            Cancel
          </s-button>
        </div>
      </>
    );
  }
  return (
    <tr>
      <td style={{ ...cell, paddingTop: 0 }} colSpan={colSpan}>
        <div style={confirmBox}>{body}</div>
      </td>
    </tr>
  );
}

// Placeholder rows shown at the bottom while the next page loads
function SkeletonRows({ columns, count = 3 }) {
  const widths = ["70%", "85%", "55%", "60%", "75%", "50%", "30%"];
  return Array.from({ length: count }, (_, r) => (
    <tr key={`skel-${r}`} className="oh-skel-row" style={{ animationDelay: `${r * 60}ms` }} aria-hidden="true">
      {Array.from({ length: columns }, (_, c) => (
        <td key={c} style={cell}>
          <span className="oh-skel" style={{ width: widths[(c + r) % widths.length], animationDelay: `${(c + r) * 90}ms` }} />
        </td>
      ))}
    </tr>
  ));
}

// maxHeight + onNearEnd: a fixed-height box that loads more as you scroll
function ChangesTable({
  changes,
  showItem = true,
  highlight = null,
  onItem,
  canUndo = false,
  onUndone,
  maxHeight,
  onNearEnd,
  loadingMore = false,
  dim = false,
}) {
  const undo = useUndo(onUndone);
  const scrollRef = useRef(null);
  const [openCatalog, setOpenCatalog] = useState(null);

  // If the rows don't fill the box yet there's nothing to scroll, so keep loading
  useEffect(() => {
    const el = scrollRef.current;
    if (el && onNearEnd && !loadingMore && el.scrollHeight <= el.clientHeight + 40) onNearEnd();
  }, [changes.length, loadingMore]);

  if (!changes.length) return <s-paragraph>No changes yet.</s-paragraph>;
  const headers = ["When", ...(showItem ? ["Item"] : []), "Change", "Who", "Why", "Location", ...(canUndo ? [""] : [])];
  const handleScroll = onNearEnd
    ? (e) => {
        const el = e.currentTarget;
        if (!loadingMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 160) onNearEnd();
      }
    : undefined;
  return (
    <Table headers={headers} maxHeight={maxHeight} onScroll={handleScroll} scrollRef={scrollRef} dim={dim}>
      {changes.map((c, i) => (
        <Fragment key={c.key}>
        <tr
          className="oh-rise"
          style={{
            animationDelay: `${(i % 10) * 35}ms`,
            ...(sameWho(c, highlight) ? { background: "#fff4d6" } : {}),
          }}
        >
          <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtTime(c.at)}</td>
          {showItem && (
            <td style={cell}>
              {c.catalog ? (
                <button
                  type="button"
                  style={linkBtn}
                  aria-expanded={openCatalog === c.key}
                  onClick={() => setOpenCatalog(openCatalog === c.key ? null : c.key)}
                >
                  {c.item}
                </button>
              ) : onItem && c.inventoryItemId ? (
                <button type="button" style={linkBtn} onClick={() => onItem(c.inventoryItemId)}>
                  {c.item}
                </button>
              ) : (
                c.item
              )}
              {c.sku && <div style={{ ...muted, fontSize: "12px" }}>{c.sku}</div>}
              {c.note && <div style={{ ...muted, fontSize: "12px" }}>Shopify: “{c.note}”</div>}
            </td>
          )}
          <td style={cell}>
            {c.catalog ? <CatalogTag catalog={c.catalog} /> : <ChangeParts parts={c.parts} />}
          </td>
          {c.pending ? (
            <td style={{ ...cell, ...muted, fontStyle: "italic" }} colSpan={2}>
              Details on the way…
            </td>
          ) : (
            <>
              <td style={cell}>{c.who}</td>
              <td style={cell}>
                {c.isUndo && <span style={undoTag}>Undo</span>}
                {c.reasonLabel ?? "—"}
                {c.undoneBy && (
                  <div style={{ ...muted, fontSize: "12px" }}>
                    Undone by {c.undoneBy.name} on {fmtTime(c.undoneBy.at)}
                  </div>
                )}
                {c.order && (
                  <>
                    {" · "}
                    <a href={`shopify:admin/orders/${c.order.id}`} target="_top" style={{ color: "#005bd3" }}>
                      View order
                    </a>
                  </>
                )}
              </td>
            </>
          )}
          <td style={cell}>{c.location ?? "—"}</td>
          {canUndo && (
            <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>
              {c.undoable && !c.pending && undo.target?.key !== c.key && (
                <s-button
                  variant="tertiary"
                  onClick={() => undo.start(c)}
                  accessibilityLabel={`Undo this change to ${c.item}`}
                  {...(undo.busy ? { disabled: true } : {})}
                >
                  Undo
                </s-button>
              )}
            </td>
          )}
        </tr>
        {undo.target?.key === c.key && <UndoPanel undo={undo} colSpan={headers.length} />}
        {c.catalog && openCatalog === c.key && (
          <tr>
            <td colSpan={headers.length} style={{ ...cell, background: "#fafafa" }}>
              <CatalogPanel id={c.catalogId} onItem={onItem} onClose={() => setOpenCatalog(null)} />
            </td>
          </tr>
        )}
        </Fragment>
      ))}
      {loadingMore && <SkeletonRows columns={headers.length} />}
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

function UndoLog({ undos, onItem }) {
  const fetcher = useFetcher();
  const [list, setList] = useState(undos);
  useEffect(() => {
    setList((prev) => mergeFresh(prev, undos, "undos", "id"));
  }, [undos]);
  useEffect(() => {
    const d = fetcher.data;
    if (d?.intent === "undos")
      setList((l) => {
        const shown = new Set(l.undos.map((u) => u.id));
        return { ...l, undos: [...l.undos, ...d.undos.filter((u) => !shown.has(u.id))], hasMore: d.hasMore, page: d.page };
      });
  }, [fetcher.data]);

  const loadingMore = fetcher.state !== "idle";
  const loadMore = () =>
    list.hasMore && !loadingMore && fetcher.submit({ intent: "undos", page: String((list.page ?? 1) + 1) }, { method: "post" });
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight <= el.clientHeight + 40) loadMore();
  }, [list.undos.length, loadingMore]);
  const onScroll = (e) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) loadMore();
  };

  return (
    <div style={{ marginTop: "14px" }}>
      <div style={{ fontWeight: 600, marginBottom: "6px" }}>Undos</div>
      {list.undos.length === 0 ? (
        <s-paragraph>
          <span style={muted}>No undos yet.</span>
        </s-paragraph>
      ) : (
        <>
          <Table
            headers={["When", "Item", "Undo", "By", "Original change", "Result"]}
            maxHeight="320px"
            onScroll={onScroll}
            scrollRef={scrollRef}
          >
            {list.undos.map((u, i) => (
              <tr key={u.id} className="oh-rise" style={{ animationDelay: `${(i % 10) * 35}ms` }}>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtTime(u.at)}</td>
                <td style={cell}>
                  {onItem ? (
                    <button type="button" style={linkBtn} onClick={() => onItem(u.inventoryItemId)}>
                      {u.item}
                    </button>
                  ) : (
                    u.item
                  )}
                  {u.sku && <div style={{ ...muted, fontSize: "12px" }}>{u.sku}</div>}
                </td>
                <td style={cell}>
                  <strong style={{ color: changeColor(u.delta) }}>{signed(u.delta)}</strong> available
                  {u.before != null && (
                    <div style={{ ...muted, fontSize: "12px" }}>
                      {u.before} → {u.after}
                    </div>
                  )}
                </td>
                <td style={cell}>{u.by}</td>
                <td style={cell}>
                  {[u.original.who, u.original.reason].filter(Boolean).join(" · ") || "—"}
                  {u.original.at && <div style={{ ...muted, fontSize: "12px" }}>{fmtTime(u.original.at)}</div>}
                </td>
                <td style={cell}>
                  {u.status === "applied" ? (
                    <span style={{ color: "#1a5e20" }}>Done</span>
                  ) : (
                    <>
                      <span style={{ color: "#b42318" }}>Failed</span>
                      {u.error && <div style={{ ...muted, fontSize: "12px" }}>{u.error}</div>}
                    </>
                  )}
                </td>
              </tr>
            ))}
            {loadingMore && <SkeletonRows columns={6} />}
          </Table>
        </>
      )}
    </div>
  );
}

function SyncStatus({ status, isAdmin, undos, onItem }) {
  const control = useFetcher();
  const pct = status.expectedRows ? Math.min(100, Math.round((status.backfillRows / status.expectedRows) * 100)) : 0;
  const rowsLeft = Math.max(0, (status.expectedRows ?? 0) - status.backfillRows);
  const minutesLeft = Math.ceil(rowsLeft / 5000);
  const month = status.backfillMonth
    ? new Date(`${status.backfillMonth}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : null;

  const sizeLine =
    status.dbSizeMb != null
      ? `Database size: ${status.dbSizeMb.toLocaleString()} MB${status.dbMaxMb ? ` of ${status.dbMaxMb.toLocaleString()} MB` : ""}`
      : null;
  const busy = control.state !== "idle";

  return (
    <s-section heading="History">
      {status.paused && (
        <div style={{ marginBottom: "10px" }}>
          <s-banner tone="warning" heading="Loading history is paused">
            <s-paragraph>{status.pausedReason ?? "Paused."} New stock changes are still recorded.</s-paragraph>
            {isAdmin && !/INVENTORY_SYNC_PAUSED/.test(status.pausedReason ?? "") && (
              <div style={{ marginTop: "8px" }}>
                <s-button onClick={() => control.submit({ intent: "resume" }, { method: "post" })} {...(busy ? { loading: true } : {})}>
                  Resume
                </s-button>
              </div>
            )}
          </s-banner>
        </div>
      )}
      {status.lastError && !status.paused && (
        <div style={{ marginBottom: "10px" }}>
          <s-banner tone="warning" heading="The last history read had a problem">
            <s-paragraph>{status.lastError}. It will try again in a few minutes.</s-paragraph>
          </s-banner>
        </div>
      )}

      {!status.backfillDone ? (
        <>
          <s-paragraph>
            <strong>Loading past history{month ? `: ${month}` : "…"}</strong>
            {status.expectedRows ? (
              <span style={muted}>
                {" "}
                · {pct}% ({status.backfillRows.toLocaleString()} of {status.expectedRows.toLocaleString()}) · about{" "}
                {minutesLeft < 60 ? `${minutesLeft} min` : `${Math.round(minutesLeft / 60)} hr`} left
              </span>
            ) : (
              <span style={muted}> · working out how much history there is</span>
            )}
          </s-paragraph>
          <div style={{ height: "8px", background: "#ebebeb", borderRadius: "999px", overflow: "hidden", margin: "8px 0" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "#f7a8b8", transition: "width .4s ease" }} />
          </div>
          <s-paragraph>
            <span style={muted}>
              Shopify allows about one history read per minute, so the full history loads gradually in the background.
              New changes are recorded as they happen in the meantime.
            </span>
          </s-paragraph>
        </>
      ) : (
        <s-paragraph>
          <strong>All history loaded</strong>
          <span style={muted}> · {status.stored.toLocaleString()} changes</span>
        </s-paragraph>
      )}

      <s-paragraph>
        <span style={muted}>
          {status.lastLiveSyncAt ? `Up to date as of ${fmtTime(status.lastLiveSyncAt)}` : "Waiting for the first new change"}
          {status.pending > 0 && ` · ${status.pending} recent change${status.pending === 1 ? "" : "s"} waiting for details`}
          {sizeLine && ` · ${sizeLine}`}
        </span>
      </s-paragraph>
      {isAdmin && !status.paused && !status.backfillDone && (
        <div style={{ marginTop: "8px" }}>
          <s-button variant="tertiary" onClick={() => control.submit({ intent: "pause" }, { method: "post" })} {...(busy ? { loading: true } : {})}>
            Pause loading history
          </s-button>
        </div>
      )}
      {undos && <UndoLog undos={undos} onItem={onItem} />}
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InventoryHistory() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Inventory history" /> : <InventoryHistoryPage />;
}

function InventoryHistoryPage() {
  const { status, recent, kind, kindOptions, who, undos, since, sinceOptions, isAdmin, canUndo } = useLoaderData();
  const setParam = (name, value, fallback) =>
    setSearchParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === fallback) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { preventScrollReset: true },
    );
  const [notice, setNotice] = useState(null);
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const [, setSearchParams] = useSearchParams();

  // Recent changes with "Show more"
  const recentFetcher = useFetcher();
  const [recentList, setRecentList] = useState(recent);
  useEffect(() => {
    setRecentList((prev) => mergeFresh(prev, recent, "changes", "key"));
  }, [recent]);
  useEffect(() => {
    const d = recentFetcher.data;
    if (d?.intent === "recent" && d.kind === recentList.kind)
      setRecentList((r) => {
        // New changes may have pushed rows onto the next page; skip ones already shown
        const shown = new Set(r.changes.map((c) => c.key));
        return { ...r, changes: [...r.changes, ...d.changes.filter((c) => !shown.has(c.key))], hasMore: d.hasMore, page: d.page };
      });
  }, [recentFetcher.data]);

  // Drill-down trail: who → items → item history
  const drillFetcher = useFetcher();
  const [trail, setTrail] = useState([]);
  const drillRef = useRef(null);
  useEffect(() => {
    setTrail([]);
  }, [since]);
  useEffect(() => {
    const d = drillFetcher.data;
    if (!d) return;
    if (d.intent === "whoItems") setTrail([{ type: "items", ...d }]);
    if (d.intent === "itemChanges") {
      setTrail((t) => {
        const last = t[t.length - 1];
        if (d.page > 1 && last?.type === "item" && last.inventoryItemId === d.inventoryItemId) {
          return [...t.slice(0, -1), { ...last, changes: [...last.changes, ...d.changes], hasMore: d.hasMore, page: d.page }];
        }
        const base = t.length && t[t.length - 1].type === "items" ? t : t.filter((x) => x.type === "items");
        return [...base, { type: "item", ...d }];
      });
    }
    if (d.page === 1 || d.intent === "whoItems") drillRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [drillFetcher.data]);

  // Keep the progress fresh while history is loading
  useEffect(() => {
    if (status.backfillDone && status.pending === 0) return;
    const t = setInterval(() => revalidator.state === "idle" && revalidator.revalidate(), 20000);
    return () => clearInterval(t);
  }, [status.backfillDone, status.pending, revalidator]);

  const openWho = (w) =>
    drillFetcher.submit({ intent: "whoItems", whoApp: w.app ?? "", whoStaff: w.staff ?? "", since }, { method: "post" });
  const openItem = (inventoryItemId, whoFilter, page = 1) =>
    drillFetcher.submit(
      {
        intent: "itemChanges",
        inventoryItemId,
        page: String(page),
        ...(whoFilter ? { whoApp: whoFilter.app ?? "", whoStaff: whoFilter.staff ?? "" } : {}),
      },
      { method: "post" },
    );

  const current = trail[trail.length - 1];

  // After an undo: say what happened and reload the lists so both the undo and
  // the "Undone by" note show
  const onUndone = ({ change, after }) => {
    const where = change.location ? ` at ${change.location}` : "";
    setNotice(`Undone. Available stock for ${change.item}${where} is now ${after}.`);
    revalidator.revalidate();
    if (current?.type === "item") openItem(current.inventoryItemId, current.who, 1);
  };
  const drillLoading = drillFetcher.state !== "idle";
  const crumbs = [
    { label: "Everyone", onClick: () => setTrail([]) },
    ...trail.map((t, i) => ({
      label: t.type === "items" ? (t.who.staff && t.who.app ? `${t.who.staff} · ${t.who.app}` : t.who.staff ?? t.who.app) : t.name ?? "Item",
      onClick: () => setTrail(trail.slice(0, i + 1)),
    })),
  ];

  return (
    <s-page heading="Inventory history">
      <style>{MOTION_CSS}</style>
      <SyncStatus status={status} isAdmin={isAdmin} undos={undos} onItem={(id) => openItem(id, null)} />

      {notice && (
        <div style={{ marginBottom: "12px" }}>
          <s-banner tone="success" dismissible onDismiss={() => setNotice(null)}>
            <s-paragraph>{notice}</s-paragraph>
          </s-banner>
        </div>
      )}

      <s-section heading="Recent changes">
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
          <label htmlFor="show" style={muted}>
            Show
          </label>
          <select id="show" value={kind} onChange={(e) => setParam("show", e.target.value, "all")} style={selectStyle}>
            {kindOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {navigation.state === "loading" && <span style={muted}>Loading…</span>}
        </div>
        {recentList.changes.length === 0 && kind !== "all" ? (
          <s-paragraph>No changes of this kind yet.</s-paragraph>
        ) : (
        <ChangesTable
          changes={recentList.changes}
          onItem={(id) => openItem(id, null)}
          canUndo={canUndo}
          onUndone={onUndone}
          maxHeight="560px"
          loadingMore={recentFetcher.state !== "idle"}
          dim={navigation.state === "loading"}
          onNearEnd={
            recentList.hasMore
              ? () =>
                  recentFetcher.state === "idle" &&
                  recentFetcher.submit(
                    { intent: "recent", show: kind, page: String((recentList.page ?? 1) + 1) },
                    { method: "post" },
                  )
              : undefined
          }
        />
        )}
      </s-section>

      <div ref={drillRef} />
      <s-section heading="By app and staff">
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
          <label htmlFor="since" style={muted}>
            Period
          </label>
          <select
            id="since"
            value={since}
            onChange={(e) => setParam("since", e.target.value, "30d")}
            style={selectStyle}
          >
            {sinceOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {drillLoading && <span style={muted}>Loading…</span>}
        </div>

        {trail.length > 0 && (
          <div style={{ marginBottom: "10px", fontSize: "13px" }}>
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <span style={muted}> › </span>}
                {i < crumbs.length - 1 ? (
                  <button type="button" style={linkBtn} onClick={c.onClick}>
                    {c.label}
                  </button>
                ) : (
                  <strong>{c.label}</strong>
                )}
              </span>
            ))}
          </div>
        )}

        {!current &&
          (who.length === 0 ? (
            <s-paragraph>No changes in this period yet.</s-paragraph>
          ) : (
            <>
              <s-paragraph>
                <span style={muted}>Changes to available stock. Click a name to see the items it changed.</span>
              </s-paragraph>
              <Table headers={["Who", "Changes", "Net change"]}>
                {who.map((w) => (
                  <tr key={`${w.app}|${w.staff}`}>
                    <td style={cell}>
                      <button type="button" style={linkBtn} onClick={() => openWho(w)}>
                        {w.who}
                      </button>
                    </td>
                    <td style={cell}>{w.changes.toLocaleString()}</td>
                    <td style={{ ...cell, color: changeColor(w.net), fontWeight: 600 }}>{signed(w.net)}</td>
                  </tr>
                ))}
              </Table>
            </>
          ))}

        {current?.type === "items" && (
          <>
            <s-paragraph>
              <span style={muted}>
                {current.items.length.toLocaleString()} item{current.items.length === 1 ? "" : "s"} changed. Click an item
                to see its full history.
              </span>
            </s-paragraph>
            <div style={{ maxHeight: "520px", ...box }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
                <thead>
                  <tr>
                    {["Item", "SKU", "Changes", "Net change", "Last changed"].map((h) => (
                      <th key={h} style={head}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((it, i) => (
                    <tr key={it.inventoryItemId} className="oh-rise" style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}>
                      <td style={cell}>
                        <button type="button" style={linkBtn} onClick={() => openItem(it.inventoryItemId, current.who)}>
                          {it.item}
                        </button>
                      </td>
                      <td style={cell}>{it.sku ?? "—"}</td>
                      <td style={cell}>{it.changes.toLocaleString()}</td>
                      <td style={{ ...cell, color: changeColor(it.net), fontWeight: 600 }}>{signed(it.net)}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{it.lastAt ? fmtTime(it.lastAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {current?.type === "item" && (
          <>
            <s-paragraph>
              <span style={muted}>
                Every change to this item
                {current.who ? (
                  <>
                    . Changes by{" "}
                    <strong>
                      {current.who.staff && current.who.app
                        ? `${current.who.staff} · ${current.who.app}`
                        : current.who.staff ?? current.who.app}
                    </strong>{" "}
                    are highlighted.
                  </>
                ) : (
                  "."
                )}
              </span>
            </s-paragraph>
            <ChangesTable
              changes={current.changes}
              showItem={false}
              highlight={current.who}
              canUndo={canUndo}
              onUndone={onUndone}
              maxHeight="560px"
              loadingMore={drillLoading && Number(drillFetcher.formData?.get("page") ?? 1) > 1}
              onNearEnd={
                current.hasMore
                  ? () =>
                      drillFetcher.state === "idle" &&
                      openItem(current.inventoryItemId, current.who, (current.page ?? 1) + 1)
                  : undefined
              }
            />
          </>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
