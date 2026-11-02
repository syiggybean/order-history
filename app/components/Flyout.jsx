import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// A side panel that slides in from the right over a fading backdrop, and slides
// back out when closed (×, Escape, or a click outside). People who ask their
// system for less motion get a quick fade instead.

const MS = 220;
const CSS = `
@keyframes mbFlyBackIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes mbFlyBackOut { from { opacity: 1 } to { opacity: 0 } }
@keyframes mbFlyIn { from { transform: translateX(100%); } to { transform: none; } }
@keyframes mbFlyOut { from { transform: none; } to { transform: translateX(100%); } }
.mb-fly-back { animation: mbFlyBackIn ${MS}ms ease-out both; }
.mb-fly-back.mb-closing { animation: mbFlyBackOut ${MS}ms ease-in both; }
.mb-fly { animation: mbFlyIn ${MS + 60}ms cubic-bezier(.2, .8, .2, 1) both; will-change: transform; }
.mb-fly.mb-closing { animation: mbFlyOut ${MS}ms cubic-bezier(.4, 0, .9, .4) both; }
@media (prefers-reduced-motion: reduce) {
  .mb-fly, .mb-fly.mb-closing { animation-name: mbFlyBackIn; animation-duration: 120ms; }
  .mb-fly.mb-closing { animation-name: mbFlyBackOut; }
}
`;

// Inside a flyout, close it with the slide-out (e.g. after saving)
const CloseContext = createContext(null);
export const useFlyoutClose = () => useContext(CloseContext);

export function Flyout({ onClose, label, title, width = 440, zIndex = 1000, children, bodyStyle }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef(null);
  const close = useCallback(() => {
    if (closing) return;
    setClosing(true);
    timer.current = setTimeout(() => onClose(), MS);
  }, [closing, onClose]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <CloseContext.Provider value={close}>
      <style>{CSS}</style>
      <div
        role="presentation"
        onClick={close}
        className={`mb-fly-back${closing ? " mb-closing" : ""}`}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex, display: "flex", justifyContent: "flex-end" }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          onClick={(e) => e.stopPropagation()}
          className={`mb-fly${closing ? " mb-closing" : ""}`}
          style={{ width: `min(${width}px, 100%)`, height: "100%", background: "#fff", boxShadow: "-4px 0 24px rgba(0,0,0,0.15)", display: "flex", flexDirection: "column" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid #e3e3e3" }}>
            <strong style={{ fontSize: "15px" }}>{title}</strong>
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              style={{ appearance: "none", background: "none", border: 0, padding: 0, font: "inherit", color: "#303030", fontSize: "20px", lineHeight: 1, cursor: "pointer" }}
            >
              ×
            </button>
          </div>
          <div style={{ padding: "16px", overflowY: "auto", flexGrow: 1, ...bodyStyle }}>{children}</div>
        </div>
      </div>
    </CloseContext.Provider>
  );
}
