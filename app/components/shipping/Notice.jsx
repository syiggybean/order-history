import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { fmtDate } from "./ui";

// Orange: orders with a note, or an address Shopify flagged as possibly invalid
export const NOTICE_BG = "#fff1e0";
export const NOTICE_EDGE = "#f08c00";

// "https://admin.shopify.com/store/<handle>", provided by the Shipping page
export const ShopAdminContext = createContext(null);

export const noticeSummary = (n) =>
  [
    n?.note ? "Note" : null,
    n?.address ? (n.kept ? "Address kept as is" : n.address.level === "ERROR" ? "Address likely invalid" : "Address may be invalid") : null,
  ]
    .filter(Boolean)
    .join(" · ");

export function NoticeTag({ notice }) {
  if (!notice) return null;
  return (
    <span
      style={{ display: "inline-block", fontSize: "12px", fontWeight: 700, padding: "1px 8px", borderRadius: "999px", background: "#ffd8a8", color: "#7a3d00", whiteSpace: "nowrap" }}
    >
      ! {noticeSummary(notice)}
    </span>
  );
}

const btnRow = { display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px", alignItems: "center" };

// Shows the note and Shopify's address warning every time. For the address:
// review it on the order's Shopify page (a pop-up window; the app re-reads the
// order when it closes) or keep it as it is.
export function NoticeModal({ notice: initial, shipmentId, orderName, orderNumber, context = "view", busy = false, error = null, onContinue, onCancel, onNoticeChange }) {
  const admin = useContext(ShopAdminContext);
  const recheck = useFetcher();
  const keep = useFetcher();
  const [notice, setNotice] = useState(initial);
  const [waiting, setWaiting] = useState(false); // the Shopify window is open
  const [blocked, setBlocked] = useState(false); // pop-up blocked by the browser
  const [result, setResult] = useState(null); // "fixed" | "still"
  const winRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    boxRef.current?.focus?.();
    const onKey = (e) => e.key === "Escape" && onCancel?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const runRecheck = () => recheck.submit({ intent: "recheckOrder", id: String(shipmentId) }, { method: "post" });

  // Watch the Shopify window; when it closes, re-read the order
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => {
      if (!winRef.current || winRef.current.closed) {
        clearInterval(t);
        setWaiting(false);
        runRecheck();
      }
    }, 700);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  useEffect(() => {
    const r = recheck.data;
    if (r?.intent !== "recheckOrder" || !r.ok) return;
    setNotice(r.notice);
    setResult(r.fixed ? "fixed" : r.stillFlagged ? "still" : null);
    onNoticeChange?.(r.notice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheck.data]);
  useEffect(() => {
    const r = keep.data;
    if (r?.intent !== "keepAddress" || !r.ok) return;
    setNotice(r.notice);
    onNoticeChange?.(r.notice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keep.data]);

  const orderUrl = admin && orderNumber ? `${admin}/orders/${orderNumber}` : null;
  const review = () => {
    if (!orderUrl) return;
    setResult(null);
    const w = window.open(orderUrl, `shopify-order-${orderNumber}`, "popup=yes,width=1200,height=900");
    if (!w) {
      setBlocked(true);
      return;
    }
    winRef.current = w;
    setBlocked(false);
    setWaiting(true);
  };

  const a = notice?.address;
  const fixedNow = result === "fixed";
  const nothingLeft = !notice; // fixed address, no note

  return (
    <div
      role="presentation"
      onClick={onCancel}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-label={`${orderName}: before ${context === "pack" ? "packing" : "you continue"}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 100%)", maxHeight: "92vh", overflowY: "auto", background: "#fff", borderRadius: "14px", boxShadow: "0 12px 40px rgba(0,0,0,.25)", outline: "none" }}
      >
        <div style={{ background: NOTICE_EDGE, color: "#fff", padding: "12px 16px", fontWeight: 700, fontSize: "15px" }}>
          {orderName}: check this before {context === "pack" ? "packing" : "you continue"}
        </div>
        <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "12px", fontSize: "14px" }}>
          {fixedNow && (
            <div style={{ border: "2px solid #36a15a", background: "#f0faf2", borderRadius: "10px", padding: "12px", color: "#1a5e20", fontWeight: 600 }}>
              ✓ Address fixed. Shopify no longer flags it.
              {notice?.shipTo?.length ? <div style={{ fontWeight: 400, color: "#303030", marginTop: "6px" }}>{notice.shipTo.join(", ")}</div> : null}
            </div>
          )}

          {a && (
            <div style={{ border: `2px solid ${a.level === "ERROR" ? "#d72c0d" : NOTICE_EDGE}`, borderRadius: "10px", padding: "12px" }}>
              <div style={{ fontWeight: 700, color: a.level === "ERROR" ? "#a41c0b" : "#7a3d00", marginBottom: "6px" }}>⚠ {a.text}</div>
              {a.address?.length ? (
                <div style={{ lineHeight: 1.45, background: "#fafafa", borderRadius: "8px", padding: "8px 10px" }}>
                  {a.address.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              ) : null}
              {notice.kept && (
                <div style={{ marginTop: "8px", fontSize: "13px", fontWeight: 600, color: "#7a3d00" }}>
                  Kept as is{notice.kept.by ? ` by ${notice.kept.by}` : ""} · {fmtDate(notice.kept.at, true)}
                </div>
              )}
              {result === "still" && (
                <div style={{ marginTop: "8px", fontSize: "13px", color: "#7a3d00" }}>Checked again: Shopify still flags this address.</div>
              )}
              {waiting ? (
                <div style={{ ...btnRow, fontSize: "13px" }}>
                  <span className="sh-spin" style={{ display: "inline-block", width: "12px", height: "12px" }} />
                  <span>Review it in the Shopify window. Close that window when you're done and this re-checks the order.</span>
                  <s-button variant="tertiary" onClick={() => { setWaiting(false); runRecheck(); }}>
                    I'm done, check now
                  </s-button>
                </div>
              ) : (
                <div style={btnRow}>
                  {orderUrl && (
                    <s-button variant="primary" onClick={review}>
                      Review in Shopify ↗
                    </s-button>
                  )}
                  {!notice.kept && (
                    <s-button onClick={() => keep.submit({ intent: "keepAddress", id: String(shipmentId) }, { method: "post" })} {...(keep.state !== "idle" ? { loading: true } : {})}>
                      Keep address as is
                    </s-button>
                  )}
                  <s-button variant="tertiary" onClick={runRecheck} {...(recheck.state !== "idle" ? { loading: true } : {})}>
                    Check again
                  </s-button>
                </div>
              )}
              {blocked && orderUrl && (
                <div style={{ marginTop: "8px", fontSize: "13px" }}>
                  Your browser blocked the pop-up.{" "}
                  <a href={orderUrl} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }} onClick={() => setTimeout(runRecheck, 1500)}>
                    Open the order in a new tab
                  </a>
                  , then come back and choose Check again.
                </div>
              )}
              {!waiting && (
                <div style={{ fontSize: "12px", color: "#616161", marginTop: "8px" }}>
                  Shopify shows its suggested address on the order page; accept it there to update the order. Or keep the address if it's right.
                </div>
              )}
              {(keep.data?.error || recheck.data?.error) && <div style={{ color: "#b42318", marginTop: "6px" }}>{keep.data?.error || recheck.data?.error}</div>}
            </div>
          )}

          {notice?.note && (
            <div style={{ border: "2px solid #e3e3e3", borderRadius: "10px", padding: "12px" }}>
              <div style={{ fontWeight: 700, marginBottom: "6px" }}>Order note</div>
              <div style={{ whiteSpace: "pre-wrap", background: "#fffbe6", borderRadius: "8px", padding: "8px 10px" }}>{notice.note}</div>
            </div>
          )}

          {error && <div style={{ color: "#b42318" }}>{error}</div>}
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <s-button variant="tertiary" onClick={onCancel}>
              Cancel
            </s-button>
            <s-button variant="primary" onClick={onContinue} {...(busy ? { loading: true } : {})} {...(waiting ? { disabled: true } : {})}>
              {nothingLeft ? "Continue" : context === "pack" ? "I've read it, start packing" : "I've read it, continue"}
            </s-button>
          </div>
        </div>
      </div>
    </div>
  );
}
