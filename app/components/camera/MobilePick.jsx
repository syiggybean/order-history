import { useCallback, useEffect, useRef, useState } from "react";
import { largerImage, makeBarcodeReader, makeConfirmer, makeDebouncer, pickCamera, saveCamera, savedCamera } from "./camera-lib";

// Picking a batch on a phone: the pick list by bin, scanning with the phone's
// camera (or a Bluetooth scanner, or + / − by hand), then "Finish picking".
// Opened from the QR code on the batch's pick list.

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";
const PINK = "#FBACBB";
const api = async (k, body) => {
  const r = await fetch("/pick-mobile/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ k, ...body }) }).catch(() => null);
  if (!r) return { ok: false, error: "No connection. Trying again…" };
  return r.json().catch(() => ({ ok: false, error: "No answer from the app." }));
};
const label = (i) => `${i.title}${i.variantTitle && i.variantTitle !== "Default Title" ? ` – ${i.variantTitle}` : ""}`;

function feedback(ok) {
  try {
    navigator.vibrate?.(ok ? 40 : [80, 60, 80]);
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + (ok ? 0.09 : 0.25));
  } catch {
    // no sound
  }
}

const btn = (extra = {}) => ({
  appearance: "none",
  border: "1px solid #c9c9c9",
  background: "#fff",
  borderRadius: "10px",
  font: "inherit",
  fontWeight: 700,
  cursor: "pointer",
  minWidth: "44px",
  minHeight: "44px",
  ...extra,
});

export function MobilePick({ k, userName }) {
  const [data, setData] = useState(null); // { batch, items, totals, lock }
  const [error, setError] = useState(null);
  const [expired, setExpired] = useState(false);
  const [flash, setFlash] = useState(null); // { ok, text }
  const [short, setShort] = useState(null);
  const busy = useRef(0);

  // ---- The pick list (also picks up changes made elsewhere) -------------------
  const load = useCallback(async () => {
    if (busy.current) return;
    const r = await api(k, { intent: "state" });
    if (busy.current) return; // a change landed meanwhile; the next poll gets it
    if (r.ok) {
      setData(r);
      setError(null);
    } else {
      setError(r.error);
      if (r.expired) setExpired(true);
    }
  }, [k]);
  useEffect(() => {
    load();
    if (expired) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load, expired]);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const applyItem = (key, picked) => setData((d) => (d ? { ...d, items: d.items.map((i) => (i.key === key ? { ...i, picked } : i)) } : d));

  const scan = useCallback(
    async (code) => {
      busy.current++;
      const r = await api(k, { intent: "scan", code });
      busy.current--;
      if (r.ok) {
        applyItem(r.key, r.picked);
        feedback(true);
        setFlash({ ok: true, text: `${r.title}: ${r.picked} of ${r.qty}${r.bin ? ` · bin ${r.bin}` : ""}` });
        document.getElementById(`item-${r.key}`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      } else {
        feedback(false);
        setFlash({ ok: false, text: r.error ?? "Not picked" });
      }
    },
    [k],
  );
  const setQty = async (item, qty) => {
    const n = Math.max(0, Math.min(item.qty, qty));
    applyItem(item.key, n);
    busy.current++;
    const r = await api(k, { intent: "set", key: item.key, qty: n });
    busy.current--;
    if (r.ok) applyItem(r.key, r.picked);
    else {
      setFlash({ ok: false, text: r.error });
      load();
    }
  };
  const finish = async (force = false) => {
    busy.current++;
    const r = await api(k, { intent: "finish", force });
    busy.current--;
    if (r.short) setShort(r.short);
    else if (r.ok) {
      setShort(null);
      feedback(true);
      load();
    } else setFlash({ ok: false, text: r.error });
  };

  // ---- Camera -------------------------------------------------------------------
  const videoRef = useRef(null);
  const [camOn, setCamOn] = useState(true);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [camError, setCamError] = useState(null);
  const [reader, setReader] = useState(null);
  useEffect(() => {
    makeBarcodeReader()
      .then(setReader)
      .catch(() => setReader({ kind: "none", read: async () => [] }));
  }, []);
  useEffect(() => {
    if (!camOn) return undefined;
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamError("This browser can't use the camera here.");
        return;
      }
      try {
        const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        first.getTracks().forEach((t) => t.stop());
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        if (cancelled) return;
        setDevices(all);
        setDeviceId((cur) => cur ?? pickCamera(all, savedCamera())?.deviceId ?? null);
      } catch (e) {
        setCamError(e?.name === "NotAllowedError" ? "Camera access was blocked. Allow the camera for this site, then reload." : `The camera didn't start: ${e?.message ?? e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [camOn]);
  const [stream, setStream] = useState(null);
  useEffect(() => {
    if (!camOn || !deviceId) return undefined;
    let live = null;
    let cancelled = false;
    (async () => {
      try {
        live = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (cancelled) return live.getTracks().forEach((t) => t.stop());
        try {
          const track = live.getVideoTracks()[0];
          if (track?.getCapabilities?.().focusMode?.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        } catch {
          // not supported
        }
        setStream(live);
        setCamError(null);
        const d = devices.find((x) => x.deviceId === deviceId);
        if (d) saveCamera(d);
        if (videoRef.current) {
          videoRef.current.srcObject = live;
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        setCamError(`That camera didn't start (${e?.name ?? e}). Pick another one.`);
      }
    })();
    return () => {
      cancelled = true;
      live?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn, deviceId]);
  const fresh = useRef(null);
  const confirm = useRef(null);
  if (!fresh.current) fresh.current = makeDebouncer();
  if (!confirm.current) confirm.current = makeConfirmer();
  const pickable = data && ["open", "picking"].includes(data.batch.status) && !data.lock;
  useEffect(() => {
    if (!reader || !stream || reader.kind === "none" || !pickable) return undefined;
    let stop = false;
    let running = false;
    const t = setInterval(async () => {
      const v = videoRef.current;
      if (stop || running || !v || v.readyState < 2) return;
      running = true;
      try {
        for (const c of fresh.current(confirm.current(await reader.read(v)))) scan(c);
      } catch {
        // this frame couldn't be read
      } finally {
        running = false;
      }
    }, 180);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [reader, stream, pickable, scan]);

  // ---- Typed / Bluetooth scanner ----------------------------------------------
  const [code, setCode] = useState("");
  const onSubmit = (e) => {
    e.preventDefault();
    const c = code.trim();
    setCode("");
    if (c) scan(c);
  };

  // ---- Screen ---------------------------------------------------------------------
  const page = { fontFamily: FONT, color: "#1a1a1a", background: "#f6f6f7", minHeight: "100vh", fontSize: "15px", paddingBottom: "90px" };
  if (!data)
    return (
      <div style={{ ...page, padding: "24px" }}>
        <strong>Pick</strong>
        <p style={{ color: error ? "#b42318" : "#616161" }}>{error ?? "Loading the pick list…"}</p>
      </div>
    );
  const { batch, items } = data;
  const units = items.reduce((n, i) => n + i.qty, 0);
  const picked = items.reduce((n, i) => n + i.picked, 0);
  const pct = units ? Math.round((picked / units) * 100) : 0;
  const done = !["open", "picking"].includes(batch.status);

  return (
    <div style={page}>
      <header style={{ position: "sticky", top: 0, zIndex: 5, background: "#fff", borderBottom: "1px solid #e3e3e3", padding: "10px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
          <strong style={{ fontSize: "17px" }}>
            {batch.tag}
            {batch.name ? <span style={{ fontWeight: 500, color: "#616161" }}> · {batch.name}</span> : null}
          </strong>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
            {picked}/{units}
          </span>
        </div>
        <div style={{ height: "8px", borderRadius: "999px", background: "#eee", overflow: "hidden", marginTop: "8px" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#36a15a" : PINK, transition: "width .25s" }} />
        </div>
        <div style={{ color: "#616161", fontSize: "12px", marginTop: "4px" }}>
          Picking as {userName} · {items.length} items by bin
          {error ? <span style={{ color: "#b42318" }}> · {error}</span> : null}
        </div>
      </header>

      {data.lock && (
        <div role="status" style={{ margin: "12px 14px 0", padding: "10px 12px", borderRadius: "10px", background: "#fff4e5", border: "1px solid #f3c98b", color: "#5c3a00", fontWeight: 600 }}>
          🔒 {data.lock}
        </div>
      )}
      {done && (
        <div role="status" style={{ margin: "12px 14px 0", padding: "14px", borderRadius: "10px", background: "#e9f6ec", border: "1px solid #9fd3ad", color: "#1a5e20", fontWeight: 700 }}>
          Picked ✓ {batch.pickedBy ? `by ${batch.pickedBy}` : ""}. On to packing.
        </div>
      )}

      {pickable && (
        <section style={{ margin: "12px 14px 0" }}>
          {camOn && (
            <div style={{ position: "relative", background: "#000", borderRadius: "12px", overflow: "hidden" }}>
              <video ref={videoRef} muted playsInline autoPlay style={{ width: "100%", maxHeight: "34vh", objectFit: "cover", display: "block" }} />
              <div aria-hidden="true" style={{ position: "absolute", inset: "22% 12%", border: "2px dashed rgba(255,255,255,.6)", borderRadius: "10px", pointerEvents: "none" }} />
              {camError && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", padding: "16px", textAlign: "center", background: "rgba(0,0,0,.6)" }}>{camError}</div>}
              {reader?.kind === "none" && <div style={{ position: "absolute", top: 8, left: 8, color: "#fff", fontSize: "12px", background: "rgba(0,0,0,.5)", padding: "3px 8px", borderRadius: "6px" }}>Barcode reading isn't available here</div>}
            </div>
          )}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "8px", flexWrap: "wrap" }}>
            <button type="button" onClick={() => setCamOn((x) => !x)} style={btn({ padding: "0 12px", fontWeight: 600 })}>
              {camOn ? "Camera off" : "📷 Scan with camera"}
            </button>
            {camOn && devices.length > 1 && (
              <select value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value)} aria-label="Camera" style={{ font: "inherit", fontSize: "13px", padding: "8px", borderRadius: "10px", border: "1px solid #c9c9c9", maxWidth: "190px" }}>
                {devices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            )}
            <form onSubmit={onSubmit} style={{ flex: "1 1 160px", display: "flex" }}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Type or scan a code"
                aria-label="Scan"
                autoComplete="off"
                inputMode="text"
                style={{ flex: 1, font: "inherit", padding: "10px 12px", borderRadius: "10px", border: `2px solid ${PINK}`, minWidth: 0 }}
              />
            </form>
          </div>
        </section>
      )}

      <ul style={{ listStyle: "none", padding: 0, margin: "12px 14px 0", display: "grid", gap: "8px" }}>
        {items.map((i) => {
          const full = i.picked >= i.qty;
          return (
            <li
              key={i.key}
              id={`item-${i.key}`}
              style={{ display: "flex", gap: "10px", alignItems: "center", padding: "10px", borderRadius: "12px", background: full ? "#f1f8f5" : "#fff", border: `1px solid ${full ? "#b4dfc4" : "#e3e3e3"}` }}
            >
              <div style={{ width: "54px", flexShrink: 0, textAlign: "center" }}>
                <div style={{ fontSize: "11px", color: "#616161" }}>Bin</div>
                <div style={{ fontWeight: 800, fontSize: "16px", wordBreak: "break-word" }}>{i.bin ?? "—"}</div>
              </div>
              {i.imageUrl ? (
                <img src={largerImage(i.imageUrl, 120)} alt="" width="52" height="52" style={{ objectFit: "cover", borderRadius: "8px", background: "#eee", flexShrink: 0 }} />
              ) : (
                <span style={{ width: 52, height: 52, borderRadius: 8, background: "#eee", flexShrink: 0 }} />
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, lineHeight: 1.25 }}>{label(i)}</span>
                <span style={{ color: "#616161", fontSize: "12px" }}>{[i.sku, i.barcode].filter(Boolean).join(" · ") || "No barcode"}</span>
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" }}>
                <strong style={{ fontVariantNumeric: "tabular-nums", fontSize: "17px", color: full ? "#1a7f37" : "#1a1a1a" }}>
                  {i.picked}/{i.qty}
                </strong>
                {pickable && (
                  <span style={{ display: "flex", gap: "4px" }}>
                    <button type="button" aria-label={`One less ${label(i)}`} disabled={i.picked <= 0} onClick={() => setQty(i, i.picked - 1)} style={btn()}>
                      −
                    </button>
                    <button type="button" aria-label={`One more ${label(i)}`} disabled={full} onClick={() => setQty(i, i.picked + 1)} style={btn({ background: full ? "#fff" : "#303030", color: full ? "#8a8a8a" : "#fff", border: 0 })}>
                      +
                    </button>
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {short && (
        <div style={{ margin: "12px 14px 0", padding: "12px", borderRadius: "10px", background: "#fde7e9", color: "#8e1f0b" }}>
          <strong>Not picked yet:</strong>
          <ul style={{ margin: "6px 0", paddingLeft: "18px" }}>
            {short.map((x, n) => (
              <li key={n}>
                {x.missing} × {x.title}
                {x.bin ? ` (bin ${x.bin})` : ""}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => finish(true)} style={btn({ padding: "0 14px", borderColor: "#8e1f0b", color: "#8e1f0b" })}>
            Finish anyway
          </button>
        </div>
      )}

      {flash && (
        <div role="status" style={{ position: "fixed", left: "12px", right: "12px", bottom: pickable ? "78px" : "16px", zIndex: 10, padding: "12px 14px", borderRadius: "12px", fontWeight: 700, color: "#fff", background: flash.ok ? "rgba(26,127,55,.95)" : "rgba(180,35,24,.95)" }}>
          {flash.text}
        </div>
      )}
      {pickable && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, padding: "10px 14px calc(10px + env(safe-area-inset-bottom))", background: "#fff", borderTop: "1px solid #e3e3e3", zIndex: 6 }}>
          <button type="button" onClick={() => finish(false)} style={btn({ width: "100%", minHeight: "50px", border: 0, borderRadius: "999px", background: pct === 100 ? "#1a7f37" : "#303030", color: "#fff", fontSize: "16px" })}>
            Finish picking{pct === 100 ? " ✓" : ` (${picked}/${units})`}
          </button>
        </div>
      )}
    </div>
  );
}
