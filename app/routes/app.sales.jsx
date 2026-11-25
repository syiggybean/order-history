import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { Flyout, useFlyoutClose } from "../components/Flyout";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { SaleError, deleteSale, findTargets, listSales, saveSale, syncSale } from "../sales.server";
import db from "../db.server";

// Sales: scheduled sales Shopify runs from MonkeyBean. % or $ off items,
// an order discount, or early access, for everyone or only chosen loyalty
// tiers (members are recognised at checkout when signed in).

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
          valueType: form.get("valueType"),
          value: form.get("value"),
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

const input = { padding: "7px 10px", border: "1px solid #c9c9c9", borderRadius: "8px", font: "inherit", fontSize: "14px", boxSizing: "border-box" };
const small = { fontSize: "12px", color: "#616161" };
const pill = (bg, fg) => ({ background: bg, color: fg, borderRadius: "999px", padding: "2px 9px", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap" });
const section = { padding: "14px 18px", borderBottom: "1px solid #ebebeb", display: "flex", flexDirection: "column", gap: "8px" };
const sectionTitle = { fontWeight: 650, fontSize: "13px", margin: 0 };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" };
const field = { display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" };
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });

const STATUS = {
  live: ["Live", "#cdfee1", "#0c5132"],
  scheduled: ["Scheduled", "#e0f0ff", "#00527c"],
  ended: ["Ended", "#ebebeb", "#4a4a4a"],
  off: ["Off", "#ebebeb", "#4a4a4a"],
};

const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, "")}`;
function describe(s) {
  if (s.kind === "earlyAccess") {
    const what = s.scope === "products" ? `${s.products.length} product${s.products.length === 1 ? "" : "s"}` : s.collections.map((c) => c.title).join(", ");
    return `Early access to ${what}`;
  }
  const off = s.valueType === "fixed" ? `${money(s.value)} off` : `${s.value}% off`;
  if (s.kind === "order") return `${off} the order${s.minSubtotal ? ` over ${money(s.minSubtotal)}` : ""}`;
  const what = s.scope === "all" ? "everything" : s.scope === "products" ? `${s.products.length} product${s.products.length === 1 ? "" : "s"}` : s.collections.map((c) => c.title).join(", ");
  return `${off}${s.valueType === "fixed" ? " each" : ""} · ${what}`;
}

export default function Sales() {
  const data = useLoaderData();
  const [openId, setOpenId] = useState(null); // a sale being edited, or "new"
  const [show, setShow] = useState("current");
  if (data.noAccess) return <NoAccess />;
  const { sales, tiers, canManage } = data;
  const open = openId === "new" ? {} : sales.find((s) => s.id === openId);
  const shown = sales.filter((s) => (show === "current" ? s.status === "live" || s.status === "scheduled" : show === "past" ? s.status === "ended" || s.status === "off" : true));
  const live = sales.filter((s) => s.status === "live").length;
  const soon = sales.filter((s) => s.status === "scheduled").length;

  return (
    <s-page heading="Sales" inlineSize="large">
      {canManage && (
        <s-button slot="primary-action" variant="primary" onClick={() => setOpenId("new")}>
          New sale
        </s-button>
      )}
      {open && (
        <Flyout
          key={openId}
          onClose={() => setOpenId(null)}
          label={open.id ? `Sale: ${open.name}` : "New sale"}
          title={open.id ? (canManage ? "Edit sale" : "Sale") : "New sale"}
          width={540}
          bodyStyle={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          <Editor s={open} tiers={tiers} canManage={canManage} />
        </Flyout>
      )}

      <s-section>
        <s-paragraph>
          Sales start and stop on their own at the times you set (store time). One can be for everyone, or a secret sale for chosen loyalty tiers:
          signed-in members of those tiers get it automatically at checkout, and can get a tab on the front page that only they see.
        </s-paragraph>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px", alignItems: "center" }}>
          {[
            ["current", `Live and scheduled (${live + soon})`],
            ["past", "Ended and off"],
            ["all", "All"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setShow(id)}
              style={{
                font: "inherit",
                fontSize: "13px",
                padding: "4px 12px",
                borderRadius: "999px",
                border: `1px solid ${show === id ? "#1a1a1a" : "#c9c9c9"}`,
                background: show === id ? "#1a1a1a" : "#fff",
                color: show === id ? "#fff" : "#303030",
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </s-section>

      <s-section heading={show === "current" ? "Live and scheduled" : show === "past" ? "Ended and off" : "All sales"}>
        {shown.length === 0 ? (
          <s-paragraph>{show === "current" ? (canManage ? "Nothing live or coming up. Start one with New sale." : "Nothing live or coming up.") : "None."}</s-paragraph>
        ) : (
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", overflow: "hidden" }}>
            {shown.map((s, i) => {
              const [label, bg, fg] = STATUS[s.status];
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setOpenId(s.id)}
                  style={{
                    ...linkBtn,
                    color: "#303030",
                    display: "flex",
                    gap: "12px",
                    alignItems: "center",
                    flexWrap: "wrap",
                    width: "100%",
                    textAlign: "left",
                    padding: "12px 14px",
                    borderTop: i ? "1px solid #ebebeb" : 0,
                  }}
                >
                  <span style={{ flex: "1 1 260px", minWidth: 0 }}>
                    <span style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "14px" }}>{s.name}</strong>
                      <span style={pill(bg, fg)}>{label}</span>
                      {s.audience === "tiers" && <span style={pill("#f1e8ff", "#5700d1")}>{s.tierNames.join(", ") || "Members"} only</span>}
                      {s.tabEnabled && <span style={pill("#fff1e3", "#8a4b00")}>Front-page tab</span>}
                      {s.syncError && <span style={pill("#fee9e8", "#8e1f0b")}>Not in Shopify</span>}
                    </span>
                    <span style={{ ...small, display: "block", marginTop: "3px" }}>{describe(s)}</span>
                  </span>
                  <span style={{ ...small, whiteSpace: "nowrap" }}>
                    {s.kind === "earlyAccess" ? `Members ${when(s.startsAt)} · everyone ${when(s.endsAt)}` : `${when(s.startsAt)} – ${when(s.endsAt)}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </s-section>

      <s-section heading="Set up once">
        <s-unordered-list>
          <s-list-item>Early access: turn on the “Early access” rule in Shopify under Settings → Checkout → Checkout rules.</s-list-item>
          <s-list-item>Front-page tab: turn on “Member sale tab” in the theme editor under App embeds.</s-list-item>
          <s-list-item>Members need to be signed in for members-only sales and early access to recognise them.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

// Choose products or collections
function Picker({ type, chosen, onChange, disabled }) {
  const find = useFetcher();
  const [q, setQ] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const results = q.trim().length >= 2 && find.data?.intent === "find" ? (type === "products" ? find.data.products : find.data.collections) ?? [] : [];
  const ids = new Set(chosen.map((c) => c.id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      {chosen.map((c) => (
        <div key={c.id} style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
          <span style={{ flex: 1 }}>{c.title}</span>
          {!disabled && (
            <button type="button" style={{ ...linkBtn, color: "#b42318", fontSize: "13px" }} onClick={() => onChange(chosen.filter((x) => x.id !== c.id))}>
              Remove
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <>
          <input
            type="search"
            value={q}
            onChange={(e) => {
              const t = e.target.value;
              setQ(t);
              clearTimeout(timer.current);
              if (t.trim().length >= 2) timer.current = setTimeout(() => find.submit({ intent: "find", q: t }, { method: "post" }), 250);
            }}
            placeholder={type === "products" ? "Find a product" : "Find a collection"}
            aria-label={type === "products" ? "Find a product" : "Find a collection"}
            style={{ ...input, width: "100%" }}
          />
          {find.state !== "idle" && <span style={small}>Searching…</span>}
          {find.data?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{find.data.error}</span>}
          {results.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
              <span style={{ flex: 1 }}>{r.title}</span>
              {ids.has(r.id) ? (
                <span style={small}>Added</span>
              ) : (
                <button type="button" style={{ ...linkBtn, fontSize: "13px", fontWeight: 600 }} onClick={() => onChange([...chosen, { id: r.id, title: r.title }])}>
                  Add
                </button>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Editor({ s, tiers, canManage }) {
  const close = useFlyoutClose();
  const save = useFetcher();
  const remove = useFetcher();
  const retry = useFetcher();
  const isNew = !s.id;
  const [name, setName] = useState(s.name ?? "");
  const [kind, setKind] = useState(s.kind ?? "items");
  const [audience, setAudience] = useState(s.audience ?? "everyone");
  const [chosenTiers, setChosenTiers] = useState(s.tiers ?? []);
  const [valueType, setValueType] = useState(s.valueType ?? "percentage");
  const [value, setValue] = useState(s.value ? String(s.value) : "");
  const [scope, setScope] = useState(s.scope ?? "all");
  const [collections, setCollections] = useState(s.collections ?? []);
  const [products, setProducts] = useState(s.products ?? []);
  const [minSubtotal, setMinSubtotal] = useState(s.minSubtotal != null ? String(s.minSubtotal) : "");
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
  const dis = !canManage;

  useEffect(() => {
    if (save.data?.intent === "save" && save.data.ok) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.data]);
  useEffect(() => {
    if (remove.data?.deleted) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remove.data]);
  // Early access is always for tiers, and always for chosen items
  useEffect(() => {
    if (!early) return;
    setAudience("tiers");
    if (scope === "all") setScope("products");
  }, [early]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () =>
    save.submit(
      {
        intent: "save",
        ...(s.id ? { id: String(s.id) } : {}),
        name,
        kind,
        audience,
        tiers: JSON.stringify(chosenTiers),
        valueType,
        value,
        scope,
        collections: JSON.stringify(collections),
        products: JSON.stringify(products),
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
  const radio = (name, value, current, set, label, hint) => (
    <label key={value} style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
      <input type="radio" name={name} checked={current === value} onChange={() => set(value)} disabled={dis} style={{ marginTop: "3px" }} />
      <span>
        <strong style={{ fontWeight: 600 }}>{label}</strong>
        {hint && <span style={{ ...small, display: "block" }}>{hint}</span>}
      </span>
    </label>
  );

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {s.syncError && (
          <div style={{ ...section, background: "#fff4f4" }}>
            <span style={{ color: "#8e1f0b", fontSize: "13px" }}>Shopify didn't take the last change: {s.syncError}</span>
            {canManage && (
              <span>
                <s-button onClick={() => retry.submit({ intent: "retry", id: String(s.id) }, { method: "post" })} {...(retry.state !== "idle" ? { loading: true } : {})}>
                  Try again
                </s-button>
              </span>
            )}
          </div>
        )}

        <div style={section}>
          <label style={field}>
            Name (customers see it at checkout)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gold members' spring sale" style={input} disabled={dis} maxLength={120} />
          </label>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={dis} />
            On (runs at the times below)
          </label>
        </div>

        <div style={section}>
          <p style={sectionTitle}>What kind</p>
          {radio("sale-kind", "items", kind, setKind, "% or $ off items", "Off everything, chosen collections or chosen products.")}
          {radio("sale-kind", "order", kind, setKind, "Order discount", "Off the whole order, optionally only over an amount.")}
          {radio("sale-kind", "earlyAccess", kind, setKind, "Early access", "Members of chosen tiers can buy chosen products before everyone else.")}
        </div>

        <div style={section}>
          <p style={sectionTitle}>Who gets it</p>
          {!early && radio("sale-audience", "everyone", audience, setAudience, "Everyone")}
          {radio("sale-audience", "tiers", audience, setAudience, "Only members of chosen loyalty tiers", "A secret sale: they need to be signed in at checkout.")}
          {audience === "tiers" && (
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", paddingLeft: "24px" }}>
              {tiers.length === 0 && <span style={small}>No loyalty tiers yet. Set them up in Loyalty.</span>}
              {tiers.map((t) => (
                <label key={t.id} style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
                  <input
                    type="checkbox"
                    checked={chosenTiers.includes(t.id)}
                    onChange={(e) => setChosenTiers(e.target.checked ? [...chosenTiers, t.id] : chosenTiers.filter((x) => x !== t.id))}
                    disabled={dis}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
        </div>

        {!early && (
          <div style={section}>
            <p style={sectionTitle}>How much off</p>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <select value={valueType} onChange={(e) => setValueType(e.target.value)} disabled={dis} style={input} aria-label="Percentage or dollar amount">
                <option value="percentage">% off</option>
                <option value="fixed">$ off</option>
              </select>
              <input type="number" min="0.01" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} disabled={dis} style={{ ...input, width: "110px" }} aria-label="Amount off" />
              <span style={small}>{valueType === "fixed" ? (kind === "order" ? "off the order" : "off each item") : kind === "order" ? "off the order" : "off each item"}</span>
            </div>
            {kind === "order" && (
              <label style={field}>
                Only on orders of at least ($, optional)
                <input type="number" min="0.01" step="0.01" value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value)} disabled={dis} style={{ ...input, width: "130px" }} />
              </label>
            )}
            <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
              <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} disabled={dis} />
              Can be used with other discounts (always works with shipping discounts)
            </label>
          </div>
        )}

        {kind !== "order" && (
          <div style={section}>
            <p style={sectionTitle}>{early ? "Which products" : "On what"}</p>
            {!early && radio("sale-scope", "all", scope, setScope, "Everything")}
            {radio("sale-scope", "collections", scope, setScope, "Chosen collections")}
            {radio("sale-scope", "products", scope, setScope, "Chosen products")}
            {scope === "collections" && <Picker type="collections" chosen={collections} onChange={setCollections} disabled={dis} />}
            {scope === "products" && <Picker type="products" chosen={products} onChange={setProducts} disabled={dis} />}
          </div>
        )}

        <div style={section}>
          <p style={sectionTitle}>When (store time)</p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <label style={field}>
              {early ? "Members can buy from" : "Starts"}
              <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} disabled={dis} style={{ ...input, width: "210px" }} />
            </label>
            <label style={field}>
              {early ? "Everyone can buy from" : "Ends"}
              <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} disabled={dis} style={{ ...input, width: "210px" }} />
            </label>
          </div>
          {early && (
            <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
              <input type="checkbox" checked={lockBefore} onChange={(e) => setLockBefore(e.target.checked)} disabled={dis} style={{ marginTop: "3px" }} />
              <span>
                Nobody can buy them before members can
                <span style={{ ...small, display: "block" }}>Untick if they're already on sale and should stay buyable until members' time.</span>
              </span>
            </label>
          )}
        </div>

        <div style={section}>
          <p style={sectionTitle}>Front-page tab</p>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
            <input type="checkbox" checked={tabEnabled} onChange={(e) => setTabEnabled(e.target.checked)} disabled={dis} />
            Show a tab on the front page while it's on{audience === "tiers" ? ", only to the members who get it" : ""}
          </label>
          {tabEnabled && (
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
              <label style={field}>
                Tab label
                <input value={tabLabel} onChange={(e) => setTabLabel(e.target.value)} placeholder="Members' sale" maxLength={40} disabled={dis} style={{ ...input, width: "190px" }} />
              </label>
              <label style={{ ...field, flex: "1 1 200px" }}>
                Links to
                <input value={tabUrl} onChange={(e) => setTabUrl(e.target.value)} placeholder="/collections/members-sale" disabled={dis} style={{ ...input, width: "100%" }} />
              </label>
            </div>
          )}
        </div>

        {!isNew && (
          <div style={section}>
            <span style={small}>
              {s.createdBy ? `Made by ${s.createdBy}. ` : ""}
              {s.syncedAt ? `Sent to Shopify ${when(s.syncedAt)}.` : ""}
            </span>
          </div>
        )}

        {!isNew && canManage && (
          <div style={{ ...section, borderBottom: 0 }}>
            {confirmDelete ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                Delete this sale? It stops straight away in Shopify. Orders already placed keep their discount.
                <span style={{ display: "flex", gap: "6px" }}>
                  <s-button tone="critical" onClick={() => remove.submit({ intent: "delete", id: String(s.id) }, { method: "post" })} {...(remove.state !== "idle" ? { loading: true } : {})}>
                    Delete
                  </s-button>
                  <s-button variant="tertiary" onClick={() => setConfirmDelete(false)}>
                    Keep it
                  </s-button>
                </span>
              </div>
            ) : (
              <span>
                <s-button variant="tertiary" tone="critical" onClick={() => setConfirmDelete(true)}>
                  Delete sale
                </s-button>
              </span>
            )}
          </div>
        )}
      </div>
      <footer style={{ padding: "12px 18px", borderTop: "1px solid #ebebeb", background: "#fafafa" }}>
        {error && <div style={{ color: "#b42318", marginBottom: "8px", fontSize: "13px" }}>{error}</div>}
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <s-button variant="tertiary" onClick={close}>
            {canManage ? "Cancel" : "Close"}
          </s-button>
          {canManage && (
            <s-button variant="primary" onClick={submit} {...(save.state !== "idle" ? { loading: true } : {})}>
              {isNew ? "Create sale" : "Save"}
            </s-button>
          )}
        </div>
      </footer>
    </>
  );
}
