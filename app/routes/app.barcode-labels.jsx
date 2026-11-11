import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { staffKeyOf } from "../shipping.server";
import { jobStatus, listStations, myStationId, rememberStation, PrintError } from "../print.server";
import { getItem, printBarcodeLabels, searchItems } from "../barcode-labels.server";
import { BarcodeLabelError, CONFIRM_OVER, MAX_LABELS, resolveQuantity } from "../barcode-labels";
import { PrintNote, PrintProvider, ThisComputer, useAgentPrint, usePrinterFor, usePrinting } from "../components/shipping/Printing";

// Barcode labels: find a product in Shopify and print 2 × 1 barcode labels on
// this packing computer's Zebra. Read only: nothing in Shopify changes.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "barcodeLabels", "view");
  if (noAccess) return { noAccess: true };
  return {
    canPrint: can(user, "barcodeLabels", "print"),
    printing: {
      stations: await listStations(session.shop),
      myStationId: await myStationId(session.shop, staffKeyOf(user)),
    },
  };
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "barcodeLabels", "view")) return denied("barcodeLabels", "view");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const shop = session.shop;
  try {
    if (intent === "search") return { intent, q: String(form.get("q") ?? ""), items: await searchItems(admin, form.get("q")) };
    if (intent === "item") return { intent, item: await getItem(admin, String(form.get("id") ?? "")) };
    if (intent === "printJobs") return { intent, jobs: await jobStatus(shop, JSON.parse(String(form.get("ids") ?? "[]"))) };
    if (intent === "setMyStation") return (await rememberStation(shop, staffKeyOf(user), Number(form.get("stationId")) || null), { intent, ok: true });
    if (intent === "agentPrint") {
      if (!can(user, "barcodeLabels", "print")) return denied("barcodeLabels", "print");
      const r = await printBarcodeLabels(
        shop,
        admin,
        {
          variantId: String(form.get("variantId") ?? ""),
          mode: String(form.get("mode") ?? ""),
          custom: String(form.get("custom") ?? ""),
          confirmed: form.get("confirmed") === "1",
          stationId: form.get("stationId"),
        },
        user,
        staffKeyOf(user),
      );
      // Shopify's count changed since the page showed it and it's now a big print
      if (r.needsConfirm) return { intent, needsConfirm: true, quantity: r.quantity, item: r.item, error: `That's now ${r.quantity.toLocaleString("en-US")} labels. Check the number and print again.` };
      return { intent, ...r };
    }
  } catch (e) {
    if (!(e instanceof BarcodeLabelError) && !(e instanceof PrintError)) console.error(`[barcode-labels] ${intent}:`, e);
    return { intent, error: e instanceof BarcodeLabelError || e instanceof PrintError ? e.message : errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const cell = { padding: "8px 10px", borderBottom: "1px solid #e3e3e3", textAlign: "left", verticalAlign: "top" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", whiteSpace: "nowrap" };
const muted = { color: "#616161", fontSize: "12px" };
const input = { padding: "7px 10px", border: "1px solid #c9c9c9", borderRadius: "8px", font: "inherit", fontSize: "14px" };
const SYMBOLOGY = { upca: "UPC-A", ean13: "EAN-13", ean8: "EAN-8", code128: "Code 128" };

export default function BarcodeLabels() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Barcode labels" />;
  return (
    <PrintProvider printing={data.printing}>
      <Page canPrint={data.canPrint} />
    </PrintProvider>
  );
}

function Page({ canPrint }) {
  const search = useFetcher();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(null);
  const box = useRef(null);
  useEffect(() => box.current?.focus(), []);
  const items = search.data?.items ?? null;
  const run = (e) => {
    e?.preventDefault();
    if (!q.trim()) return;
    search.submit({ intent: "search", q: q.trim() }, { method: "post" });
  };
  // A scanned barcode that matches exactly one item opens it straight away
  useEffect(() => {
    const list = search.data?.items;
    if (search.state !== "idle" || !list) return;
    const exact = list.filter((i) => i.barcode && i.barcode === search.data.q.trim());
    if (exact.length === 1) setPicked(exact[0].id);
  }, [search.state, search.data]);

  return (
    <s-page heading="Barcode labels">
      <s-section>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", justifyContent: "space-between" }}>
          <form onSubmit={run} style={{ display: "flex", gap: "8px", flex: "1 1 360px" }}>
            <input
              ref={box}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Scan a barcode, or search SKU or title"
              aria-label="Search"
              style={{ ...input, flex: 1 }}
            />
            <s-button variant="primary" type="submit" onClick={run} {...(search.state !== "idle" ? { loading: true } : {})}>
              Search
            </s-button>
          </form>
          <ThisComputer />
        </div>
        <div style={{ ...muted, marginTop: "8px" }}>2 × 1 inch labels print on this packing computer's Zebra. Nothing in Shopify is changed.</div>
      </s-section>

      {search.data?.error && (
        <s-section>
          <div style={{ color: "#b42318" }}>{search.data.error}</div>
        </s-section>
      )}

      {picked && <ItemPanel id={picked} canPrint={canPrint} onClose={() => setPicked(null)} />}

      {items && (
        <s-section heading={items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "No items found"}>
          {items.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
                <thead>
                  <tr>
                    <th style={head}>Item</th>
                    <th style={head}>SKU</th>
                    <th style={head}>Barcode</th>
                    <th style={{ ...head, textAlign: "right" }}>In stock</th>
                    <th style={head} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} style={i.id === picked ? { background: "#f4f8ff" } : undefined}>
                      <td style={cell}>{i.title}</td>
                      <td style={cell}>{i.sku || <span style={muted}>—</span>}</td>
                      <td style={cell}>
                        {i.barcode ? <code>{i.barcode}</code> : <span style={muted}>none</span>}
                        {i.problem && <div style={{ fontSize: "12px", color: "#b42318" }}>{i.problem}</div>}
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>{i.stock ?? "—"}</td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        <s-button onClick={() => setPicked(i.id)}>Choose</s-button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </s-section>
      )}
    </s-page>
  );
}

function ItemPanel({ id, canPrint, onClose }) {
  const load = useFetcher();
  const { station } = usePrinting();
  const target = usePrinterFor("barcode");
  const agent = useAgentPrint();
  const [mode, setMode] = useState("one");
  const [custom, setCustom] = useState("10");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    load.submit({ intent: "item", id }, { method: "post" });
    setConfirming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const item = load.data?.item?.id === id ? load.data.item : null;
  const q = item ? resolveQuantity({ mode, custom, stock: item.stock }) : null;
  const blocked = item && (item.problem || item.duplicate);

  const send = (confirmed) => {
    setConfirming(false);
    agent.print({ variantId: id, mode, custom, confirmed: confirmed ? "1" : "" });
  };
  const onPrint = () => {
    if (q?.ok && q.confirm) setConfirming(true);
    else send(false);
  };

  return (
    <s-section heading="Print labels">
      {load.data?.error && <div style={{ color: "#b42318" }}>{load.data.error}</div>}
      {!item && !load.data?.error && <div style={muted}>Loading the item from Shopify…</div>}
      {item && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "24px", alignItems: "flex-start" }}>
          <LabelPreview item={item} />
          <div style={{ display: "grid", gap: "10px", flex: "1 1 280px", fontSize: "14px" }}>
            <div>
              <strong>{item.title}</strong>
              <div style={muted}>
                {item.sku ? `SKU ${item.sku} · ` : ""}
                {item.barcode ? `${SYMBOLOGY[item.symbology] ?? "Barcode"} ${item.barcode}` : "No barcode"} · {item.stock ?? "—"} in stock
              </div>
            </div>
            {item.problem && <div style={{ color: "#b42318" }}>{item.problem}</div>}
            {item.duplicate && <div style={{ color: "#b42318" }}>Another item in Shopify has the same barcode. Fix the duplicate in Shopify before printing.</div>}
            {item.warnings?.map((w) => (
              <div key={w} style={{ color: "#8a6100", fontSize: "13px" }}>
                ⚠ {w}
              </div>
            ))}

            {!blocked && canPrint && (
              <>
                <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "6px" }}>
                  <legend style={{ fontWeight: 600, marginBottom: "4px" }}>How many</legend>
                  <label>
                    <input type="radio" checked={mode === "one"} onChange={() => setMode("one")} /> One label
                  </label>
                  <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <input type="radio" checked={mode === "custom"} onChange={() => setMode("custom")} /> Custom
                    <input
                      value={custom}
                      inputMode="numeric"
                      onFocus={() => setMode("custom")}
                      onChange={(e) => setCustom(e.target.value.replace(/[^\d]/g, ""))}
                      style={{ ...input, width: "90px", padding: "4px 8px" }}
                      aria-label="Number of labels"
                    />
                  </label>
                  <label>
                    <input type="radio" checked={mode === "stock"} onChange={() => setMode("stock")} disabled={!(item.stock > 0)} /> One per item in stock ({item.stock ?? 0})
                  </label>
                </fieldset>
                {q && !q.ok && <div style={{ color: "#b42318", fontSize: "13px" }}>{q.message}</div>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
                  {confirming ? (
                    <>
                      <span>
                        Print <strong>{q.quantity.toLocaleString("en-US")}</strong> labels?
                      </span>
                      <s-button variant="primary" onClick={() => send(true)}>
                        Yes, print {q.quantity.toLocaleString("en-US")}
                      </s-button>
                      <s-button onClick={() => setConfirming(false)}>Cancel</s-button>
                    </>
                  ) : (
                    <s-button variant="primary" onClick={onPrint} {...(!q?.ok || !target ? { disabled: true } : {})} {...(agent.busy ? { loading: true } : {})}>
                      {q?.ok ? `Print ${q.quantity.toLocaleString("en-US")} label${q.quantity === 1 ? "" : "s"}` : "Print"}
                      {target ? ` on ${target.printer}` : ""}
                    </s-button>
                  )}
                  <s-button variant="tertiary" onClick={onClose}>
                    Close
                  </s-button>
                </div>
                {!target && (
                  <div style={{ fontSize: "13px", color: "#8a6100" }}>
                    {station
                      ? `${station.name} has no barcode printer chosen. Set it in Shipping → Settings → Packing computers.`
                      : "Choose this packing computer under “Printing on” to print. Barcode labels need the MonkeyBean Print agent and the Zebra; they can't print from the browser."}
                  </div>
                )}
                <PrintNote note={agent.note} />
                <div style={muted}>
                  The item is read from Shopify again just before printing. Over {CONFIRM_OVER} labels asks first; one print is at most {MAX_LABELS.toLocaleString("en-US")}.
                </div>
              </>
            )}
            {!canPrint && <div style={muted}>You can look items up. Ask an admin for “Search + print labels” to print.</div>}
          </div>
        </div>
      )}
    </s-section>
  );
}

// What the 2 × 1 label will show (bars drawn roughly; the printer makes the real ones)
function LabelPreview({ item }) {
  const bars = [];
  const code = item.barcode || "";
  for (let i = 0; i < 46; i++) {
    const c = code.charCodeAt(i % Math.max(code.length, 1)) || 0;
    bars.push((c + i * 7) % 3 === 0 ? 1 : (c + i) % 2 === 0 ? 2 : 3);
  }
  return (
    <div
      aria-label="Label preview"
      style={{ width: "240px", height: "120px", border: "1px solid #c9c9c9", borderRadius: "6px", background: "#fff", padding: "10px 8px 6px", boxSizing: "border-box", textAlign: "center", fontFamily: "Arial, sans-serif" }}
    >
      <div style={{ fontSize: "12px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.title}</div>
      <div style={{ fontSize: "10px", color: "#303030", minHeight: "12px" }}>{item.sku}</div>
      {item.barcode && !item.problem ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", gap: "1px", height: "44px", marginTop: "4px" }}>
            {bars.map((w, i) => (
              <span key={i} style={{ width: `${w}px`, background: i % 2 ? "transparent" : "#000" }} />
            ))}
          </div>
          <div style={{ fontSize: "10px", letterSpacing: "1px" }}>{item.barcode}</div>
        </>
      ) : (
        <div style={{ marginTop: "18px", fontSize: "12px", color: "#b42318" }}>Can't print</div>
      )}
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
