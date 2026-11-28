import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { Flyout, useFlyoutClose } from "../components/Flyout";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { searchProducts } from "../preorder-windows.server";
import { FreebieError, attachProducts, deleteFreebie, detachProduct, listFreebies, saveFreebie, searchGiftVariants, setImage } from "../freebies.server";

// Freebies: free gifts attached to products. Shown on the product page while
// there's stock; one per unit bought; packed with the order.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "freebies", "view");
  if (noAccess) return { noAccess: true };
  return { freebies: await listFreebies(session.shop), canManage: can(user, "freebies", "manage") };
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "freebies", "view")) return denied("freebies", "view");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const shop = session.shop;
  try {
    if (intent === "search") return { intent, products: (await searchProducts(shop, admin, form.get("q"))).slice(0, 15) };
    // A product from the store to give away
    if (intent === "findGift") return { intent, variants: await searchGiftVariants(admin, form.get("q")) };
    if (!can(user, "freebies", "manage")) return denied("freebies", "manage");
    const id = Number(form.get("id")) || null;
    if (intent === "save") {
      const f = await saveFreebie(
        shop,
        admin,
        {
          id,
          title: form.get("title"),
          description: form.get("description"),
          sku: form.get("sku"),
          barcode: form.get("barcode"),
          stock: form.get("stock"),
          active: form.get("active") !== "false",
          kind: form.get("kind") || undefined,
          starts: form.get("starts"),
          ends: form.get("ends"),
          maxOrders: form.get("maxOrders"),
          minSubtotal: form.get("minSubtotal"),
          variantId: form.has("variantId") ? String(form.get("variantId")) : undefined,
        },
        user,
      );
      return { intent, ok: true, id: f.id, created: !id };
    }
    if (intent === "create") {
      // A new freebie, straight onto the product it's for
      const f = await saveFreebie(
        shop,
        admin,
        { title: form.get("title"), description: form.get("description"), stock: form.get("stock") || "0", active: true, variantId: form.get("variantId") || undefined },
        user,
      );
      await attachProducts(shop, admin, f.id, [String(form.get("productId") ?? "")]);
      return { intent, ok: true, id: f.id };
    }
    if (intent === "image") return { intent, ok: true, url: await setImage(shop, admin, id, form.get("file")) };
    if (intent === "attach") return (await attachProducts(shop, admin, id, JSON.parse(String(form.get("productIds") ?? "[]"))), { intent, ok: true });
    if (intent === "detach") return (await detachProduct(shop, admin, id, String(form.get("productId") ?? "")), { intent, ok: true });
    if (intent === "delete") return (await deleteFreebie(shop, admin, id), { intent, ok: true, deleted: id });
  } catch (e) {
    if (!(e instanceof FreebieError)) console.error(`[freebies] ${intent}:`, e);
    return { intent, error: e instanceof FreebieError ? e.message : errorMessage(e) };
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

function Photo({ src, size = 56, alt = "" }) {
  return src ? (
    <img src={src} alt={alt} style={{ width: size, height: size, objectFit: "cover", borderRadius: "8px", background: "#f1f1f1", flexShrink: 0 }} />
  ) : (
    <div aria-hidden="true" style={{ width: size, height: size, borderRadius: "8px", background: "#fde7ef", display: "grid", placeItems: "center", fontSize: size / 2.4, flexShrink: 0 }}>
      🎁
    </div>
  );
}

function Status({ f }) {
  if (!f.active) return <span style={pill("#f1f1f1", "#616161")}>Off</span>;
  if (f.stock <= 0) return <span style={pill("#fff1e3", "#8a4b00")}>Out of stock</span>;
  if (f.kind === "firstOrders" || f.kind === "minSpend") {
    const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
    const what = f.kind === "firstOrders" ? `First ${f.maxOrders} orders` : `Orders $${f.minSubtotal}+`;
    if (f.phase === "upcoming") return <span style={pill("#eef3ff", "#1c4a9c")}>{what} · starts {when(f.startsAt)}</span>;
    if (f.phase === "over") return <span style={pill("#f1f1f1", "#616161")}>{what} · ended</span>;
    if (f.kind === "firstOrders" && f.ordersGranted >= f.maxOrders) return <span style={pill("#f1f1f1", "#616161")}>All {f.maxOrders} given</span>;
    return <span style={pill("#e3f5e8", "#0c5132")}>{what} · until {when(f.endsAt)}{f.kind === "firstOrders" ? ` · ${f.ordersGranted} given` : ""}</span>;
  }
  if (!f.products.length) return <span style={pill("#fff1e3", "#8a4b00")}>No products yet</span>;
  return <span style={pill("#e3f5e8", "#0c5132")}>Showing</span>;
}

export default function Freebies() {
  const data = useLoaderData();
  const [openId, setOpenId] = useState(null); // a freebie being edited
  const [addFor, setAddFor] = useState(null); // a product getting a freebie
  const [q, setQ] = useState("");
  const search = useFetcher();
  const unlink = useFetcher();
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (data.noAccess) return <NoAccess />;
  const { freebies, canManage } = data;
  // "new": a freebie for orders (first orders, or orders over an amount)
  const open = openId === "new" ? { kind: "minSpend" } : freebies.find((f) => f.id === openId);

  // Products that have freebies now, and what each has
  const byProduct = new Map();
  for (const f of freebies) {
    for (const p of f.products) {
      if (!byProduct.has(p.productId)) byProduct.set(p.productId, { ...p, freebies: [] });
      byProduct.get(p.productId).freebies.push(f);
    }
  }
  const searching = q.trim().length >= 2;
  const results = search.data?.intent === "search" && searching ? search.data.products ?? [] : [];
  const rows = searching
    ? results.map((p) => ({ ...p, freebies: byProduct.get(p.productId)?.freebies ?? [] }))
    : [...byProduct.values()].sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
  const find = (text) => {
    setQ(text);
    clearTimeout(timer.current);
    if (text.trim().length < 2) return;
    timer.current = setTimeout(() => search.submit({ intent: "search", q: text }, { method: "post" }), 250);
  };
  const orderOffers = freebies.filter((f) => f.kind && f.kind !== "product");
  const unattached = freebies.filter((f) => (!f.kind || f.kind === "product") && !f.products.length);

  return (
    <s-page heading="Freebies" inlineSize="large">
      {open && (
        <Flyout
          key={open.id ?? "new"}
          onClose={() => setOpenId(null)}
          label={open.id ? `Freebie: ${open.title}` : "New freebie for orders"}
          title={!open.id ? "New freebie for orders" : canManage ? "Edit freebie" : "Freebie"}
          width={480}
          bodyStyle={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          <Editor f={open} canManage={canManage} onCreated={(id) => setOpenId(id)} />
        </Flyout>
      )}
      {addFor && (
        <Flyout
          key={`add-${addFor.productId}`}
          onClose={() => setAddFor(null)}
          label={`Add a freebie to ${addFor.title}`}
          title="Add a freebie"
          width={480}
          bodyStyle={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          <AddFreebie
            product={addFor}
            freebies={freebies}
            onCreated={(id) => {
              setAddFor(null);
              setOpenId(id);
            }}
          />
        </Flyout>
      )}
      <s-section>
        <s-paragraph>
          Free gifts that come with a product. Find the product, then add a freebie to it: a new one or one you've made already. While it's on and
          has stock, the product page shows it (with the “Freebie” block in the theme). Every unit bought gets one while stock lasts, packed with the
          order, and the customer sees it on their order in their account.
        </s-paragraph>
        <s-paragraph>
          Freebies for orders don't need a product: one with each of the first orders during an offer, or with orders over an amount. Orders need
          an in-stock item to get one.
        </s-paragraph>
        {canManage && (
          <div style={{ marginTop: "8px" }}>
            <s-button onClick={() => setOpenId("new")}>New freebie for orders</s-button>
          </div>
        )}
        <div style={{ marginTop: "12px" }}>
          <input
            type="search"
            value={q}
            onChange={(e) => find(e.target.value)}
            placeholder="Find a product by title or SKU"
            aria-label="Find a product"
            style={{ ...input, width: "100%", maxWidth: "560px" }}
          />
        </div>
      </s-section>

      <s-section heading={searching ? `Products matching “${q.trim()}”` : `Products with freebies (${rows.length})`}>
        {unlink.data?.error && <div style={{ color: "#b42318", fontSize: "13px", marginBottom: "8px" }}>{unlink.data.error}</div>}
        {searching && search.state !== "idle" && <span style={small}>Searching…</span>}
        {rows.length === 0 && !(searching && search.state !== "idle") ? (
          <s-paragraph>{searching ? "No products found." : "No products have a freebie yet. Find one above to add one."}</s-paragraph>
        ) : (
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", overflow: "hidden" }}>
            {rows.map((p, i) => (
              <div
                key={p.productId}
                style={{ display: "flex", gap: "12px", alignItems: "center", padding: "10px 12px", borderTop: i ? "1px solid #ebebeb" : 0, flexWrap: "wrap" }}
              >
                <Photo src={p.imageUrl} size={44} />
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: "14px" }}>{p.title}</div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                    {p.freebies.length === 0 && <span style={small}>No freebie</span>}
                    {p.freebies.map((f) => (
                      <span
                        key={f.id}
                        style={{ display: "inline-flex", alignItems: "center", gap: "6px", border: "1px solid #f3c2d3", background: "#fff4f8", borderRadius: "999px", padding: "2px 4px 2px 4px" }}
                      >
                        <button
                          type="button"
                          onClick={() => setOpenId(f.id)}
                          style={{ ...linkBtn, color: "#7a1240", fontSize: "12px", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "6px" }}
                          title="Edit this freebie"
                        >
                          <Photo src={f.imageUrl} size={20} />
                          {f.title}
                          <span style={{ fontWeight: 500, color: "#8a5a6c" }}>· {f.stock} left</span>
                          {!f.active && <span style={{ fontWeight: 500, color: "#616161" }}>· off</span>}
                        </button>
                        {canManage && (
                          <button
                            type="button"
                            aria-label={`Remove ${f.title} from ${p.title}`}
                            onClick={() => unlink.submit({ intent: "detach", id: String(f.id), productId: p.productId }, { method: "post" })}
                            style={{ ...linkBtn, color: "#8a5a6c", fontSize: "15px", lineHeight: 1, padding: "0 4px" }}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
                {canManage && (
                  <s-button onClick={() => setAddFor(p)}>{p.freebies.length ? "Add another freebie" : "Add freebie"}</s-button>
                )}
              </div>
            ))}
          </div>
        )}
      </s-section>

      {orderOffers.length > 0 && (
        <s-section heading={`Freebies for orders (${orderOffers.length})`}>
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", overflow: "hidden" }}>
            {orderOffers.map((f, i) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setOpenId(f.id)}
                style={{ ...linkBtn, color: "#303030", display: "flex", gap: "12px", alignItems: "center", width: "100%", textAlign: "left", padding: "10px 12px", borderTop: i ? "1px solid #ebebeb" : 0, flexWrap: "wrap" }}
              >
                <Photo src={f.imageUrl} size={40} />
                <span style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <strong style={{ fontSize: "14px" }}>{f.title}</strong>
                  <span style={{ ...small, display: "block" }}>
                    {f.kind === "minSpend" ? `Orders over $${Number(f.minSubtotal ?? 0).toFixed(2).replace(/\.00$/, "")}` : `First ${f.maxOrders} orders (${f.ordersGranted ?? 0} given)`} · {f.stock} left
                  </span>
                </span>
                <Status f={f} />
              </button>
            ))}
          </div>
        </s-section>
      )}

      {unattached.length > 0 && (
        <s-section heading={`Freebies not on a product (${unattached.length})`}>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {unattached.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setOpenId(f.id)}
                style={{ ...linkBtn, display: "inline-flex", alignItems: "center", gap: "8px", border: "1px solid #e3e3e3", borderRadius: "10px", padding: "6px 10px", color: "#303030" }}
              >
                <Photo src={f.imageUrl} size={28} />
                <span style={{ fontSize: "13px", fontWeight: 600 }}>{f.title}</span>
                <span style={small}>{f.stock} left</span>
              </button>
            ))}
          </div>
        </s-section>
      )}
    </s-page>
  );
}

// A product from the store as the gift: search, then pick a variant
function GiftPicker({ onPick, disabled }) {
  const find = useFetcher();
  const [q, setQ] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (disabled) return null;
  const list = find.data?.intent === "findGift" && q.trim().length >= 2 ? find.data.variants ?? [] : [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <input
        type="search"
        value={q}
        onChange={(e) => {
          const t = e.target.value;
          setQ(t);
          clearTimeout(timer.current);
          if (t.trim().length >= 2) timer.current = setTimeout(() => find.submit({ intent: "findGift", q: t }, { method: "post" }), 250);
        }}
        placeholder="Find a product by title or SKU"
        aria-label="Find a product to give away"
        style={{ ...input, width: "100%" }}
      />
      {find.state !== "idle" && <span style={small}>Searching…</span>}
      {find.data?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{find.data.error}</span>}
      {q.trim().length >= 2 && find.state === "idle" && find.data?.intent === "findGift" && list.length === 0 && <span style={small}>No products found.</span>}
      {list.map((v) => (
        <div key={v.variantId} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Photo src={v.imageUrl} size={36} />
          <span style={{ flex: 1, minWidth: 0, fontSize: "13px" }}>
            {v.title}
            <span style={{ ...small, display: "block" }}>
              {v.sku ? `${v.sku} · ` : ""}
              {v.tracked ? `${v.available} in stock` : "Stock not tracked in Shopify"}
            </span>
          </span>
          {v.tracked ? (
            <button type="button" style={{ ...linkBtn, fontSize: "13px", fontWeight: 600 }} onClick={() => (onPick(v), setQ(""))}>
              Use
            </button>
          ) : (
            <span style={small}>Can't use</span>
          )}
        </div>
      ))}
    </div>
  );
}

// The gift is a store product: what that means, and a way to undo it
function GiftSource({ title, imageUrl, stock, onClear, disabled }) {
  return (
    <div style={{ display: "flex", gap: "10px", alignItems: "center", border: "1px solid #e3e3e3", borderRadius: "10px", padding: "8px 10px", background: "#fafafa" }}>
      <Photo src={imageUrl} size={44} />
      <span style={{ flex: 1, minWidth: 0, fontSize: "13px" }}>
        <strong>{title}</strong>
        <span style={{ ...small, display: "block" }}>
          {stock != null ? `${stock} in stock in Shopify. ` : ""}Each gift takes one from its Shopify stock; a cancelled order puts it back. Both show in Inventory history.
        </span>
      </span>
      {!disabled && (
        <button type="button" style={{ ...linkBtn, color: "#b42318", fontSize: "13px" }} onClick={onClear}>
          Don't use
        </button>
      )}
    </div>
  );
}

// Add a freebie to one product: one already made, or a new one
function AddFreebie({ product, freebies, onCreated }) {
  const close = useFlyoutClose();
  const attach = useFetcher();
  const create = useFetcher();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [stock, setStock] = useState("");
  const [gift, setGift] = useState(null); // a store product as the gift
  const [find, setFind] = useState("");
  const others = freebies.filter((f) => !f.products.some((p) => p.productId === product.productId));
  const shown = others.filter((f) => !find.trim() || f.title.toLowerCase().includes(find.trim().toLowerCase()));
  useEffect(() => {
    if (attach.data?.intent === "attach" && attach.data.ok) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attach.data]);
  useEffect(() => {
    if (create.data?.intent === "create" && create.data.ok) onCreated(create.data.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [create.data]);
  const error = attach.data?.error ?? create.data?.error;

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ ...section, flexDirection: "row", alignItems: "center", gap: "12px" }}>
          <Photo src={product.imageUrl} size={44} />
          <strong style={{ fontSize: "14px" }}>{product.title}</strong>
        </div>

        <div style={section}>
          <p style={sectionTitle}>A new freebie</p>
          <span style={{ fontSize: "13px" }}>The gift: a product from your store (its stock is used), or something of its own (you set how many).</span>
          {gift ? (
            <GiftSource title={gift.title} imageUrl={gift.imageUrl} stock={gift.available} onClear={() => setGift(null)} />
          ) : (
            <GiftPicker onPick={(v) => (setGift(v), !title && setTitle(v.title))} />
          )}
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Name
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={gift ? gift.title : "e.g. Exclusive acrylic stand"} style={input} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Description (shown on the product page)
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...input, resize: "vertical" }} />
          </label>
          {!gift && (
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              How many to give away
              <input type="number" min="0" step="1" value={stock} onChange={(e) => setStock(e.target.value)} style={{ ...input, width: "130px" }} />
            </label>
          )}
          <span>
            <s-button
              variant="primary"
              onClick={() =>
                create.submit(
                  { intent: "create", productId: product.productId, title, description, stock: stock || "0", ...(gift ? { variantId: gift.variantId } : {}) },
                  { method: "post" },
                )
              }
              {...(create.state !== "idle" ? { loading: true } : {})}
            >
              {gift ? "Create and add" : "Create and add, then add a photo"}
            </s-button>
          </span>
        </div>

        {others.length > 0 && (
          <div style={{ ...section, borderBottom: 0 }}>
            <p style={sectionTitle}>Or one you've made already</p>
            {others.length > 6 && (
              <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a freebie" style={{ ...input, width: "100%" }} />
            )}
            {shown.map((f) => (
              <div key={f.id} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <Photo src={f.imageUrl} size={36} />
                <span style={{ flex: 1, minWidth: 0, fontSize: "13px" }}>
                  <strong>{f.title}</strong>
                  <span style={small}>
                    {" "}
                    · {f.stock} left{f.products.length ? ` · also with ${f.products.length} other product${f.products.length === 1 ? "" : "s"}` : ""}
                  </span>
                </span>
                <s-button
                  onClick={() => attach.submit({ intent: "attach", id: String(f.id), productIds: JSON.stringify([product.productId]) }, { method: "post" })}
                  {...(attach.state !== "idle" && attach.formData?.get("id") === String(f.id) ? { loading: true } : {})}
                >
                  Add
                </s-button>
              </div>
            ))}
          </div>
        )}
      </div>
      <footer style={{ padding: "12px 18px", borderTop: "1px solid #ebebeb", background: "#fafafa" }}>
        {error && <div style={{ color: "#b42318", marginBottom: "8px", fontSize: "13px" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <s-button variant="tertiary" onClick={close}>
            Cancel
          </s-button>
        </div>
      </footer>
    </>
  );
}

function Editor({ f, canManage, onCreated }) {
  const close = useFlyoutClose();
  const save = useFetcher();
  const image = useFetcher();
  const link = useFetcher();
  const search = useFetcher();
  const remove = useFetcher();
  const isNew = !f.id;
  const [title, setTitle] = useState(f.title ?? "");
  const [description, setDescription] = useState(f.description ?? "");
  const [stock, setStock] = useState(String(f.stock ?? 0));
  const [sku, setSku] = useState(f.sku ?? "");
  const [barcode, setBarcode] = useState(f.barcode ?? "");
  const [active, setActive] = useState(f.active ?? true);
  // A store product as the gift: { variantId, title, imageUrl, available? } or null
  const [gift, setGift] = useState(f.source ? { variantId: f.source.variantId, title: f.source.title, imageUrl: f.source.imageUrl, available: f.stock } : null);
  // Who gets it: with chosen products, the first N orders, or orders over $X
  const [kind, setKind] = useState(f.kind ?? "product");
  const [starts, setStarts] = useState(f.startsInput ?? "");
  const [ends, setEnds] = useState(f.endsInput ?? "");
  const [maxOrders, setMaxOrders] = useState(f.maxOrders != null ? String(f.maxOrders) : "");
  const [minSubtotal, setMinSubtotal] = useState(f.minSubtotal != null ? String(f.minSubtotal) : "");
  const perOrder = kind !== "product";
  const [q, setQ] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (save.data?.intent !== "save" || !save.data.ok) return;
    if (save.data.created) onCreated(save.data.id);
    else close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.data]);
  useEffect(() => {
    if (remove.data?.deleted) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remove.data]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const find = (text) => {
    setQ(text);
    clearTimeout(timer.current);
    if (text.trim().length < 2) return;
    timer.current = setTimeout(() => search.submit({ intent: "search", q: text }, { method: "post" }), 250);
  };
  const results = search.data?.intent === "search" && q.trim().length >= 2 ? search.data.products ?? [] : [];
  const attached = new Set((f.products ?? []).map((p) => p.productId));

  const upload = (file) => {
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    const fd = new FormData();
    fd.set("intent", "image");
    fd.set("id", String(f.id));
    fd.set("file", file);
    image.submit(fd, { method: "post", encType: "multipart/form-data" });
  };
  const submit = () =>
    save.submit(
      {
        intent: "save",
        ...(f.id ? { id: String(f.id) } : {}),
        title,
        description,
        stock: gift ? "0" : stock,
        sku,
        barcode,
        active: String(active),
        kind,
        starts,
        ends,
        maxOrders,
        minSubtotal,
        variantId: gift?.variantId ?? "",
      },
      { method: "post" },
    );
  const error = save.data?.error ?? image.data?.error ?? link.data?.error ?? remove.data?.error ?? search.data?.error;

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {!isNew && (
          <div style={section}>
            <p style={sectionTitle}>Photo</p>
            <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
              <Photo src={preview ?? f.imageUrl} size={88} alt={f.title} />
              {canManage && (
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                  <span>{f.source && f.imageUrl === f.source.imageUrl ? "Use a different photo (optional)" : f.imageUrl ? "Replace the photo" : "Add a photo"}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => upload(e.target.files?.[0])} />
                  <span style={small}>{image.state !== "idle" ? "Uploading…" : "JPEG, PNG, WebP or GIF, up to 4 MB. Shoppers can tap it to see it big."}</span>
                </label>
              )}
            </div>
          </div>
        )}

        <div style={section}>
          <p style={sectionTitle}>The gift</p>
          {gift ? (
            <GiftSource title={gift.title} imageUrl={gift.imageUrl} stock={gift.available} onClear={() => (setGift(null), setStock("0"))} disabled={!canManage} />
          ) : (
            <>
              <span style={small}>Something of its own (set how many below), or use a product from your store and its stock:</span>
              <GiftPicker onPick={(v) => (setGift(v), !title && setTitle(v.title))} disabled={!canManage} />
            </>
          )}
        </div>

        <div style={section}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Name
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={gift ? gift.title : "e.g. Exclusive acrylic stand"} style={input} disabled={!canManage} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Description (shown on the product page)
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...input, resize: "vertical" }} disabled={!canManage} />
          </label>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            {gift ? (
              <div style={{ fontSize: "13px", alignSelf: "flex-end", paddingBottom: "8px" }}>Stock: Shopify's{gift.available != null ? ` (${gift.available} now)` : ""}</div>
            ) : (
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                Left to give away
                <input type="number" min="0" step="1" value={stock} onChange={(e) => setStock(e.target.value)} style={{ ...input, width: "130px" }} disabled={!canManage} />
              </label>
            )}
            {!isNew && <div style={{ ...small, alignSelf: "flex-end", paddingBottom: "8px" }}>{f.given.toLocaleString()} given so far</div>}
          </div>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={!canManage} />
            {perOrder ? "On (given with qualifying orders during the offer while there's stock)" : "On (shown on product pages and given with orders while there's stock)"}
          </label>
        </div>

        <div style={section}>
          <p style={sectionTitle}>Who gets it</p>
          {[
            ["product", "With chosen products", "One for every unit bought of the products below."],
            ["firstOrders", "The first orders during an offer", "The first orders placed in the window that include an in-stock item (not a pre-order) get one each."],
            ["minSpend", "Orders over an amount during an offer", "Orders in the window with a subtotal of at least the amount (after discounts, before shipping and tax) that include an in-stock item get one each."],
          ].map(([k, label, hint]) => (
            <label key={k} style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "13px" }}>
              <input type="radio" name="freebie-kind" checked={kind === k} onChange={() => setKind(k)} disabled={!canManage} style={{ marginTop: "3px" }} />
              <span>
                <strong style={{ fontWeight: 600 }}>{label}</strong>
                <span style={{ ...small, display: "block" }}>{hint}</span>
              </span>
            </label>
          ))}
          {perOrder && (
            <>
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                  Starts (store time)
                  <input type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} style={{ ...input, width: "210px" }} disabled={!canManage} />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                  Ends
                  <input type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} style={{ ...input, width: "210px" }} disabled={!canManage} />
                </label>
              </div>
              {kind === "firstOrders" ? (
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                  How many orders get one
                  <input type="number" min="1" step="1" value={maxOrders} onChange={(e) => setMaxOrders(e.target.value)} style={{ ...input, width: "130px" }} disabled={!canManage} />
                  {!isNew && f.kind === "firstOrders" && (
                    <span style={small}>
                      {f.ordersGranted.toLocaleString()} of {f.maxOrders?.toLocaleString()} given. A cancelled order frees its place for the next order.
                    </span>
                  )}
                </label>
              ) : (
                <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                  Order subtotal of at least ($)
                  <input type="number" min="0.01" step="0.01" value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value)} style={{ ...input, width: "130px" }} disabled={!canManage} />
                </label>
              )}
              <span style={small}>
                One per order. Every offer an order qualifies for applies, so offers stack. It's packed with the in-stock item, and it still stops when the stock above runs out.
              </span>
            </>
          )}
        </div>

        {gift ? (
          <div style={section}>
            <p style={sectionTitle}>For packing</p>
            <span style={small}>Scanned with the product's own SKU and barcode from Shopify.</span>
          </div>
        ) : (
        <div style={section}>
          <p style={sectionTitle}>For packing (optional)</p>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              SKU
              <input value={sku} onChange={(e) => setSku(e.target.value)} style={{ ...input, width: "160px" }} disabled={!canManage} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              Barcode
              <input value={barcode} onChange={(e) => setBarcode(e.target.value)} style={{ ...input, width: "160px" }} disabled={!canManage} />
            </label>
          </div>
          <span style={small}>With a barcode or SKU it's scanned like any item. Without one, packers tap “Put one in the box”.</span>
        </div>
        )}

        {!isNew && !perOrder && (
          <div style={section}>
            <p style={sectionTitle}>Comes with</p>
            {(f.products ?? []).length === 0 && <span style={small}>No products yet. Find one below.</span>}
            {(f.products ?? []).map((p) => (
              <div key={p.productId} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <Photo src={p.imageUrl} size={32} />
                <span style={{ flex: 1, fontSize: "13px" }}>{p.title}</span>
                {canManage && (
                  <button
                    type="button"
                    style={{ ...linkBtn, color: "#b42318", fontSize: "13px" }}
                    onClick={() => link.submit({ intent: "detach", id: String(f.id), productId: p.productId }, { method: "post" })}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {canManage && (
              <>
                <input type="search" value={q} onChange={(e) => find(e.target.value)} placeholder="Find a product by title or SKU" style={{ ...input, width: "100%" }} />
                {search.state !== "idle" && <span style={small}>Searching…</span>}
                {results.map((p) => (
                  <div key={p.productId} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                    <Photo src={p.imageUrl} size={32} />
                    <span style={{ flex: 1, fontSize: "13px" }}>{p.title}</span>
                    {attached.has(p.productId) ? (
                      <span style={small}>Added</span>
                    ) : (
                      <button
                        type="button"
                        style={{ ...linkBtn, fontSize: "13px", fontWeight: 600 }}
                        onClick={() => link.submit({ intent: "attach", id: String(f.id), productIds: JSON.stringify([p.productId]) }, { method: "post" })}
                      >
                        Add
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {!isNew && (f.recent ?? []).length > 0 && (
          <div style={section}>
            <p style={sectionTitle}>Latest orders</p>
            {f.recent.map((g, i) => (
              <div key={i} style={{ fontSize: "13px" }}>
                {g.orderName} · {g.quantity} given <span style={small}>· {new Date(g.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        )}

        {!isNew && canManage && (
          <div style={{ ...section, borderBottom: 0 }}>
            {confirmDelete ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                Delete this freebie? It comes off the product pages. Orders that already have it keep it in their box.
                <span style={{ display: "flex", gap: "6px" }}>
                  <s-button tone="critical" onClick={() => remove.submit({ intent: "delete", id: String(f.id) }, { method: "post" })}>
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
                  Delete freebie
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
              {isNew ? (gift ? (perOrder ? "Create" : "Create, then add products") : perOrder ? "Create, then add a photo" : "Create, then add a photo and products") : "Save"}
            </s-button>
          )}
        </div>
      </footer>
    </>
  );
}
