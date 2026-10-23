import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { input, small } from "./ui";

// Product filter: type part of a title, variant or SKU and pick from the
// suggestions (products in this tab's shipments, with how many each is in).
export function ProductPicker({ value, name, state, singles, doubles, onPick }) {
  const fetcher = useFetcher();
  const [text, setText] = useState(value ? name || "Selected product" : "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef(null);
  const wrap = useRef(null);
  const listId = useId();
  const results = fetcher.data?.intent === "productSuggest" ? fetcher.data.products : [];

  const ask = (q) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => fetcher.submit({ intent: "productSuggest", q, state: state === "waiting" ? "waiting" : "ready", singles: singles ? "1" : "", doubles: doubles ? "1" : "" }, { method: "post" }),
      q ? 200 : 0,
    );
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  // Close when clicking elsewhere
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (wrap.current && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => setActive(0), [fetcher.data]);

  const choose = (p) => {
    setText(p.title ?? "");
    setOpen(false);
    onPick(p);
  };
  const clear = () => {
    setText("");
    setOpen(false);
    if (value) onPick(null);
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        ask(value ? "" : text);
      } else setActive((i) => Math.min(i + 1, Math.max(0, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && results[active]) choose(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };
  const loading = fetcher.state !== "idle";

  return (
    <div ref={wrap} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Product"
        placeholder="Any product"
        value={text}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          ask(e.target.value.trim());
          // Typing over a chosen product clears it
          if (value) onPick(null);
        }}
        onFocus={() => {
          setOpen(true);
          ask(value ? "" : text.trim());
        }}
        onKeyDown={onKey}
        style={{ ...input, width: "240px", paddingRight: text ? "26px" : undefined, ...(value ? { borderColor: "#303030", fontWeight: 600 } : {}) }}
      />
      {text && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear product"
          style={{ position: "absolute", right: "6px", border: 0, background: "none", cursor: "pointer", fontSize: "16px", lineHeight: 1, color: "#616161", padding: "2px" }}
        >
          ×
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 20,
            width: "360px",
            maxHeight: "320px",
            overflow: "auto",
            margin: 0,
            padding: "4px",
            listStyle: "none",
            background: "#fff",
            border: "1px solid #d4d4d4",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,.14)",
          }}
        >
          {results.length === 0 ? (
            <li style={{ ...small, padding: "8px 10px" }}>{loading ? "Looking…" : text.trim() ? `No products matching "${text.trim()}" here` : "No products here"}</li>
          ) : (
            results.map((p, i) => (
              <li
                key={p.productId}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                style={{ display: "flex", gap: "8px", alignItems: "center", padding: "6px 8px", borderRadius: "6px", cursor: "pointer", background: i === active ? "#f1f1f1" : undefined }}
              >
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" style={{ width: "28px", height: "28px", objectFit: "cover", borderRadius: "4px", flexShrink: 0 }} />
                ) : (
                  <span style={{ width: "28px", height: "28px", borderRadius: "4px", background: "#f1f1f1", flexShrink: 0 }} />
                )}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <Highlight text={p.title} q={value ? "" : text.trim()} />
                </span>
                <span style={{ ...small, whiteSpace: "nowrap" }}>
                  {p.shipments} shipment{p.shipments === 1 ? "" : "s"}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

function Highlight({ text, q }) {
  const t = String(text ?? "");
  const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return t;
  return (
    <>
      {t.slice(0, i)}
      <strong>{t.slice(i, i + q.length)}</strong>
      {t.slice(i + q.length)}
    </>
  );
}
