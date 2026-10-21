import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { BLOCK_TAG, BlockError, blockList, customerBlockStatus, setBlock, unblockAddress } from "../blocklist.server";

// Blocked customers and addresses. Customers are blocked from their page in
// Shopify admin (More actions > Block customer); this lists them and lets
// you unblock a customer, an address, or both.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "blocklist", "view");
  if (noAccess) return { noAccess: true };
  const handle = session.shop.replace(/\.myshopify\.com$/, "");
  const apiKey = process.env.SHOPIFY_API_KEY ?? "";
  return {
    ...(await blockList(session.shop)),
    tag: BLOCK_TAG,
    shopAdmin: `https://admin.shopify.com/store/${handle}`,
    embedUrl: `https://admin.shopify.com/store/${handle}/themes/current/editor?context=apps${apiKey ? `&activateAppId=${apiKey}/blocked-embed` : ""}`,
    canManage: can(user, "blocklist", "manage"),
  };
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "blocklist", "manage")) return denied("blocklist", "manage");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const shop = session.shop;
  try {
    if (intent === "unblockCustomer" || intent === "unblockBoth" || intent === "reblock") {
      const customerId = String(form.get("customerId"));
      const status = await customerBlockStatus(shop, admin, customerId);
      const addresses = Object.fromEntries(status.addresses.map((a) => [a.key, intent === "unblockBoth" ? false : a.blocked]));
      await setBlock(shop, admin, customerId, { customer: intent === "reblock", addresses }, user);
      return { intent, ok: true };
    }
    if (intent === "unblockAddress") {
      await unblockAddress(shop, form.get("id"), user);
      return { intent, ok: true };
    }
  } catch (e) {
    return { intent, error: e instanceof BlockError ? e.message : errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap" };
const muted = { color: "#616161", fontSize: "12px" };
const pill = (bg, fg) => ({ display: "inline-block", padding: "1px 8px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" });
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

function Act({ intent, fields, label, tone, canManage }) {
  const f = useFetcher();
  const revalidator = useRevalidator();
  useEffect(() => {
    if (f.state === "idle" && f.data?.ok) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.state, f.data]);
  if (!canManage) return null;
  return (
    <>
      <s-button variant="tertiary" tone={tone} onClick={() => f.submit({ intent, ...fields }, { method: "post" })} {...(f.state !== "idle" ? { loading: true } : {})}>
        {label}
      </s-button>
      {f.data?.error && <div style={{ ...muted, color: "#b42318" }}>{f.data.error}</div>}
    </>
  );
}

export default function Blocked() {
  const data = useLoaderData();
  return data.noAccess ? <NoAccess feature="Blocked customers" /> : <BlockedPage />;
}

function BlockedPage() {
  const { customers, addresses, orders, shopAdmin, embedUrl, canManage, tag } = useLoaderData();
  const [showAll, setShowAll] = useState(false);
  const blockedCustomers = customers.filter((c) => c.blocked || c.addresses.some((a) => a.blocked));
  const shownCustomers = showAll ? customers : blockedCustomers;
  const otherAddresses = addresses.filter((a) => a.blocked && !customers.some((c) => c.customerId === a.customerId));
  const orderNum = (id) => id.split("/").pop();
  return (
    <s-page heading="Blocked customers">
      <s-section>
        <s-paragraph>
          Block a customer from their page in Shopify admin: <strong>More actions → Block customer</strong>. Their shipping addresses are blocked too, unless
          you untick them. Blocked customers get the "{tag}" tag; with the <strong>Blocked customers</strong> app embed on, they see a red banner, can't add
          to cart and can't open the cart.
        </s-paragraph>
        <s-paragraph>
          <span style={muted}>
            Shopify doesn't let this app stop a checkout on your plan, so an order that still gets through (for example as a guest, or to a blocked address)
            is put on hold in Shopify, tagged "Blocked customer" and flagged on Shipping → Review.
          </span>
        </s-paragraph>
        <div style={{ marginTop: "8px" }}>
          <s-button href={embedUrl} target="_blank">
            Open theme editor
          </s-button>
        </div>
      </s-section>

      <s-section heading={`Customers (${blockedCustomers.length} blocked)`}>
        {customers.length > blockedCustomers.length && (
          <label style={{ display: "flex", gap: "6px", alignItems: "center", marginBottom: "8px", fontSize: "13px" }}>
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show unblocked too
          </label>
        )}
        {shownCustomers.length === 0 ? (
          <s-paragraph>Nobody is blocked.</s-paragraph>
        ) : (
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={head}>Customer</th>
                  <th style={head}>Status</th>
                  <th style={head}>Addresses</th>
                  <th style={head}>Reason</th>
                  <th style={head} />
                </tr>
              </thead>
              <tbody>
                {shownCustomers.map((c) => (
                  <tr key={c.customerId}>
                    <td style={cell}>
                      <a href={`${shopAdmin}/customers/${c.customerId}`} target="_blank" rel="noreferrer" style={{ color: "#005bd3", fontWeight: 600 }}>
                        {c.name ?? c.email ?? `Customer ${c.customerId}`}
                      </a>
                      <div style={muted}>{c.email}</div>
                    </td>
                    <td style={cell}>
                      {c.blocked ? <span style={pill("#fde7e9", "#8e1f0b")}>Blocked</span> : <span style={pill("#f1f1f1", "#616161")}>Can shop</span>}
                      <div style={muted}>
                        {c.blocked
                          ? `${fmtDate(c.blockedAt)}${c.blockedBy ? ` · ${c.blockedBy}` : ""}`
                          : c.unblockedAt
                            ? `Unblocked ${fmtDate(c.unblockedAt)}${c.unblockedBy ? ` · ${c.unblockedBy}` : ""}`
                            : ""}
                      </div>
                      {c.tagError && <div style={{ ...muted, color: "#b42318" }}>Tag problem: {c.tagError}</div>}
                    </td>
                    <td style={cell}>
                      {c.addresses.length === 0 && <span style={muted}>—</span>}
                      {c.addresses.map((a) => (
                        <div key={a.id} style={{ marginBottom: "4px" }}>
                          <span style={{ textDecoration: a.blocked ? "none" : "line-through", color: a.blocked ? "#303030" : "#8a8a8a" }}>{a.display}</span>{" "}
                          {a.blocked && <Act intent="unblockAddress" fields={{ id: String(a.id) }} label="Unblock" canManage={canManage} />}
                        </div>
                      ))}
                    </td>
                    <td style={{ ...cell, maxWidth: "260px" }}>{c.reason ?? <span style={muted}>—</span>}</td>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>
                      {c.blocked ? (
                        <>
                          <Act intent="unblockCustomer" fields={{ customerId: c.customerId }} label="Unblock customer" canManage={canManage} />
                          {c.addresses.some((a) => a.blocked) && (
                            <Act intent="unblockBoth" fields={{ customerId: c.customerId }} label="Unblock customer and addresses" canManage={canManage} />
                          )}
                        </>
                      ) : (
                        <Act intent="reblock" fields={{ customerId: c.customerId }} label="Block again" tone="critical" canManage={canManage} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {otherAddresses.length > 0 && (
        <s-section heading="Other blocked addresses">
          {otherAddresses.map((a) => (
            <div key={a.id} style={{ padding: "6px 0", borderBottom: "1px solid #eee" }}>
              {a.display} <span style={muted}>· {fmtDate(a.blockedAt)}</span> <Act intent="unblockAddress" fields={{ id: String(a.id) }} label="Unblock" canManage={canManage} />
            </div>
          ))}
        </s-section>
      )}

      <s-section heading="Orders caught">
        {orders.length === 0 ? (
          <s-paragraph>None yet.</s-paragraph>
        ) : (
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr>
                  <th style={head}>Order</th>
                  <th style={head}>Why</th>
                  <th style={head}>In Shopify</th>
                  <th style={head}>When</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td style={cell}>
                      <a href={`${shopAdmin}/orders/${orderNum(o.orderId)}`} target="_blank" rel="noreferrer" style={{ color: "#005bd3", fontWeight: 600 }}>
                        {o.orderName ?? orderNum(o.orderId)}
                      </a>
                    </td>
                    <td style={cell}>{o.why.split(",").map((w) => (w === "customer" ? "Blocked customer" : "Blocked address")).join(" + ")}</td>
                    <td style={cell}>
                      {o.held ? <span style={pill("#fff4d6", "#7a4f01")}>On hold</span> : <span style={pill("#f1f1f1", "#616161")}>Not held</span>}
                      {o.error && <div style={{ ...muted, color: "#b42318" }}>{o.error}</div>}
                    </td>
                    <td style={cell}>{fmtDate(o.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
