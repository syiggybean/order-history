import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { SaleError, deleteSale, findTargets, listSales, saveSale, syncSale } from "../sales.server";
import db from "../db.server";

// Sales: scheduled sales Shopify runs from MonkeyBean. % or $ off items
// (each product can have its own amount), an order discount, or early access;
// for everyone and/or chosen loyalty tiers, each with its own amount (members
// are recognised at checkout when signed in). The list is a table: a row opens
// in place to edit it.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "sales", "view");
  if (noAccess) return { noAccess: true };
  return { ...(await listSales(session.shop)), canManage: can(user, "sales", "manage") };
};

const parse = (v, fallback) => {
  try {
    return JSON.parse(String(v ?? ""));
  } catch {
    return fallback;
  }
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "sales", "view")) return denied("sales", "view");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const shop = session.shop;
  try {
    if (!can(user, "sales", "manage")) return denied("sales", "manage");
    if (intent === "find") return { intent, ...(await findTargets(admin, form.get("q"))) };
    if (intent === "save") {
      const sale = await saveSale(
        shop,
        admin,
        {
          id: form.get("id") || null,
          name: form.get("name"),
          kind: form.get("kind"),
          audience: form.get("audience"),
          tiers: parse(form.get("tiers"), []),
          rates: parse(form.get("rates"), []),
          valueType: form.get("valueType"),
          scope: form.get("scope"),
          collections: parse(form.get("collections"), []),
          products: parse(form.get("products"), []),
          minSubtotal: form.get("minSubtotal"),
          combine: form.get("combine") === "true",
          starts: form.get("starts"),
          ends: form.get("ends"),
          active: form.get("active") !== "false",
          lockBefore: form.get("lockBefore") !== "false",
          tabEnabled: form.get("tabEnabled") === "true",
          tabLabel: form.get("tabLabel"),
          tabUrl: form.get("tabUrl"),
        },
        user,
      );
      return { intent, ok: true, sale };
    }
    if (intent === "retry") {
      const s = await db.sale.findFirst({ where: { shop, id: Number(form.get("id")) } });
      if (!s) return { intent, error: "That sale isn't there anymore." };
      await syncSale(shop, admin, s);
      return { intent, ok: true };
    }
    if (intent === "delete") return (await deleteSale(shop, admin, form.get("id")), { intent, ok: true, deleted: Number(form.get("id")) });
  } catch (e) {
    if (!(e instanceof SaleError)) console.error(`[sales] ${intent}:`, e);
    return { intent, error: e instanceof SaleError ? e.message : errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

export const headers = (headersArgs) => boundary.headers(headersArgs);


// ---------------------------------------------------------------------------

const input = { padding: "7px 10px", border: "1px solid #c9c9c9", borderRadius: "8px", font: "inherit", fontSize: "14px", boxSizing: "border-box", background: "#fff" };
const small = { fontSize: "12px", color: "#616161" };
const pill = (bg, fg) => ({ background: bg, color: fg, borderRadius: "999px", padding: "2px 9px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });
const label = { fontWeight: 650, fontSize: "13px", margin: 0 };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" };
const field = { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" };
const th = { textAlign: "left", fontSize: "12px", fontWeight: 600, color: "#616161", padding: "8px 10px", borderBottom: "1px solid #e3e3e3", whiteSpace: "nowrap", background: "#f7f7f7" };
const td = { padding: "10px", borderBottom: "1px solid #ebebeb", fontSize: "13px", verticalAlign: "middle" };
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
const chip = (on) => ({
  font: "inherit",
  fontSize: "13px",
  padding: "5px 12px",
  borderRadius: "999px",
  border: `1px solid ${on ? "#1a1a1a" : "#c9c9c9"}`,
  background: on ? "#1a1a1a" : "#fff",
  color: on ? "#fff" : "#303030",
  cursor: "pointer",
});

const STATUS = {
  live: ["Live", "#cdfee1", "#0c5132"],
  scheduled: ["Scheduled", "#e0f0ff", "#00527c"],
  ended: ["Ended", "#ebebeb", "#4a4a4a"],
  off: ["Off", "#ebebeb", "#4a4a4a"],
};

const money = (n) => `$${Number(n).toFixed(2)}`;
const short = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;
const amount = (type, v) => (type === "fixed" ? short(v) : `${v}%`);
const salePrice = (price, type, v) => Math.max(0, type === "fixed" ? price - v : price * (1 - v / 100));

function Photo({ src, size = 40, alt = "" }) {
  return src ? (
    <img src={src} alt={alt} width={size} height={size} style={{ width: size, height: size, objectFit: "cover", borderRadius: "6px", border: "1px solid #e3e3e3", flexShrink: 0 }} />
  ) : (
    <span aria-hidden="true" style={{ width: size, height: size, borderRadius: "6px", background: "#f1f1f1", border: "1px solid #e3e3e3", flexShrink: 0, display: "inline-block" }} />
  );
}

// "Everyone 10% · Silver 15% · Gold 20–25%"
function whoGetsWhat(s, tiers) {
  if (s.kind === "earlyAccess") return `${s.tierNames.join(", ")} first`;
  const name = (col) => (col === "everyone" ? "Everyone" : tiers.find((t) => t.id === col)?.name ?? "Tier");
  return s.rates
    .map((r) => {
      const vals = s.scope === "products" ? s.products.map((p) => p.values?.[r.col] ?? r.value).filter((v) => v > 0) : [r.value];
      if (!vals.length) return null;
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      return `${name(r.col)} ${lo === hi ? amount(s.valueType, lo) : `${amount(s.valueType, lo)}–${amount(s.valueType, hi)}`}`;
    })
    .filter(Boolean)
    .join(" · ");
}
function onWhat(s) {
  if (s.kind === "order") return s.minSubtotal ? `Orders over ${short(s.minSubtotal)}` : "Whole order";
  if (s.scope === "all") return "Everything";
  if (s.scope === "collections") return s.collections.map((c) => c.title).join(", ");
  return `${s.products.length} product${s.products.length === 1 ? "" : "s"}`;
}

export default function Sales() {
  const data = useLoaderData();
  const [openId, setOpenId] = useState(null); // a sale open for editing, or "new"
  const [show, setShow] = useState("current");
  if (data.noAccess) return <NoAccess />;
  const { sales, tiers, canManage } = data;
  const shown = sales.filter((s) => (show === "current" ? s.status === "live" || s.status === "scheduled" : show === "past" ? s.status === "ended" || s.status === "off" : true));
  const live = sales.filter((s) => s.status === "live" || s.status === "scheduled").length;
  const toggle = (id) => setOpenId((o) => (o === id ? null : id));
  const cols = 6;

  return (
    <s-page heading="Sales" inlineSize="large">
      <s-section>
        <s-paragraph>
          Sales start and stop on their own at the times you set (store time). Give everyone an amount off, and/or give each loyalty tier its own (say
          Silver 15%, Gold 25%); on chosen products, each product can have its own amount. Members need to be signed in at checkout. With the “Sale
          price” block in the theme, product pages show the original price crossed out and a countdown.
        </s-paragraph>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px", alignItems: "center" }}>
          {[
            ["current", `Live and scheduled (${live})`],
            ["past", "Ended and off"],
            ["all", "All"],
          ].map(([id, text]) => (
            <button key={id} type="button" onClick={() => setShow(id)} style={chip(show === id)}>
              {text}
            </button>
          ))}
          {canManage && (
            <span style={{ marginLeft: "auto" }}>
              <s-button variant="primary" onClick={() => setOpenId(openId === "new" ? null : "new")}>
                New sale
              </s-button>
            </span>
          )}
        </div>
      </s-section>

      <s-section padding="none">
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "760px" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: "28px" }} aria-label="Open" />
                <th style={th}>Sale</th>
                <th style={th}>Who gets what</th>
                <th style={th}>On</th>
                <th style={th}>When</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {openId === "new" && (
                <tr>
                  <td colSpan={cols} style={{ padding: 0, borderBottom: "1px solid #ebebeb", background: "#fbfbfb" }}>
                    <Editor key="new" s={{}} tiers={tiers} canManage={canManage} onDone={() => setOpenId(null)} />
                  </td>
                </tr>
              )}
              {shown.length === 0 && openId !== "new" && (
                <tr>
                  <td colSpan={cols} style={{ ...td, color: "#616161" }}>
                    {show === "current" ? (canManage ? "Nothing live or coming up. Start one with New sale." : "Nothing live or coming up.") : "None."}
                  </td>
                </tr>
              )}
              {shown.map((s) => {
                const [text, bg, fg] = STATUS[s.status];
                const open = openId === s.id;
                const thumbs = s.products.filter((p) => p.image).slice(0, 4);
                return [
                  <tr
                    key={s.id}
                    onClick={() => toggle(s.id)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(s.id))}
                    tabIndex={0}
                    aria-expanded={open}
                    style={{ cursor: "pointer", background: open ? "#f4f8ff" : undefined }}
                  >
                    <td style={{ ...td, color: "#616161", textAlign: "center" }}>
                      <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
                    </td>
                    <td style={td}>
                      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        {thumbs.length > 0 && (
                          <span style={{ display: "flex" }}>
                            {thumbs.map((p, i) => (
                              <span key={p.id} style={{ marginLeft: i ? "-10px" : 0, borderRadius: "7px", background: "#fff" }}>
                                <Photo src={p.image} size={30} />
                              </span>
                            ))}
                          </span>
                        )}
                        <span>
                          <strong>{s.name}</strong>
                          <span style={{ ...small, display: "block" }}>{s.kindLabel}</span>
                        </span>
                      </div>
                    </td>
                    <td style={td}>{whoGetsWhat(s, tiers)}</td>
                    <td style={td}>{onWhat(s)}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {s.kind === "earlyAccess" ? (
                        <>
                          Members {when(s.startsAt)}
                          <span style={{ ...small, display: "block" }}>Everyone {when(s.endsAt)}</span>
                        </>
                      ) : (
                        <>
                          {when(s.startsAt)}
                          <span style={{ ...small, display: "block" }}>to {when(s.endsAt)}</span>
                        </>
                      )}
                    </td>
                    <td style={td}>
                      <span style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                        <span style={pill(bg, fg)}>{text}</span>
                        {s.tabEnabled && <span style={pill("#fff1e3", "#8a4b00")}>Tab</span>}
                        {s.syncError && <span style={pill("#fee9e8", "#8e1f0b")}>Not in Shopify</span>}
                      </span>
                    </td>
                  </tr>,
                  open && (
                    <tr key={`${s.id}-edit`}>
                      <td colSpan={cols} style={{ padding: 0, borderBottom: "1px solid #d4d4d4", background: "#fbfbfb" }}>
                        <Editor s={s} tiers={tiers} canManage={canManage} onDone={() => setOpenId(null)} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      </s-section>

      <s-section heading="Set up once">
        <s-unordered-list>
          <s-list-item>Product page prices: add the “Sale price” block to the product page in the theme editor, near the price.</s-list-item>
          <s-list-item>Front-page tab: turn on “Member sale tab” in the theme editor under App embeds.</s-list-item>
          <s-list-item>Members need to be signed in for members' prices to apply.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

// Search for products or collections to add: an empty last row that grows the table
function AddRow({ type, have, onAdd, disabled, colSpan }) {
  const find = useFetcher();
  const [q, setQ] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (disabled) return null;
  const results = q.trim().length >= 2 && find.data?.intent === "find" ? (type === "products" ? find.data.products : find.data.collections) ?? [] : [];
  return (
    <tr>
      <td colSpan={colSpan} style={{ ...td, borderBottom: 0 }}>
        <input
          type="search"
          value={q}
          onChange={(e) => {
            const t = e.target.value;
            setQ(t);
            clearTimeout(timer.current);
            if (t.trim().length >= 2) timer.current = setTimeout(() => find.submit({ intent: "find", q: t }, { method: "post" }), 250);
          }}
          placeholder={type === "products" ? "Add a product: type to search" : "Add a collection: type to search"}
          aria-label={type === "products" ? "Add a product" : "Add a collection"}
          style={{ ...input, width: "100%", maxWidth: "420px" }}
        />
        {find.state !== "idle" && <span style={{ ...small, marginLeft: "8px" }}>Searching…</span>}
        {find.data?.error && <span style={{ color: "#b42318", fontSize: "13px", marginLeft: "8px" }}>{find.data.error}</span>}
        {results.length > 0 && (
          <div
            role="listbox"
            style={{ marginTop: "6px", maxWidth: "420px", background: "#fff", border: "1px solid #d4d4d4", borderRadius: "10px", maxHeight: "320px", overflowY: "auto" }}
          >
            {results.map((r) => {
              const added = have.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  role="option"
                  aria-selected={added}
                  disabled={added}
                  onClick={() => {
                    onAdd(r);
                    setQ("");
                  }}
                  style={{ ...linkBtn, color: "#303030", display: "flex", gap: "10px", alignItems: "center", width: "100%", padding: "8px 10px", textAlign: "left", opacity: added ? 0.5 : 1, cursor: added ? "default" : "pointer" }}
                >
                  <Photo src={r.image} size={36} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: "13px" }}>
                    {r.title}
                    {r.price != null && <span style={{ ...small, display: "block" }}>{r.priceVaries ? `From ${money(r.price)}` : money(r.price)}</span>}
                  </span>
                  <span style={{ ...small, fontWeight: 600, color: added ? "#616161" : "#005bd3" }}>{added ? "Added" : "Add"}</span>
                </button>
              );
            })}
          </div>
        )}
      </td>
    </tr>
  );
}

const num = (v) => (v === "" || v == null ? "" : String(v));

function Editor({ s, tiers, canManage, onDone }) {
  const save = useFetcher();
  const remove = useFetcher();
  const retry = useFetcher();
  const isNew = !s.id;
  const dis = !canManage;
  const [name, setName] = useState(s.name ?? "");
  const [kind, setKind] = useState(s.kind ?? "items");
  const [valueType, setValueType] = useState(s.valueType ?? "percentage");
  // Who gets what: { [col]: amount } for the chosen columns, in tier order
  const [rates, setRates] = useState(() => Object.fromEntries((s.rates ?? [{ col: "everyone", value: "" }]).map((r) => [r.col, num(r.value)])));
  const [eaTiers, setEaTiers] = useState(s.kind === "earlyAccess" ? s.tiers : []);
  const [scope, setScope] = useState(s.scope ?? "products");
  const [collections, setCollections] = useState(s.collections ?? []);
  const [products, setProducts] = useState(() => (s.products ?? []).map((p) => ({ ...p, values: Object.fromEntries(Object.entries(p.values ?? {}).map(([k, v]) => [k, num(v)])) })));
  const [minSubtotal, setMinSubtotal] = useState(num(s.minSubtotal));
  const [combine, setCombine] = useState(s.combine ?? false);
  const [starts, setStarts] = useState(s.startsInput ?? "");
  const [ends, setEnds] = useState(s.endsInput ?? "");
  const [active, setActive] = useState(s.active ?? true);
  const [lockBefore, setLockBefore] = useState(s.lockBefore ?? true);
  const [tabEnabled, setTabEnabled] = useState(s.tabEnabled ?? false);
  const [tabLabel, setTabLabel] = useState(s.tabLabel ?? "");
  const [tabUrl, setTabUrl] = useState(s.tabUrl ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const early = kind === "earlyAccess";

  useEffect(() => {
    if (save.data?.intent === "save" && save.data.ok) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.data]);
  useEffect(() => {
    if (remove.data?.deleted) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remove.data]);
  useEffect(() => {
    if (early && scope === "all") setScope("products");
  }, [early]); // eslint-disable-line react-hooks/exhaustive-deps

  const allCols = [{ col: "everyone", name: "Everyone" }, ...tiers.map((t) => ({ col: t.id, name: t.name }))];
  const cols = allCols.filter((c) => c.col in rates);
  const toggleCol = (col) =>
    setRates((r) => {
      const next = { ...r };
      if (col in next) delete next[col];
      else next[col] = "";
      return next;
    });
  const setCell = (pid, col, v) => setProducts((ps) => ps.map((p) => (p.id === pid ? { ...p, values: { ...p.values, [col]: v } } : p)));
  const unit = valueType === "fixed" ? "$" : "%";

  const submit = () =>
    save.submit(
      {
        intent: "save",
        ...(s.id ? { id: String(s.id) } : {}),
        name,
        kind,
        rates: JSON.stringify(cols.map((c) => ({ col: c.col, value: rates[c.col] }))),
        tiers: JSON.stringify(eaTiers),
        valueType,
        scope: kind === "order" ? "all" : scope,
        collections: JSON.stringify(collections),
        products: JSON.stringify(
          products.map((p) => ({ id: p.id, title: p.title, image: p.image, price: p.price, values: Object.fromEntries(Object.entries(p.values).filter(([k, v]) => v !== "" && k in rates)) })),
        ),
        minSubtotal,
        combine: String(combine),
        starts,
        ends,
        active: String(active),
        lockBefore: String(lockBefore),
        tabEnabled: String(tabEnabled),
        tabLabel,
        tabUrl,
      },
      { method: "post" },
    );
  const error = save.data?.error ?? remove.data?.error ?? retry.data?.error;
  const box = { background: "#fff", border: "1px solid #e3e3e3", borderRadius: "10px", padding: "14px", display: "flex", flexDirection: "column", gap: "10px" };
  const showProducts = kind !== "order" && scope === "products";
  const valueCols = early ? [] : cols;

  return (
    <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }} onClick={(e) => e.stopPropagation()}>
      {s.syncError && (
        <div style={{ ...box, background: "#fff4f4", borderColor: "#f5c2c0", flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ color: "#8e1f0b", fontSize: "13px", flex: 1 }}>Shopify didn't take the last change: {s.syncError}</span>
          {canManage && (
            <s-button onClick={() => retry.submit({ intent: "retry", id: String(s.id) }, { method: "post" })} {...(retry.state !== "idle" ? { loading: true } : {})}>
              Try again
            </s-button>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px" }}>
        <div style={box}>
          <label style={field}>
            Name (customers see it at checkout)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring members' sale" style={input} disabled={dis} maxLength={120} />
          </label>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }} role="radiogroup" aria-label="What kind of sale">
            {[
              ["items", "% or $ off items"],
              ["order", "Order discount"],
              ["earlyAccess", "Early access"],
            ].map(([k, text]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} disabled={dis} onClick={() => setKind(k)} style={chip(kind === k)}>
                {text}
              </button>
            ))}
          </div>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={dis} />
            On (runs at the times set)
          </label>
        </div>

        <div style={box}>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <label style={field}>
              {early ? "Members can buy from" : "Starts"} (store time)
              <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} disabled={dis} style={{ ...input, width: "210px" }} />
            </label>
            <label style={field}>
              {early ? "Everyone can buy from" : "Ends"}
              <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} disabled={dis} style={{ ...input, width: "210px" }} />
            </label>
          </div>
          {early ? (
            <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
              <input type="checkbox" checked={lockBefore} onChange={(e) => setLockBefore(e.target.checked)} disabled={dis} style={{ marginTop: "3px" }} />
              <span>
                Nobody can buy them before members can
                <span style={{ ...small, display: "block" }}>Untick if they're already on sale and should stay buyable until members' time.</span>
              </span>
            </label>
          ) : (
            <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
              <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} disabled={dis} />
              Can be used with other discounts (always works with shipping discounts)
            </label>
          )}
        </div>
      </div>

      <div style={box}>
        <p style={label}>{early ? "Which tiers get early access" : "Who gets what"}</p>
        {early ? (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {tiers.length === 0 && <span style={small}>No loyalty tiers yet. Set them up in Loyalty.</span>}
            {tiers.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={eaTiers.includes(t.id)}
                disabled={dis}
                onClick={() => setEaTiers((x) => (x.includes(t.id) ? x.filter((y) => y !== t.id) : [...x, t.id]))}
                style={chip(eaTiers.includes(t.id))}
              >
                {t.name}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <select value={valueType} onChange={(e) => setValueType(e.target.value)} disabled={dis} style={input} aria-label="Percentage or dollar amount">
                <option value="percentage">% off</option>
                <option value="fixed">{kind === "order" ? "$ off the order" : "$ off each item"}</option>
              </select>
              <span style={small}>for</span>
              {allCols.map((c) => (
                <button key={c.col} type="button" aria-pressed={c.col in rates} disabled={dis} onClick={() => toggleCol(c.col)} style={chip(c.col in rates)}>
                  {c.name}
                </button>
              ))}
            </div>
            {cols.length > 0 && (
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                {cols.map((c) => (
                  <label key={c.col} style={field}>
                    {c.col === "everyone" ? "Everyone" : `${c.name} members`}
                    {showProducts && <span style={small}>Default for products below</span>}
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      {unit === "$" && <span>$</span>}
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={rates[c.col]}
                        onChange={(e) => setRates((r) => ({ ...r, [c.col]: e.target.value }))}
                        disabled={dis}
                        style={{ ...input, width: "90px" }}
                        aria-label={`${c.name}: amount off`}
                      />
                      {unit === "%" && <span>%</span>}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <span style={small}>
              A member gets the best amount they qualify for. Members' amounts are kept to signed-in customers in that tier.
              {cols.length > 1 || showProducts ? " Each audience and amount is its own discount in Shopify (Shopify allows 25 automatic discounts at once)." : ""}
            </span>
            {kind === "order" && (
              <label style={field}>
                Only on orders of at least ($, optional)
                <input type="number" min="0.01" step="0.01" value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value)} disabled={dis} style={{ ...input, width: "130px" }} />
              </label>
            )}
          </>
        )}
      </div>

      {kind !== "order" && (
        <div style={{ ...box, padding: 0, overflow: "visible" }}>
          <div style={{ padding: "14px 14px 0", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <p style={{ ...label, marginRight: "6px" }}>{early ? "Which products" : "On what"}</p>
            {[...(early ? [] : [["all", "Everything"]]), ["collections", "Collections"], ["products", "Products"]].map(([k, text]) => (
              <button key={k} type="button" aria-pressed={scope === k} disabled={dis} onClick={() => setScope(k)} style={chip(scope === k)}>
                {text}
              </button>
            ))}
          </div>
          {scope === "all" && <div style={{ padding: "0 14px 14px", ...small }}>Every product in the store.</div>}
          {scope !== "all" && (
            <div style={{ overflowX: "auto", paddingTop: "10px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: "52px" }} aria-label="Photo" />
                    <th style={th}>{scope === "products" ? "Product" : "Collection"}</th>
                    {showProducts &&
                      valueCols.map((c) => (
                        <th key={c.col} style={th}>
                          {c.name} ({unit})
                        </th>
                      ))}
                    <th style={{ ...th, width: "70px" }} aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {(scope === "products" ? products : collections).map((p) => (
                    <tr key={p.id}>
                      <td style={td}>
                        <Photo src={p.image} size={40} alt="" />
                      </td>
                      <td style={td}>
                        {p.title}
                        {p.price != null && <span style={{ ...small, display: "block" }}>{money(p.price)}</span>}
                      </td>
                      {showProducts &&
                        valueCols.map((c) => {
                          const own = p.values?.[c.col] ?? "";
                          const v = Number(own !== "" ? own : rates[c.col] || 0);
                          return (
                            <td key={c.col} style={td}>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={own}
                                placeholder={rates[c.col] !== "" ? String(rates[c.col]) : "0"}
                                onChange={(e) => setCell(p.id, c.col, e.target.value)}
                                disabled={dis}
                                aria-label={`${p.title}: ${c.name} amount off`}
                                style={{ ...input, width: "80px", fontWeight: own !== "" ? 600 : 400 }}
                              />
                              {p.price != null && v > 0 && <span style={{ ...small, display: "block", marginTop: "2px" }}>{money(salePrice(p.price, valueType, v))}</span>}
                            </td>
                          );
                        })}
                      <td style={{ ...td, textAlign: "right" }}>
                        {!dis && (
                          <button
                            type="button"
                            style={{ ...linkBtn, color: "#b42318", fontSize: "13px" }}
                            onClick={() => (scope === "products" ? setProducts((x) => x.filter((y) => y.id !== p.id)) : setCollections((x) => x.filter((y) => y.id !== p.id)))}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  <AddRow
                    key={scope}
                    type={scope}
                    disabled={dis}
                    colSpan={3 + (showProducts ? valueCols.length : 0)}
                    have={new Set((scope === "products" ? products : collections).map((x) => x.id))}
                    onAdd={(r) =>
                      scope === "products"
                        ? setProducts((x) => [...x, { id: r.id, title: r.title, image: r.image, price: r.price, values: {} }])
                        : setCollections((x) => [...x, { id: r.id, title: r.title, image: r.image }])
                    }
                  />
                </tbody>
              </table>
              {showProducts && products.length > 0 && <div style={{ ...small, padding: "0 14px 12px" }}>Leave a box empty to use the default above; type 0 to leave a product out for that audience.</div>}
            </div>
          )}
        </div>
      )}

      <div style={box}>
        <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
          <input type="checkbox" checked={tabEnabled} onChange={(e) => setTabEnabled(e.target.checked)} disabled={dis} />
          Show a tab on the front page while it's on (only to the customers it's for)
        </label>
        {tabEnabled && (
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <label style={field}>
              Tab label
              <input value={tabLabel} onChange={(e) => setTabLabel(e.target.value)} placeholder="Members' sale" maxLength={40} disabled={dis} style={{ ...input, width: "190px" }} />
            </label>
            <label style={{ ...field, flex: "1 1 220px" }}>
              Links to
              <input value={tabUrl} onChange={(e) => setTabUrl(e.target.value)} placeholder="/collections/members-sale" disabled={dis} style={{ ...input, width: "100%" }} />
            </label>
          </div>
        )}
      </div>

      {error && <div style={{ color: "#b42318", fontSize: "13px" }}>{error}</div>}
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        {!isNew && canManage && (
          <span>
            {confirmDelete ? (
              <span style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px", flexWrap: "wrap" }}>
                Delete this sale? It stops straight away. Orders already placed keep their discount.
                <s-button tone="critical" onClick={() => remove.submit({ intent: "delete", id: String(s.id) }, { method: "post" })} {...(remove.state !== "idle" ? { loading: true } : {})}>
                  Delete
                </s-button>
                <s-button variant="tertiary" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </s-button>
              </span>
            ) : (
              <s-button variant="tertiary" tone="critical" onClick={() => setConfirmDelete(true)}>
                Delete sale
              </s-button>
            )}
          </span>
        )}
        <span style={{ ...small, marginLeft: "auto" }}>
          {!isNew && s.createdBy ? `Made by ${s.createdBy}. ` : ""}
          {!isNew && s.syncedAt ? `Sent to Shopify ${when(s.syncedAt)}.` : ""}
        </span>
        <s-button variant="tertiary" onClick={onDone}>
          {canManage ? "Cancel" : "Close"}
        </s-button>
        {canManage && (
          <s-button variant="primary" onClick={submit} {...(save.state !== "idle" ? { loading: true } : {})}>
            {isNew ? "Create sale" : "Save"}
          </s-button>
        )}
      </div>
    </div>
  );
}
