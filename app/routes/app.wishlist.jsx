import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { ProductLink, QuickView } from "../components/QuickView";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { refreshReportProducts, saveWishSettings, wishlistMetrics, wishlistReport } from "../wishlist.server";

const PERIODS = [7, 30, 90];

// "Wishlists": what customers are saving most, and the wishlist emails.

export const loader = async ({ request }) => {
  const { admin, session, user, noAccess } = await loadWithAccess(request, "wishlist", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const asked = Number(new URL(request.url).searchParams.get("days"));
  const days = PERIODS.includes(asked) ? asked : 30;
  let report = await wishlistReport(shop, { days });
  // Products we haven't read yet: read them now so the table has names.
  // Otherwise refresh stale ones in the background.
  if (report.rows.some((r) => !r.title && !r.missing)) {
    try {
      await refreshReportProducts(shop, admin);
      report = await wishlistReport(shop, { days });
    } catch (e) {
      console.error("[wishlist] report refresh:", errorMessage(e));
    }
  } else {
    refreshReportProducts(shop, admin).catch((e) => console.error("[wishlist] report refresh:", errorMessage(e)));
  }
  const handle = shop.replace(/\.myshopify\.com$/, "");
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return {
    ...report,
    metrics: await wishlistMetrics(shop, { days }),
    shopAdmin: `https://admin.shopify.com/store/${handle}`,
    embedUrl: `https://admin.shopify.com/store/${handle}/themes/current/editor?context=apps${apiKey ? `&activateAppId=${apiKey}/wishlist-embed` : ""}`,
    canManage: can(user, "wishlist", "manage"),
    canEditDates: can(user, "preorders", "manage"),
  };
};

const NEEDS = { refresh: "view", settings: "manage" };

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const need = NEEDS[intent] ?? "manage";
  if (!can(user, "wishlist", need)) return { intent, ...denied("wishlist", need) };
  try {
    if (intent === "refresh") {
      const r = await refreshReportProducts(session.shop, admin, { force: true });
      return { intent, ok: true, refreshed: r.refreshed, restocked: r.restocked.length };
    }
    if (intent === "settings") {
      await saveWishSettings(session.shop, {
        restockEmails: form.get("restockEmails") === "1",
        preorderEmails: form.get("preorderEmails") === "1",
        minStock: form.get("minStock"),
        cooldownDays: form.get("cooldownDays"),
      });
      return { intent, ok: true };
    }
  } catch (e) {
    return { intent, error: errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "middle" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1 };
const num = { ...cell, textAlign: "right", whiteSpace: "nowrap" };
const scroll = { maxHeight: "640px", overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };
const muted = { color: "#616161", fontSize: "12px" };
const input = { padding: "4px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit" };
const pill = (bg, fg) => ({ display: "inline-block", padding: "2px 8px", borderRadius: "999px", fontSize: "12px", background: bg, color: fg, whiteSpace: "nowrap" });

function Stock({ r }) {
  if (r.missing) return <span style={pill("#f1f1f1", "#616161")}>Deleted</span>;
  if (r.status && r.status !== "ACTIVE") return <span style={pill("#f1f1f1", "#616161")}>{r.status === "DRAFT" ? "Draft" : "Archived"}</span>;
  const parts = [];
  if (r.preorder) parts.push(<span key="p" style={pill("#ffe4ec", "#9e1c45")}>Pre-order</span>);
  if (!r.tracked) parts.push(<span key="t" style={pill("#f1f1f1", "#616161")}>Not tracked</span>);
  else if (r.stock == null) parts.push(<span key="u" style={muted}>—</span>);
  else if (r.inStock) parts.push(<span key="i" style={pill("#e3f5e1", "#1a5e20")}>{r.stock.toLocaleString()} in stock</span>);
  else parts.push(<span key="o" style={pill("#fde7e7", "#b42318")}>Out of stock{r.stock < 0 ? ` (${r.stock})` : ""}</span>);
  return <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>{parts}</span>;
}

function Stat({ label, value, text, note }) {
  return (
    <div style={{ flex: "1 1 160px", padding: "14px 16px", border: "1px solid #e3e3e3", borderRadius: "10px", background: "#fff" }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: "24px", fontWeight: 700, marginTop: "4px" }}>{text ?? value.toLocaleString()}</div>
      {note && <div style={muted}>{note}</div>}
    </div>
  );
}

const money = (n, currency) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD", maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(n || 0);
const pct = (r) => (r == null ? "—" : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
const BAR = "#2c6ecb";

// One measure per day as thin bars, with a hover label on each day
function DayBars({ title, series, field, total }) {
  const [hover, setHover] = useState(null);
  const W = 560;
  const H = 120;
  const max = Math.max(1, ...series.map((d) => d[field]));
  const step = W / series.length;
  const bw = Math.max(2, Math.min(18, step - 2));
  const label = (day) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const h = hover != null ? series[hover] : null;
  return (
    <div style={{ flex: "1 1 320px", minWidth: 0, padding: "14px 16px", border: "1px solid #e3e3e3", borderRadius: "10px", background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
        <strong style={{ fontSize: "13px" }}>{title}</strong>
        <span style={muted}>{h ? `${label(h.day)}: ${h[field].toLocaleString()}` : `${total.toLocaleString()} total`}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} width="100%" role="img" aria-label={`${title}, ${total} total`} style={{ display: "block", marginTop: "8px" }} onMouseLeave={() => setHover(null)}>
        <line x1="0" x2={W} y1={H} y2={H} stroke="#e3e3e3" />
        {series.map((d, i) => {
          const bh = d[field] ? Math.max(3, (d[field] / max) * (H - 6)) : 0;
          const x = i * step + (step - bw) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y="0" width={step} height={H} fill="transparent" />
              {bh > 0 && <rect x={x} y={H - bh} width={bw} height={bh} rx={Math.min(3, bw / 2)} fill={BAR} opacity={hover == null || hover === i ? 1 : 0.45} />}
              <title>{`${label(d.day)}: ${d[field]}`}</title>
            </g>
          );
        })}
        <text x="0" y={H + 14} fontSize="11" fill="#616161">{label(series[0].day)}</text>
        <text x={W} y={H + 14} fontSize="11" fill="#616161" textAnchor="end">{label(series[series.length - 1].day)}</text>
      </svg>
    </div>
  );
}

function EmailTable({ emails, currency }) {
  const rows = [emails.restock, emails.preorder, emails.total];
  return (
    <div style={{ overflowX: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={head}>Email</th>
            <th style={{ ...head, textAlign: "right" }}>Sent</th>
            <th style={{ ...head, textAlign: "right" }}>Opened</th>
            <th style={{ ...head, textAlign: "right" }}>Clicked</th>
            <th style={{ ...head, textAlign: "right" }}>Orders</th>
            <th style={{ ...head, textAlign: "right" }}>Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.label} style={i === rows.length - 1 ? { fontWeight: 600 } : undefined}>
              <td style={cell}>{r.label}</td>
              <td style={num}>{r.sent.toLocaleString()}</td>
              <td style={num}>
                {r.opened.toLocaleString()} <span style={muted}>{pct(r.sent ? r.opened / r.sent : null)}</span>
              </td>
              <td style={num}>
                {r.clicked.toLocaleString()} <span style={muted}>{pct(r.sent ? r.clicked / r.sent : null)}</span>
              </td>
              <td style={num}>{r.orders.toLocaleString()}</td>
              <td style={num}>{money(r.revenue, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Metrics({ m, setDays }) {
  return (
    <s-section heading="Performance">
      <div style={{ display: "flex", gap: "6px", marginBottom: "12px", flexWrap: "wrap" }}>
        {PERIODS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            aria-pressed={m.days === d}
            style={{
              padding: "5px 12px",
              borderRadius: "999px",
              border: "1px solid #c9c9c9",
              background: m.days === d ? "#303030" : "#fff",
              color: m.days === d ? "#fff" : "#303030",
              font: "inherit",
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            Last {d} days
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
        <Stat label="Saves" value={m.saves} note={`by ${m.savers.toLocaleString()} customer${m.savers === 1 ? "" : "s"} · ${m.removes.toLocaleString()} removed`} />
        <Stat label="Bought after saving" value={m.purchases} note={`${m.orders.toLocaleString()} order${m.orders === 1 ? "" : "s"} · ${m.buyers.toLocaleString()} customer${m.buyers === 1 ? "" : "s"}`} />
        <Stat label="Revenue from saved items" text={money(m.revenue, m.currency)} note={m.avgDaysToBuy != null ? `bought ${m.avgDaysToBuy.toFixed(1)} days after saving, on average` : "no purchases yet"} />
        <Stat label="Saves that turned into a sale" text={pct(m.saveToBuy)} note="of products saved in this period" />
      </div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginTop: "12px" }}>
        <DayBars title="Saves per day" series={m.series} field="saves" total={m.saves} />
        <DayBars title="Saved items bought per day" series={m.series} field="purchases" total={m.purchases} />
      </div>
      <div style={{ marginTop: "16px" }}>
        <div style={{ fontWeight: 600, marginBottom: "6px" }}>Wishlist emails</div>
        <EmailTable emails={m.emails} currency={m.currency} />
        <div style={{ ...muted, marginTop: "6px" }}>
          An order counts for an email if the customer bought that product within 14 days of it being sent. Pre-order emails here are only the
          ones sent to wishlisters; sign-ups are on Pre-order countdowns.
        </div>
      </div>
    </s-section>
  );
}

function fmtDate(s) {
  return s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
}

function EmailSettings({ settings, canManage }) {
  const fetcher = useFetcher();
  const [restock, setRestock] = useState(settings.restockEmails);
  const [preorder, setPreorder] = useState(settings.preorderEmails);
  const [minStock, setMinStock] = useState(String(settings.minStock));
  const [cooldown, setCooldown] = useState(String(settings.cooldownDays));
  useEffect(() => {
    setRestock(settings.restockEmails);
    setPreorder(settings.preorderEmails);
    setMinStock(String(settings.minStock));
    setCooldown(String(settings.cooldownDays));
  }, [settings.restockEmails, settings.preorderEmails, settings.minStock, settings.cooldownDays]);
  const dirty =
    restock !== settings.restockEmails ||
    preorder !== settings.preorderEmails ||
    minStock !== String(settings.minStock) ||
    cooldown !== String(settings.cooldownDays);
  const row = { display: "flex", gap: "10px", alignItems: "flex-start", flexWrap: "wrap" };
  const saved = fetcher.state === "idle" && fetcher.data?.intent === "settings";
  return (
    <s-section heading="Wishlist emails">
      <s-paragraph>
        <span style={muted}>
          Sent from the same mailbox as the pre-order emails (set up on Pre-order countdowns), with the same open/click tracking and unsubscribe link.
          Customers can turn them off on their wishlist page.
        </span>
      </s-paragraph>
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "10px" }}>
        <label style={row}>
          <input type="checkbox" checked={restock} disabled={!canManage} onChange={(e) => setRestock(e.target.checked)} />
          <span>
            <strong>Back in stock:</strong> email wishlisters when a product goes from out of stock to at least{" "}
            <input
              type="number"
              min="1"
              value={minStock}
              disabled={!canManage || !restock}
              onChange={(e) => setMinStock(e.target.value)}
              style={{ ...input, width: "70px" }}
              aria-label="Minimum stock"
            />{" "}
            available, at most once every{" "}
            <input
              type="number"
              min="0"
              max="365"
              value={cooldown}
              disabled={!canManage || !restock}
              onChange={(e) => setCooldown(e.target.value)}
              style={{ ...input, width: "60px" }}
              aria-label="Days between emails"
            />{" "}
            days per product.
            <div style={muted}>Pre-order products (GT tag, a future release date, or a countdown) never get these; they get the pre-order emails below.</div>
          </span>
        </label>
        <label style={row}>
          <input type="checkbox" checked={preorder} disabled={!canManage} onChange={(e) => setPreorder(e.target.checked)} />
          <span>
            <strong>Pre-orders:</strong> wishlisters also get a product's countdown emails (pre-orders open, more available, closing soon), just like people who
            signed up for them.
          </span>
        </label>
        {canManage && (
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <s-button
              variant="primary"
              onClick={() =>
                fetcher.submit(
                  { intent: "settings", restockEmails: restock ? "1" : "", preorderEmails: preorder ? "1" : "", minStock, cooldownDays: cooldown },
                  { method: "post" },
                )
              }
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
              {...(!dirty ? { disabled: true } : {})}
            >
              Save
            </s-button>
            {saved && fetcher.data?.ok && !dirty && <span style={{ ...muted, color: "#1a5e20" }}>Saved</span>}
            {fetcher.data?.error && <span style={{ ...muted, color: "#b42318" }}>{fetcher.data.error}</span>}
          </div>
        )}
      </div>
    </s-section>
  );
}

export default function Wishlists() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Wishlists" /> : <WishlistsPage />;
}

function WishlistsPage() {
  const { totals, rows, settings, shopAdmin, embedUrl, canManage, canEditDates, metrics } = useLoaderData();
  const [, setSearchParams] = useSearchParams();
  const refresher = useFetcher();
  const revalidator = useRevalidator();
  const [quickView, setQuickView] = useState(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (refresher.state === "idle" && refresher.data?.intent === "refresh" && refresher.data.ok) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresher.state, refresher.data]);

  const q = filter.trim().toLowerCase();
  const shown = q ? rows.filter((r) => (r.title ?? "").toLowerCase().includes(q)) : rows;

  return (
    <s-page heading="Wishlists">
      <s-section>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Stat label="Customers with a wishlist" value={totals.customers} />
          <Stat label="Products saved" value={totals.items} note="across all wishlists" />
          <Stat label="Shared wishlists" value={metrics.sharing.lists} note={`${metrics.sharing.views.toLocaleString()} link views`} />
          <Stat label="Back-in-stock emails sent" value={totals.restockSent} note="all time" />
        </div>
      </s-section>

      <Metrics m={metrics} setDays={(d) => setSearchParams({ days: String(d) })} />

      <s-section heading="Most wished">
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
          <input type="search" placeholder="Filter by product" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ ...input, minWidth: "220px" }} />
          <s-button onClick={() => refresher.submit({ intent: "refresh" }, { method: "post" })} {...(refresher.state !== "idle" ? { loading: true } : {})}>
            Refresh stock
          </s-button>
          {refresher.data?.error && <span style={{ ...muted, color: "#b42318" }}>{refresher.data.error}</span>}
          {refresher.data?.ok && refresher.state === "idle" && (
            <span style={muted}>
              Updated {refresher.data.refreshed} product{refresher.data.refreshed === 1 ? "" : "s"}
              {refresher.data.restocked ? ` · ${refresher.data.restocked} back in stock, emails queued` : ""}
            </span>
          )}
        </div>
        {!rows.length ? (
          <s-paragraph>No one has saved anything yet. Once the Wishlist app embed is on in your theme, saved products show up here.</s-paragraph>
        ) : (
          <div style={scroll}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ ...head, width: "36px" }}>#</th>
                  <th style={head}>Product</th>
                  <th style={{ ...head, textAlign: "right" }}>Wishlists</th>
                  <th style={{ ...head, textAlign: "right" }}>Last {totals.days} days</th>
                  <th style={head}>Stock</th>
                  <th style={{ ...head, textAlign: "right" }}>Bought after saving</th>
                  <th style={{ ...head, textAlign: "right" }}>Back-in-stock emails</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.productId}>
                    <td style={{ ...cell, ...muted }}>{rows.indexOf(r) + 1}</td>
                    <td style={cell}>
                      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        {r.imageUrl ? (
                          <img src={`${r.imageUrl}${r.imageUrl.includes("?") ? "&" : "?"}width=80`} alt="" width="40" height="40" style={{ objectFit: "cover", borderRadius: "6px", flex: "none" }} />
                        ) : (
                          <span style={{ width: 40, height: 40, borderRadius: 6, background: "#f1f1f1", flex: "none" }} />
                        )}
                        <span>
                          {r.missing ? (
                            <span style={muted}>Deleted product</span>
                          ) : (
                            <ProductLink id={r.productId} title={r.title ?? r.productId} onOpen={setQuickView} />
                          )}
                          {!r.missing && (
                            <div style={muted}>
                              <a href={`${shopAdmin}/products/${r.productId.split("/").pop()}`} target="_blank" rel="noreferrer" style={{ color: "#616161" }}>
                                Open in Shopify ↗
                              </a>
                            </div>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ ...num, fontWeight: 700 }}>{r.wished.toLocaleString()}</td>
                    <td style={num}>{r.recent ? `+${r.recent.toLocaleString()}` : "—"}</td>
                    <td style={cell}>
                      <Stock r={r} />
                    </td>
                    <td style={num}>
                      {r.purchased ? r.purchased.toLocaleString() : "—"}
                    </td>
                    <td style={num}>
                      {r.restockEmails ? r.restockEmails.toLocaleString() : "—"}
                      {r.lastRestock && <div style={muted}>last {fmtDate(r.lastRestock)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ ...muted, marginTop: "8px" }}>Top {rows.length} products. Stock updates on its own when it changes in Shopify.</div>
      </s-section>

      <EmailSettings settings={settings} canManage={canManage} />

      <s-section heading="On your store">
        <s-paragraph>
          The hearts and the header icon come from the <strong>Wishlist</strong> app embed. Turn it on in the theme editor under App embeds, then save.
          The heart color and where things go are set there too.
        </s-paragraph>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", margin: "10px 0" }}>
          <s-button href={embedUrl} target="_blank">
            Open theme editor
          </s-button>
        </div>
        <s-paragraph>
          <span style={muted}>
            The wishlist page is at /apps/purchase-history/wishlist on your store. To give it a shorter address, add a URL redirect from /wishlist to it under
            Online Store → Navigation → URL redirects. Optional: add the "Wishlist heart" block to the product page to put the heart somewhere other than after
            the name.
          </span>
        </s-paragraph>
      </s-section>

      {quickView && <QuickView productId={quickView} canEdit={canEditDates} onClose={() => setQuickView(null)} onSaved={() => revalidator.revalidate()} />}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
