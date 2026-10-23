import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { PoError } from "../po.server";
import { receivingDetail, receivingList, saveCheckIn, undoCheckIn } from "../receiving.server";
import { Err, StatusPill, box, cell, fmtDate, fmtDay, head, input, muted, num, pill } from "../components/po/ui";

// Receiving: check in what arrived against a purchase order. Counts only: stock in
// Shopify isn't changed (how check-ins should affect inventory is still to be decided).
// Permission "Receiving": View sees progress; "check in items" can count and save.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "receiving", "view");
  if (noAccess) return { noAccess: true };
  const p = new URL(request.url).searchParams;
  const canCheckIn = can(user, "receiving", "checkIn");
  const me = { name: user?.name ?? null, admin: Boolean(user?.isAdmin || user?.isOwner) };
  if (p.get("po")) {
    try {
      return { view: "po", canCheckIn, me, ...(await receivingDetail(session.shop, p.get("po"))) };
    } catch (e) {
      return { view: "missing", canCheckIn, me, error: e instanceof PoError ? e.message : "That purchase order couldn't be loaded." };
    }
  }
  const show = ["todo", "done", "all"].includes(p.get("show")) ? p.get("show") : "todo";
  return { view: "list", canCheckIn, me, ...(await receivingList(session.shop, { show, q: p.get("q") || "" })) };
};

export const action = async ({ request }) => {
  const { session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!can(user, "receiving", "checkIn")) return { intent, ...denied("receiving", "checkIn") };
  try {
    if (intent === "checkIn") {
      const r = await saveCheckIn(
        session.shop,
        form.get("id"),
        { counts: JSON.parse(String(form.get("counts") ?? "{}")), unknown: JSON.parse(String(form.get("unknown") ?? "[]")), note: form.get("note") },
        user,
      );
      return { intent, ok: true, ...r };
    }
    if (intent === "undo") return { intent, ok: true, ...(await undoCheckIn(session.shop, form.get("checkInId"), user)) };
  } catch (e) {
    if (!(e instanceof PoError)) console.error(`[receiving] ${intent}:`, e);
    return { intent, error: e instanceof PoError ? e.message : "Something went wrong. Try again." };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const CHECK_COLORS = { none: ["#f1f1f1", "#4a4a4a"], partial: ["#fff4d6", "#7a4f01"], complete: ["#e3f1df", "#1a5e20"], over: ["#fde7e9", "#8e1f0b"], mixed: ["#fde7e9", "#8e1f0b"] };
const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" };

function useGo() {
  const [, setParams] = useSearchParams();
  return (patch) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { preventScrollReset: true },
    );
}

function Progress({ checked, ordered, k }) {
  const pct = ordered ? Math.min(100, Math.round((checked / ordered) * 100)) : 0;
  const color = k === "over" || k === "mixed" ? "#d92d20" : k === "complete" ? "#29845a" : "#2c6ecb";
  return (
    <div style={{ minWidth: "120px" }}>
      <div style={{ fontSize: "12px" }}>
        {checked.toLocaleString()} of {ordered.toLocaleString()}
      </div>
      <div style={{ height: "6px", background: "#eef1f5", borderRadius: "3px", overflow: "hidden", marginTop: "3px" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
    </div>
  );
}

export default function Receiving() {
  const d = useLoaderData();
  if (d.noAccess) return <NoAccess feature="Receiving" />;
  if (d.view === "po") return <CheckIn />;
  if (d.view === "missing")
    return (
      <s-page heading="Receiving">
        <s-section>
          <s-paragraph>{d.error}</s-paragraph>
        </s-section>
      </s-page>
    );
  return <List />;
}

function List() {
  const d = useLoaderData();
  const go = useGo();
  const [q, setQ] = useState(d.q);
  const timer = useRef(null);
  return (
    <s-page heading="Receiving">
      <s-section>
        <s-paragraph>
          <span style={muted}>
            Check in deliveries against their purchase orders: scan or count what arrived. This only records what was checked in; it doesn't change stock in Shopify.
          </span>
        </s-paragraph>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center", margin: "10px 0" }}>
          {[
            ["todo", "To check in"],
            ["done", "Checked in"],
            ["all", "All, including closed"],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={d.show === k}
              onClick={() => go({ show: k === "todo" ? "" : k })}
              style={{ ...input, cursor: "pointer", borderRadius: "999px", padding: "4px 12px", fontSize: "13px", background: d.show === k ? "#303030" : "#fff", color: d.show === k ? "#fff" : "#303030" }}
            >
              {label}
            </button>
          ))}
          <input
            type="search"
            value={q}
            placeholder="PO number or supplier"
            aria-label="Find a purchase order"
            onChange={(e) => {
              setQ(e.target.value);
              clearTimeout(timer.current);
              const v = e.target.value;
              timer.current = setTimeout(() => go({ q: v.trim() }), 350);
            }}
            style={{ ...input, width: "240px", marginLeft: "auto" }}
          />
        </div>
        {d.rows.length === 0 ? (
          <s-paragraph>{d.show === "todo" ? "Nothing waiting to be checked in." : "No purchase orders here."}</s-paragraph>
        ) : (
          <div style={box}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  <th style={head}>PO</th>
                  <th style={head}>Supplier</th>
                  <th style={head}>Expected</th>
                  <th style={head}>PO status</th>
                  <th style={head}>Checked in</th>
                  <th style={head}>Last check-in</th>
                  <th style={head} />
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => {
                  const [bg, fg] = CHECK_COLORS[r.check.key];
                  return (
                    <tr key={r.id}>
                      <td style={cell}>
                        <button type="button" style={{ ...linkBtn, fontWeight: 600 }} onClick={() => go({ po: String(r.id) })}>
                          {r.poNumber}
                        </button>
                        <div style={muted}>
                          {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td style={cell}>{r.supplierName ?? "—"}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDay(r.expectedAt)}</td>
                      <td style={cell}>
                        <StatusPill status={r.status} />
                      </td>
                      <td style={cell}>
                        <Progress checked={r.check.checked} ordered={r.check.ordered} k={r.check.key} />
                        <span style={{ ...pill(bg, fg), marginTop: "4px" }}>{r.check.label}</span>
                      </td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.lastCheckIn ? fmtDate(r.lastCheckIn, true) : <span style={muted}>—</span>}</td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        <s-button variant={d.canCheckIn && d.show !== "done" ? "primary" : "secondary"} onClick={() => go({ po: String(r.id) })}>
                          {d.canCheckIn ? "Check in" : "View"}
                        </s-button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

function CheckIn() {
  const { po, check, checkIns, canCheckIn, me } = useLoaderData();
  const go = useGo();
  const saver = useFetcher();
  const revalidator = useRevalidator();
  const [counts, setCounts] = useState({});
  const [unknown, setUnknown] = useState([]);
  const [note, setNote] = useState("");
  const [scan, setScan] = useState("");
  const [msg, setMsg] = useState(null);
  const [saved, setSaved] = useState(null);
  const scanRef = useRef(null);
  const total = Object.values(counts).reduce((t, n) => t + (Number(n) || 0), 0);
  const unsaved = total > 0 || unknown.length > 0;
  const closed = po.status === "closed";
  const counting = canCheckIn && !closed;

  // Don't lose counts by leaving the page
  useEffect(() => {
    if (!unsaved) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const handled = useRef(null);
  useEffect(() => {
    const r = saver.data;
    if (saver.state !== "idle" || !r || handled.current === r) return;
    handled.current = r;
    if (r.intent === "checkIn" && r.ok) {
      setCounts({});
      setUnknown([]);
      setNote("");
      setMsg(null);
      setSaved(r);
      revalidator.revalidate();
    }
    if (r.intent === "undo" && r.ok) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver.state, saver.data]);

  const codes = (l) => [l.sku, l.supplierBarcode, l.supplierCode].filter(Boolean).map((v) => String(v).trim().toLowerCase());
  const index = useMemo(() => po.lines.map((l) => ({ l, codes: codes(l) })), [po.lines]);
  const onScan = (e) => {
    e.preventDefault();
    const raw = scan.trim();
    const c = raw.toLowerCase();
    setScan("");
    setSaved(null);
    if (!c) return;
    const hits = index.filter((x) => x.codes.includes(c)).map((x) => x.l);
    if (!hits.length) {
      setUnknown((u) => {
        const i = u.findIndex((x) => x.code.toLowerCase() === c);
        return i < 0 ? [...u, { code: raw, count: 1 }] : u.map((x, j) => (j === i ? { ...x, count: x.count + 1 } : x));
      });
      setMsg({ ok: false, text: `${raw} isn't on this PO. Noted below.` });
      return;
    }
    // Several lines with the same code: fill the first that still needs some
    const l = hits.find((x) => x.checkedIn + (Number(counts[x.id]) || 0) < x.quantity) ?? hits[0];
    const now = (Number(counts[l.id]) || 0) + 1;
    setCounts({ ...counts, [l.id]: now });
    const sofar = l.checkedIn + now;
    setMsg(sofar > l.quantity ? { warn: true, text: `${l.title}: ${sofar} — more than the ${l.quantity} ordered` } : { ok: true, text: `${l.title}: ${sofar} of ${l.quantity}` });
  };
  const bump = (l, by) => {
    setSaved(null);
    setMsg(null);
    setCounts({ ...counts, [l.id]: Math.max(0, (Number(counts[l.id]) || 0) + by) || "" });
  };
  const left = po.lines.filter((l) => l.checkedIn < l.quantity);

  return (
    <s-page heading={`Check in ${po.poNumber}`}>
      <div style={{ marginBottom: "8px" }}>
        <button type="button" style={linkBtn} onClick={() => (!unsaved || window.confirm("Leave without saving these counts?")) && go({ po: "" })}>
          ← All purchase orders
        </button>
      </div>
      <s-section>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-start", fontSize: "13px" }}>
          <div>
            <div style={muted}>Supplier</div>
            <strong>{po.supplierName ?? "—"}</strong>
          </div>
          <div>
            <div style={muted}>Expected</div>
            {fmtDay(po.expectedAt)}
          </div>
          <div>
            <div style={muted}>Ship to</div>
            {po.locationName ?? "—"}
          </div>
          <div>
            <div style={muted}>PO status</div>
            <StatusPill status={po.status} />
          </div>
          <div>
            <div style={muted}>Checked in</div>
            <Progress checked={check.checked} ordered={check.ordered} k={check.key} />
          </div>
          <span style={{ ...pill(...CHECK_COLORS[check.key]), alignSelf: "center" }}>{check.label}</span>
        </div>
        <div style={{ ...muted, marginTop: "10px" }}>Counting only: checking items in doesn't change stock in Shopify or the PO's own received numbers.</div>
        {closed && <div style={{ marginTop: "6px", color: "#7a4f01", fontSize: "13px" }}>This PO is closed, so nothing more can be checked in.</div>}
      </s-section>

      <s-section heading={counting ? "Count what arrived" : "Items"}>
        {counting && (
          <form onSubmit={onScan} style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "10px" }}>
            <input
              ref={scanRef}
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              placeholder="Scan a barcode or type a SKU"
              aria-label="Scan"
              autoComplete="off"
              autoFocus
              style={{ ...input, width: "280px", fontSize: "15px", padding: "8px 10px" }}
            />
            {left.length > 0 && (
              <s-button
                variant="tertiary"
                onClick={() => {
                  setSaved(null);
                  setCounts(Object.fromEntries(left.map((l) => [l.id, l.quantity - l.checkedIn])));
                }}
              >
                Everything that's left arrived
              </s-button>
            )}
            {unsaved && (
              <s-button
                variant="tertiary"
                onClick={() => {
                  setCounts({});
                  setUnknown([]);
                  setMsg(null);
                }}
              >
                Clear counts
              </s-button>
            )}
            {msg && <span style={{ fontWeight: 600, color: msg.ok ? "#1a5e20" : msg.warn ? "#8a6100" : "#b42318" }}>{msg.text}</span>}
          </form>
        )}
        <div style={{ ...box, maxHeight: "520px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                <th style={head}>Item</th>
                <th style={{ ...head, textAlign: "right" }}>Ordered</th>
                <th style={{ ...head, textAlign: "right" }}>Checked in</th>
                {counting && <th style={{ ...head, textAlign: "right" }}>Counting now</th>}
                <th style={{ ...head, textAlign: "right" }}>Still to come</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => {
                const now = Number(counts[l.id]) || 0;
                const after = l.checkedIn + now;
                const bg = after > l.quantity ? "#fff6f5" : after >= l.quantity ? "#f3faf1" : now ? "#f4f8ff" : undefined;
                return (
                  <tr key={l.id} style={{ background: bg }}>
                    <td style={cell}>
                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        {l.imageUrl && <img src={l.imageUrl} alt="" style={{ width: "32px", height: "32px", objectFit: "cover", borderRadius: "4px" }} />}
                        <div>
                          {l.shopifyTitle ?? l.title}
                          <div style={muted}>{[l.sku, l.supplierBarcode, l.supplierCode].filter(Boolean).join(" · ")}</div>
                        </div>
                      </div>
                    </td>
                    <td style={num}>{l.quantity}</td>
                    <td style={num}>{l.checkedIn}</td>
                    {counting && (
                      <td style={num}>
                        <span style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
                          <button type="button" onClick={() => bump(l, -1)} disabled={!now} aria-label={`One fewer ${l.title}`} style={{ ...input, padding: "2px 8px", cursor: "pointer" }}>
                            −
                          </button>
                          <input
                            value={counts[l.id] ?? ""}
                            inputMode="numeric"
                            placeholder="0"
                            onChange={(e) => {
                              setSaved(null);
                              setCounts({ ...counts, [l.id]: e.target.value.replace(/[^\d]/g, "") });
                            }}
                            style={{ ...input, width: "64px", textAlign: "right" }}
                            aria-label={`Counting now: ${l.title}`}
                          />
                          <button type="button" onClick={() => bump(l, 1)} aria-label={`One more ${l.title}`} style={{ ...input, padding: "2px 8px", cursor: "pointer" }}>
                            +
                          </button>
                        </span>
                        {after > l.quantity && <div style={{ fontSize: "12px", color: "#b42318" }}>{after - l.quantity} more than ordered</div>}
                      </td>
                    )}
                    <td style={num}>{Math.max(0, l.quantity - after)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {counting && unknown.length > 0 && (
          <div style={{ marginTop: "10px", padding: "8px 10px", borderRadius: "8px", background: "#fff6f5", border: "1px solid #f3c6c2", fontSize: "13px" }}>
            <strong>Scanned but not on this PO</strong>
            {unknown.map((u, i) => (
              <div key={u.code} style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
                <code>{u.code}</code> × {u.count}
                <button type="button" style={{ ...linkBtn, fontSize: "12px" }} onClick={() => setUnknown(unknown.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <div style={muted}>These are saved with the check-in so someone can follow up.</div>
          </div>
        )}

        {counting && (
          <>
            <label style={{ display: "block", marginTop: "10px" }}>
              <div style={muted}>Note (damage, missing paperwork, wrong items…)</div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ ...input, width: "100%" }} />
            </label>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "10px", flexWrap: "wrap" }}>
              <s-button
                variant="primary"
                onClick={() => saver.submit({ intent: "checkIn", id: String(po.id), counts: JSON.stringify(counts), unknown: JSON.stringify(unknown), note }, { method: "post" })}
                {...(saver.state !== "idle" ? { loading: true } : {})}
                {...(!unsaved ? { disabled: true } : {})}
              >
                {total ? `Check in ${total} unit${total === 1 ? "" : "s"}` : "Check in"}
              </s-button>
              {saved && (
                <span style={{ color: "#1a5e20", fontWeight: 600 }}>
                  ✓ Checked in {saved.units} unit{saved.units === 1 ? "" : "s"}. {saved.check.label}.
                  {saved.over?.length > 0 && <span style={{ color: "#b42318" }}> More than ordered: {saved.over.map((o) => `${o.title} (+${o.extra})`).join(", ")}.</span>}
                </span>
              )}
              {saver.data?.intent === "checkIn" && <Err data={saver.data} />}
            </div>
          </>
        )}
        {!canCheckIn && <div style={{ ...muted, marginTop: "8px" }}>Checking items in needs the Receiving “check in items” permission.</div>}
      </s-section>

      <s-section heading="Check-ins">
        {checkIns.length === 0 ? (
          <span style={muted}>Nothing checked in yet.</span>
        ) : (
          <div style={{ display: "grid", gap: "8px" }}>
            {checkIns.map((c) => (
              <div key={c.id} style={{ padding: "8px 10px", border: "1px solid #e3e3e3", borderRadius: "8px", fontSize: "13px", opacity: c.undone ? 0.6 : 1 }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={c.undone ? { textDecoration: "line-through" } : undefined}>
                    {c.units} unit{c.units === 1 ? "" : "s"}
                  </strong>
                  <span style={muted}>
                    {c.by ?? "Someone"} · {fmtDate(c.at, true)}
                  </span>
                  {c.undone && (
                    <span style={muted}>
                      · undone by {c.undone.by ?? "someone"} {fmtDate(c.undone.at, true)}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {canCheckIn && !c.undone && !closed && (me.admin || !c.by || c.by === me.name) && (
                    <s-button variant="tertiary" onClick={() => window.confirm(`Undo this check-in of ${c.units} unit${c.units === 1 ? "" : "s"}?`) && saver.submit({ intent: "undo", checkInId: String(c.id) }, { method: "post" })}>
                      Undo
                    </s-button>
                  )}
                </div>
                <div style={{ marginTop: "2px" }}>{c.lines.map((l) => `${l.qty} × ${l.title}`).join(" · ")}</div>
                {c.unknown.length > 0 && <div style={{ color: "#b42318" }}>Not on the PO: {c.unknown.map((u) => `${u.code} × ${u.count}`).join(", ")}</div>}
                {c.note && <div style={{ marginTop: "2px", whiteSpace: "pre-wrap" }}>📝 {c.note}</div>}
              </div>
            ))}
          </div>
        )}
        {saver.data?.intent === "undo" && <Err data={saver.data} />}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
