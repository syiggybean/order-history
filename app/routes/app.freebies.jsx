import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { Flyout, useFlyoutClose } from "../components/Flyout";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { searchProducts } from "../preorder-windows.server";
import { FreebieError, attachProducts, deleteFreebie, detachProduct, listFreebies, saveFreebie, setImage } from "../freebies.server";

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
        },
        user,
      );
      return { intent, ok: true, id: f.id, created: !id };
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
  if (!f.products.length) return <span style={pill("#fff1e3", "#8a4b00")}>No products yet</span>;
  return <span style={pill("#e3f5e8", "#0c5132")}>Showing</span>;
}

export default function Freebies() {
  const data = useLoaderData();
  const [openId, setOpenId] = useState(null); // freebie id, or "new"
  if (data.noAccess) return <NoAccess />;
  const { freebies, canManage } = data;
  const open = openId === "new" ? { id: null } : freebies.find((f) => f.id === openId);

  return (
    <s-page heading="Freebies">
      {open && (
        <Flyout
          key={open.id ?? "new"}
          onClose={() => setOpenId(null)}
          label={open.id ? `Freebie: ${open.title}` : "New freebie"}
          title={open.id ? (canManage ? "Edit freebie" : "Freebie") : "New freebie"}
          width={480}
          bodyStyle={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          <Editor f={open} canManage={canManage} onCreated={(id) => setOpenId(id)} />
        </Flyout>
      )}
      <s-section>
        <s-paragraph>
          A free gift that comes with a product. While it's on and has stock, the product page shows it with its photo and description (add the
          “Freebie” block to the product template in the theme editor). Every unit bought gets one while stock lasts, and it's added to the order's
          box: on the pick list, the packing screen and the packing slip. A cancelled order puts its freebies back.
        </s-paragraph>
        {canManage && (
          <div style={{ marginTop: "10px" }}>
            <s-button variant="primary" onClick={() => setOpenId("new")}>
              New freebie
            </s-button>
          </div>
        )}
      </s-section>
      <s-section heading={`Freebies (${freebies.length})`}>
        {freebies.length === 0 ? (
          <s-paragraph>No freebies yet.{canManage ? " Choose New freebie to make one." : ""}</s-paragraph>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "12px" }}>
            {freebies.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setOpenId(f.id)}
                style={{
                  appearance: "none",
                  textAlign: "left",
                  font: "inherit",
                  cursor: "pointer",
                  border: "1px solid #e3e3e3",
                  borderRadius: "12px",
                  background: "#fff",
                  padding: "12px",
                  display: "flex",
                  gap: "12px",
                  alignItems: "flex-start",
                }}
              >
                <Photo src={f.imageUrl} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
                  <span style={{ display: "flex", gap: "6px", alignItems: "center", justifyContent: "space-between" }}>
                    <strong style={{ fontSize: "14px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title}</strong>
                    <Status f={f} />
                  </span>
                  <span style={small}>
                    {f.stock.toLocaleString()} left · {f.given.toLocaleString()} given
                  </span>
                  <span style={{ ...small, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.products.length ? `With ${f.products.map((p) => p.title).join(", ")}` : "Not attached to a product"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
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
    save.submit({ intent: "save", ...(f.id ? { id: String(f.id) } : {}), title, description, stock, sku, barcode, active: String(active) }, { method: "post" });
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
                  <span>{f.imageUrl ? "Replace the photo" : "Add a photo"}</span>
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => upload(e.target.files?.[0])} />
                  <span style={small}>{image.state !== "idle" ? "Uploading…" : "JPEG, PNG, WebP or GIF, up to 4 MB. Shoppers can tap it to see it big."}</span>
                </label>
              )}
            </div>
          </div>
        )}

        <div style={section}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Name
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Exclusive acrylic stand" style={input} disabled={!canManage} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
            Description (shown on the product page)
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} style={{ ...input, resize: "vertical" }} disabled={!canManage} />
          </label>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              Left to give away
              <input type="number" min="0" step="1" value={stock} onChange={(e) => setStock(e.target.value)} style={{ ...input, width: "130px" }} disabled={!canManage} />
            </label>
            {!isNew && <div style={{ ...small, alignSelf: "flex-end", paddingBottom: "8px" }}>{f.given.toLocaleString()} given so far</div>}
          </div>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px" }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={!canManage} />
            On (shown on product pages and given with orders while there's stock)
          </label>
        </div>

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

        {!isNew && (
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
              {isNew ? "Create, then add a photo and products" : "Save"}
            </s-button>
          )}
        </div>
      </footer>
    </>
  );
}
