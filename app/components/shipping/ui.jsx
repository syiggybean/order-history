import { createContext, useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router";
import { ProductLink } from "../QuickView";

// Product titles open the quick view when the page provides one
export const QuickViewContext = createContext(null);
export function ProductName({ id, children }) {
  const open = useContext(QuickViewContext);
  if (!open || !id) return children;
  return <ProductLink id={id} title={children} onOpen={open} />;
}

// Shared look for the Shipping pages
export const STORE_TZ = "America/Los_Angeles";
export const PINK = "#FBACBB";
export const cell = { padding: "8px 10px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top" };
export const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, zIndex: 1, whiteSpace: "nowrap" };
export const muted = { color: "#616161" };
export const small = { fontSize: "12px", color: "#616161" };
export const box = { overflow: "auto", border: "1px solid #e3e3e3", borderRadius: "8px" };
export const input = { font: "inherit", padding: "5px 8px", borderRadius: "8px", border: "1px solid #c9c9c9" };
export const thumb = { width: "28px", height: "28px", objectFit: "cover", borderRadius: "4px", background: "#f1f1f1", flexShrink: 0 };

// The same picture at a bigger size: Shopify's CDN takes ?width=, and the
// small size the API gave us ("_80x" in the file name) is taken off.
export function largeImage(url, width = 640) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/_(\d+x\d*|\d*x\d+)(_crop_[a-z]+)?(@\dx)?(?=\.[a-z0-9]+$)/i, "");
    u.searchParams.delete("height");
    u.searchParams.delete("crop");
    u.searchParams.set("width", String(width));
    return u.toString();
  } catch {
    return url;
  }
}

const PREVIEW = 300; // px
const GAP = 18; // distance from the cursor

// A product thumbnail that shows a large view under the cursor on hover
export function ProductThumb({ src, size, style }) {
  const [at, setAt] = useState(null); // { x, y } while hovering
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const box = { ...thumb, ...(size ? { width: `${size}px`, height: `${size}px` } : {}), ...style };
  useEffect(() => {
    if (!at) return;
    const hide = () => setAt(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [at]);
  if (!src) return <span style={{ ...box, display: "inline-block" }} />;
  const move = (e) => {
    if (e.pointerType && e.pointerType !== "mouse") return;
    setAt({ x: e.clientX, y: e.clientY });
  };
  let pop = null;
  if (at && typeof document !== "undefined") {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Below and right of the cursor; flip if it would run off the screen
    const left = at.x + GAP + PREVIEW > vw ? Math.max(8, at.x - GAP - PREVIEW) : at.x + GAP;
    const top = at.y + GAP + PREVIEW > vh ? Math.max(8, at.y - GAP - PREVIEW) : at.y + GAP;
    pop = createPortal(
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          left,
          top,
          width: PREVIEW,
          height: PREVIEW,
          zIndex: 2147483000,
          pointerEvents: "none",
          background: "#fff",
          borderRadius: "10px",
          boxShadow: "0 10px 30px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.06)",
          padding: "8px",
          boxSizing: "border-box",
        }}
      >
        {/* The small picture fills in until the big one arrives */}
        <img src={src} alt="" style={{ position: "absolute", inset: 8, width: PREVIEW - 16, height: PREVIEW - 16, objectFit: "contain", opacity: loaded ? 0 : 1, filter: failed ? "none" : "blur(2px)" }} />
        <img
          src={largeImage(src)}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{ position: "relative", width: "100%", height: "100%", objectFit: "contain", opacity: loaded ? 1 : 0, transition: "opacity .15s" }}
        />
      </div>,
      document.body,
    );
  }
  return (
    <>
      <img src={src} alt="" style={{ ...box, cursor: "zoom-in" }} onPointerEnter={move} onPointerMove={move} onPointerLeave={() => setAt(null)} />
      {pop}
    </>
  );
}
// The "next step" button: green, so the way on is obvious
export function GreenButton({ onClick, href, children, target, disabled = false }) {
  const style = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "10px 18px",
    borderRadius: "10px",
    border: 0,
    background: "#1f8a3e",
    color: "#fff",
    font: "inherit",
    fontWeight: 700,
    fontSize: "15px",
    textDecoration: "none",
    cursor: "pointer",
    boxShadow: "0 1px 0 rgba(0,0,0,.15)",
  };
  return href ? (
    <a href={href} target={target} rel={target ? "noreferrer" : undefined} style={style}>
      {children}
    </a>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled} style={disabled ? { ...style, opacity: 0.5, cursor: "default" } : style}>
      {children}
    </button>
  );
}

export const pill = (bg, color) => ({ display: "inline-block", fontSize: "12px", fontWeight: 600, padding: "1px 8px", borderRadius: "999px", background: bg, color, whiteSpace: "nowrap" });

export const MOTION_CSS = `
@keyframes shRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.sh-rise { animation: shRise .38s cubic-bezier(.2, .7, .3, 1) both; }
@keyframes shSpin { to { transform: rotate(360deg); } }
.sh-spin { width: 16px; height: 16px; flex: none; border-radius: 50%; border: 2px solid #fde1e7; border-top-color: #e0607a; animation: shSpin .8s linear infinite; }
@media (prefers-reduced-motion: reduce) { .sh-rise { animation: none; } .sh-spin { animation-duration: 2.4s; } }
`;

export const fmtDate = (iso, time = false) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        timeZone: STORE_TZ,
        month: "short",
        day: "numeric",
        ...(time ? { hour: "numeric", minute: "2-digit" } : {}),
      })
    : "—";
export const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
};

// ---------------------------------------------------------------------------
// Reading from Shopify: progress and last result
// ---------------------------------------------------------------------------


export function Items({ lines }) {
  const shown = lines.slice(0, 4);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      {shown.map((l, i) => (
        <div key={i} style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <ProductThumb src={l.imageUrl} />
          <span>
            <strong>{l.quantity} ×</strong> <ProductName id={l.productId}>{l.title}</ProductName>
            {l.variantTitle && <span style={muted}> · {l.variantTitle}</span>}
            {l.sku && <span style={small}> · {l.sku}</span>}
          </span>
        </div>
      ))}
      {lines.length > shown.length && <span style={small}>+ {lines.length - shown.length} more</span>}
    </div>
  );
}

// Sets (or clears) one URL search param without scrolling
export function useParamSetter() {
  const [, setParams] = useSearchParams();
  return (changes, { replace = true } = {}) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) {
          if (v === null || v === undefined || v === "") n.delete(k);
          else n.set(k, String(v));
        }
        return n;
      },
      { preventScrollReset: true, replace },
    );
}
