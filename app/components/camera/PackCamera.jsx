import { useCallback, useEffect, useRef, useState } from "react";
import {
  largerImage,
  loadMatcher,
  makeBarcodeReader,
  makeConfirmer,
  makeDebouncer,
  matchConfidence,
  pickCamera,
  queueAll,
  queueDelete,
  queuePut,
  rankByPhoto,
  saveCamera,
  savedCamera,
  sendToDrive,
  snapshot,
  startRecording,
} from "./camera-lib";

// The pack camera window. Linked to one person's pack bench: it shows the box
// open there, reads barcodes (or matches an item by photo) and sends them to the
// bench, and records each box from opening to packed, then uploads the video to
// Google Drive.

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";
const PINK = "#FBACBB";
const api = async (k, body) => {
  const r = await fetch("/pack-camera/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ k, ...body }) });
  return r.json().catch(() => ({ ok: false, error: "No answer from the app." }));
};
// Side by side on a computer; stacked on a phone, with the camera on top
const LAYOUT = `
.mbpc-main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(280px, 2fr); gap: 16px; padding: 16px; align-items: start; }
.mbpc-video { position: relative; background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 16 / 9; }
.mbpc-feed { width: 100%; height: 100%; object-fit: contain; display: block; }
@media (max-width: 760px) {
  .mbpc-main { grid-template-columns: minmax(0, 1fr); gap: 10px; padding: 10px; }
  .mbpc-video { aspect-ratio: auto; min-height: 200px; }
  .mbpc-feed { height: auto; max-height: 58vh; margin: 0 auto; }
}
`;
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function beep(ok) {
  try {
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

// The batch open at the bench: where packing is, and the boxes left to open
function BatchBoxes({ batch, openId, onOpen }) {
  const left = batch.boxes.filter((b) => !b.packed);
  return (
    <div style={{ marginTop: "14px", borderTop: "1px solid #eee", paddingTop: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", marginBottom: "8px" }}>
        <strong>{batch.title}</strong>
        <span style={{ fontVariantNumeric: "tabular-nums", color: batch.packed === batch.total ? "#1a7f37" : "#616161", fontWeight: 600 }}>
          {batch.packed} / {batch.total} packed
        </span>
      </div>
      {left.length === 0 ? (
        <p style={{ margin: 0, color: "#1a7f37", fontWeight: 600 }}>Every box is packed ✓</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "6px", maxHeight: "50vh", overflow: "auto" }}>
          {left.map((b) => (
            <li key={b.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "6px 8px", borderRadius: "8px", background: b.id === openId ? "#fff4f6" : "#fafafa" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong>{b.orderName}</strong>
                {b.part ? <span style={{ color: "#616161" }}> ({b.part})</span> : null}
                <span style={{ color: "#616161", fontSize: "12px" }}> · {b.units} {b.units === 1 ? "item" : "items"}</span>
              </span>
              <button type="button" onClick={() => onOpen(b)} style={{ padding: "6px 12px", borderRadius: "999px", border: "1px solid #c9c9c9", background: "#fff", font: "inherit", fontSize: "13px", cursor: "pointer" }}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PackCamera({ k, userName }) {
  const videoRef = useRef(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [stream, setStream] = useState(null);
  const [camError, setCamError] = useState(null);
  const [state, setState] = useState(null); // from the server: { box, recording, sandbox, driveProblem }
  const [linkError, setLinkError] = useState(null);
  const [flash, setFlash] = useState(null); // { ok, text }
  const [reader, setReader] = useState(null);
  const box = state?.box ?? null;

  // ---- Cameras --------------------------------------------------------------
  const listCameras = useCallback(async () => {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    setDevices(all);
    return all;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamError("This browser can't use a camera here. Use Chrome, and open the camera from the pack bench.");
        return;
      }
      try {
        // Ask once (labels are hidden until allowed), then pick the remembered camera
        const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        first.getTracks().forEach((t) => t.stop());
        const all = await listCameras();
        if (!cancelled) setDeviceId(pickCamera(all, savedCamera())?.deviceId ?? null);
      } catch (e) {
        setCamError(e?.name === "NotAllowedError" ? "Camera access was blocked. Allow the camera for this site (the camera icon in the address bar), then reload." : `The camera didn't start: ${e?.message ?? e}`);
      }
    })();
    navigator.mediaDevices?.addEventListener?.("devicechange", listCameras);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.("devicechange", listCameras);
    };
  }, [listCameras]);

  useEffect(() => {
    if (!deviceId) return undefined;
    let live = null;
    let cancelled = false;
    (async () => {
      try {
        // Full HD where the camera has it: more detail for barcodes
        live = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        // Keep refocusing (webcams that support it), so a barcode held close stays sharp
        try {
          const track = live.getVideoTracks()[0];
          if (track?.getCapabilities?.().focusMode?.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
        } catch {
          // not supported
        }
        if (cancelled) return live.getTracks().forEach((t) => t.stop());
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
  }, [deviceId]);

  // ---- Link with the bench (polled) -----------------------------------------
  const cameraName = devices.find((d) => d.deviceId === deviceId)?.label || null;
  useEffect(() => {
    let stop = false;
    let t = null;
    const tick = async () => {
      const r = await api(k, { intent: "state", info: cameraName }).catch(() => null);
      if (stop) return;
      if (r?.ok) {
        setState(r);
        setLinkError(null);
      } else if (r?.expired) {
        setLinkError(r.error);
        return; // stop polling
      } else setLinkError(r?.error ?? "Can't reach the app. Retrying…");
      t = setTimeout(tick, 1000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [k, cameraName]);

  // ---- Barcodes ---------------------------------------------------------------
  useEffect(() => {
    makeBarcodeReader()
      .then(setReader)
      .catch(() => setReader({ kind: "none", read: async () => [] }));
  }, []);
  const send = useCallback(
    async (code, via = "barcode", label = null) => {
      const r = await api(k, { intent: "scan", code, via });
      if (r?.ok) {
        beep(true);
        setFlash({ ok: true, text: `Sent ${label ?? code} to the pack bench` });
      } else {
        beep(false);
        setFlash({ ok: false, text: r?.error ?? "Not sent" });
      }
    },
    [k],
  );
  const [paused, setPaused] = useState(false); // while matching a photo
  const fresh = useRef(null); // remembers codes across pauses, so an item still in view isn't counted again
  if (!fresh.current) fresh.current = makeDebouncer();
  const confirm = useRef(null);
  if (!confirm.current) confirm.current = makeConfirmer();
  useEffect(() => {
    if (!reader || !stream || paused || reader.kind === "none") return undefined;
    fresh.current.hold();
    let stop = false;
    let busy = false;
    const t = setInterval(async () => {
      const v = videoRef.current;
      if (stop || busy || !v || v.readyState < 2) return;
      busy = true;
      try {
        const codes = fresh.current(confirm.current(await reader.read(v)));
        for (const c of codes) send(c);
      } catch {
        // this frame couldn't be read
      } finally {
        busy = false;
      }
    }, 180);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [reader, stream, paused, send]);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  // ---- Recording: one video per box, from opening to packed -------------------
  const rec = useRef(null); // { boxId, orderName, stop, startedAt }
  const [recFor, setRecFor] = useState(null); // { boxId, orderName, startedAt }
  const [now, setNow] = useState(Date.now());
  const [uploads, setUploads] = useState([]);
  const refreshUploads = useCallback(async () => setUploads(await queueAll()), []);
  useEffect(() => {
    refreshUploads();
  }, [refreshUploads]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const finish = useCallback((capped = false) => {
    if (rec.current) {
      rec.current.target.capped = capped;
      rec.current.stop();
      rec.current = null;
      setRecFor(null);
    }
  }, []);
  useEffect(() => {
    const canRecord = state?.recording && stream;
    const packing = box && box.state === "batched";
    // Box changed, packed, or recording not possible: finish the current video
    if (rec.current && (!packing || !canRecord || rec.current.boxId !== box.id)) finish();
    if (!rec.current && packing && canRecord) {
      const target = { boxId: box.id, orderName: box.orderName, part: box.part, capped: false };
      const r = startRecording(stream, {
        // Every recording waits here; the app only keeps the one during which the box was
        // packed (an attempt that was abandoned, or redone, is dropped when it's sent)
        onStop: async ({ blob, mime, startedAt, endedAt, seconds }) => {
          if (!blob.size) return;
          await queuePut({ id: `${target.boxId}-${startedAt}`, shipmentId: target.boxId, orderName: target.orderName, part: target.part, mime, blob, seconds, startedAt, endedAt, capped: target.capped, createdAt: Date.now() });
          refreshUploads();
        },
      });
      if (r) {
        rec.current = { ...target, target, stop: r.stop, startedAt: r.startedAt };
        setRecFor({ ...target, startedAt: r.startedAt });
      }
    }
    // Very long boxes: cap each video at 30 minutes
    if (rec.current && Date.now() - rec.current.startedAt > 30 * 60 * 1000) finish(true);
  }, [box?.id, box?.state, state?.recording, stream, now, finish, refreshUploads]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => rec.current?.stop(), []);

  // ---- Upload queue ------------------------------------------------------------
  const [sending, setSending] = useState(null); // { id, pct }
  const [uploadError, setUploadError] = useState(null);
  const working = useRef(false); // one upload at a time (not tied to re-renders)
  const mounted = useRef(true);
  useEffect(() => () => (mounted.current = false), []);
  useEffect(() => {
    if (working.current || !uploads.length || !state?.ok) return;
    const item = uploads[0];
    working.current = true;
    (async () => {
      setSending({ id: item.id, pct: 0 });
      try {
        let it = item;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!it.uploadUrl) {
            const s = await api(k, {
              intent: "uploadStart",
              shipmentId: it.shipmentId,
              mimeType: it.mime,
              seconds: it.seconds,
              startedAt: it.startedAt,
              endedAt: it.endedAt ?? null,
              capped: Boolean(it.capped),
              clientNow: Date.now(), // so the app can allow for this computer's clock
              videoId: it.videoId ?? null,
            });
            if (s.skip) {
              // Not the finished packing of the box (abandoned, or redone later): not uploaded
              await queueDelete(it.id);
              break;
            }
            if (!s.ok) throw new Error(s.error);
            it = { ...it, uploadUrl: s.uploadUrl, videoId: s.videoId, fileName: s.fileName, sent: 0 };
            await queuePut(it);
          }
          const r = await sendToDrive(it, async (sent, total) => {
            it = { ...it, sent };
            await queuePut(it);
            if (mounted.current) setSending({ id: it.id, pct: Math.round((sent / total) * 100) });
          });
          if (r.done) {
            const d = await api(k, { intent: "uploadDone", videoId: it.videoId, driveFileId: r.done, sizeBytes: it.blob.size });
            if (!d?.ok && !d?.expired) throw new Error(d?.error ?? "The app didn't record the upload");
            await queueDelete(it.id);
            if (mounted.current) setUploadError(null);
            break;
          }
          // The upload address expired: start again
          it = { ...it, uploadUrl: null };
          await queuePut(it);
          if (attempt === 1) throw new Error("Google Drive kept refusing the upload");
        }
      } catch (e) {
        if (mounted.current) setUploadError(`${item.orderName}: ${e.message}. Trying again shortly.`);
        await new Promise((r) => setTimeout(r, 20_000));
      } finally {
        working.current = false;
        if (mounted.current) {
          setSending(null);
          refreshUploads();
        }
      }
    })();
  }, [uploads, state?.ok, k, refreshUploads]);
  // Don't close the window with a video still recording or waiting
  useEffect(() => {
    const warn = (e) => {
      if (rec.current || uploads.length) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploads.length]);

  // ---- Match by photo ----------------------------------------------------------
  const [match, setMatch] = useState(null); // { photo: dataURL, ranked, confidence, loading, error }
  const matchByPhoto = async () => {
    const v = videoRef.current;
    if (!v || !box) return;
    setPaused(true);
    const photo = snapshot(v);
    setMatch({ photo: photo.toDataURL("image/jpeg", 0.85), loading: "Comparing with the items in this box…" });
    const open = box.lines.filter((l) => l.scanned < l.qty);
    try {
      const model = await loadMatcher();
      const ranked = await rankByPhoto(model, photo, open);
      setMatch((m) => ({ ...m, loading: null, ranked, confidence: matchConfidence(ranked) }));
    } catch {
      // No matcher (offline, blocked): the packer picks by eye
      setMatch((m) => ({ ...m, loading: null, ranked: open.map((l) => ({ ...l, score: null })), confidence: "none", error: "Couldn't load the photo matcher. Pick the item by eye." }));
    }
  };
  const confirmMatch = (line) => {
    send(`line:${line.key}`, "visual", line.title);
    setMatch(null);
    setPaused(false);
  };

  // ---- Screen -----------------------------------------------------------------
  const recSeconds = recFor ? Math.round((now - recFor.startedAt) / 1000) : 0;
  return (
    <div style={{ fontFamily: FONT, color: "#1a1a1a", background: "#f6f6f7", minHeight: "100vh", fontSize: "14px" }}>
      <style>{LAYOUT}</style>
      <header style={{ display: "flex", flexWrap: "wrap", gap: "12px", alignItems: "center", padding: "10px 16px", background: "#fff", borderBottom: "1px solid #e3e3e3" }}>
        <strong style={{ fontSize: "16px" }}>Pack camera</strong>
        <span style={{ color: linkError ? "#b42318" : "#1a7f37", fontSize: "13px" }}>{linkError ?? `● Linked to ${userName ?? "the"} pack bench`}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "13px" }}>
          Camera
          <select value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value)} style={{ font: "inherit", padding: "5px 8px", borderRadius: "6px", border: "1px solid #c9c9c9", maxWidth: "260px" }} aria-label="Camera">
            {!devices.length && <option value="">No cameras found</option>}
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        {recFor ? (
          <span role="status" style={{ color: "#c70a24", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            ● REC {recFor.orderName}
            {recFor.part ? ` (${recFor.part})` : ""} {clock(recSeconds)}
          </span>
        ) : (
          <span style={{ color: "#616161", fontSize: "13px" }}>
            {state?.sandbox ? "Sandbox: not recording" : state?.driveProblem ? "Not recording: Google Drive isn't set up" : "Records each box"}
          </span>
        )}
        <span style={{ color: "#616161", fontSize: "13px" }}>
          {uploads.length
            ? sending
              ? `Uploading ${uploads.find((u) => u.id === sending.id)?.orderName ?? ""} ${sending.pct}% · ${uploads.length} waiting`
              : `${uploads.length} video${uploads.length === 1 ? "" : "s"} waiting to upload`
            : "All videos uploaded"}
        </span>
      </header>
      {(state?.driveProblem || uploadError) && (
        <div style={{ margin: "10px 16px 0", padding: "10px 12px", borderRadius: "8px", background: "#fff4d6", fontSize: "13px" }}>{uploadError ?? state.driveProblem}</div>
      )}

      <main className="mbpc-main">
        <section className="mbpc-video">
          <video ref={videoRef} muted playsInline autoPlay className="mbpc-feed" />
          {/* Aim here */}
          <div aria-hidden="true" style={{ position: "absolute", inset: "18% 22%", border: "2px dashed rgba(255,255,255,0.55)", borderRadius: "12px", pointerEvents: "none" }} />
          {camError && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#fff", padding: "24px", textAlign: "center", background: "rgba(0,0,0,0.6)" }}>{camError}</div>
          )}
          {flash && (
            <div role="status" style={{ position: "absolute", left: "12px", right: "12px", bottom: "12px", padding: "10px 14px", borderRadius: "10px", fontWeight: 700, color: "#fff", background: flash.ok ? "rgba(26,127,55,0.92)" : "rgba(180,35,24,0.92)" }}>
              {flash.text}
            </div>
          )}
          {reader?.kind === "none" && <div style={{ position: "absolute", top: "10px", left: "10px", color: "#fff", fontSize: "12px", background: "rgba(0,0,0,0.5)", padding: "4px 8px", borderRadius: "6px" }}>Barcode reading isn't available in this browser</div>}
        </section>

        <aside style={{ background: "#fff", borderRadius: "12px", padding: "14px", border: "1px solid #e3e3e3" }}>
          {!box ? (
            <div style={{ color: "#616161" }}>
              {state?.batch ? (
                <>
                  <strong style={{ color: "#1a1a1a" }}>No box open.</strong> Hold a packing slip barcode up to the camera, or pick an order below.
                </>
              ) : state ? (
                <>
                  <strong style={{ color: "#1a1a1a" }}>No batch open.</strong> Open a batch's Pack page on the pack bench.
                </>
              ) : (
                "Connecting to the pack bench…"
              )}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
                <strong style={{ fontSize: "18px" }}>
                  {box.orderName}
                  {box.part ? <span style={{ color: "#616161", fontWeight: 500 }}> ({box.part})</span> : null}
                </strong>
                <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: box.state === "batched" ? "#1a1a1a" : "#1a7f37" }}>
                  {box.state === "batched" ? `${box.scanned} / ${box.units}` : "Packed ✓"}
                </span>
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: "10px 0", display: "grid", gap: "8px" }}>
                {box.lines.map((l) => (
                  <li key={l.key} style={{ display: "flex", gap: "10px", alignItems: "center", padding: "6px", borderRadius: "8px", background: l.scanned >= l.qty ? "#f1f8f5" : "#fafafa" }}>
                    {l.imageUrl ? <img src={largerImage(l.imageUrl, 120)} alt="" width="48" height="48" style={{ objectFit: "cover", borderRadius: "6px", background: "#eee" }} /> : <span style={{ width: 48, height: 48, borderRadius: 6, background: "#eee" }} />}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600 }}>{l.title}</span>
                      <span style={{ color: "#616161", fontSize: "12px" }}>{[l.variantTitle, l.barcode || l.sku || "No barcode"].filter(Boolean).join(" · ")}</span>
                    </span>
                    <strong style={{ fontVariantNumeric: "tabular-nums", color: l.scanned >= l.qty ? "#1a7f37" : "#1a1a1a" }}>
                      {l.scanned}/{l.qty}
                    </strong>
                  </li>
                ))}
              </ul>
              {box.state === "batched" && (
                <button
                  type="button"
                  onClick={matchByPhoto}
                  disabled={!stream || Boolean(match)}
                  style={{ width: "100%", padding: "10px", borderRadius: "999px", border: 0, background: PINK, color: "#1a1a1a", fontWeight: 700, font: "inherit", cursor: "pointer" }}
                >
                  No barcode? Match by photo
                </button>
              )}
            </>
          )}
          {state?.batch && (!box || box.state !== "batched") && <BatchBoxes batch={state.batch} openId={box?.id} onOpen={(b) => send(b.code, "barcode", b.orderName)} />}
        </aside>
      </main>

      {match && (
        <div role="dialog" aria-modal="true" aria-label="Match by photo" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", padding: "16px", zIndex: 10 }}>
          <div style={{ background: "#fff", borderRadius: "12px", width: "min(820px, 100%)", maxHeight: "90vh", overflow: "auto", padding: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <strong style={{ fontSize: "17px" }}>Which item is this?</strong>
              <button
                type="button"
                onClick={() => {
                  setMatch(null);
                  setPaused(false);
                }}
                aria-label="Close"
                style={{ border: 0, background: "none", fontSize: "22px", cursor: "pointer" }}
              >
                ×
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: "16px", alignItems: "start" }}>
              <div>
                <img src={match.photo} alt="Your photo" style={{ width: "100%", borderRadius: "10px", display: "block" }} />
                <div style={{ color: "#616161", fontSize: "12px", marginTop: "4px" }}>Your photo</div>
              </div>
              <div>
                {match.loading && <p style={{ color: "#616161" }}>{match.loading} (the first time takes a few seconds)</p>}
                {match.error && <p style={{ color: "#8a6116" }}>{match.error}</p>}
                {match.ranked && (
                  <>
                    <p style={{ margin: "0 0 8px", color: "#616161", fontSize: "13px" }}>
                      {match.confidence === "high"
                        ? "Best match first. Check it against the item in your hand, then confirm."
                        : match.confidence === "none"
                          ? "Compare by eye and pick the item you're holding."
                          : "Not a clear match: compare carefully before confirming."}
                    </p>
                    <div style={{ display: "grid", gap: "8px" }}>
                      {match.ranked.map((l, i) => (
                        <div key={l.key} style={{ display: "flex", gap: "12px", alignItems: "center", padding: "8px", borderRadius: "10px", border: `2px solid ${i === 0 && match.confidence !== "none" ? (match.confidence === "high" ? "#36a15a" : "#e3b400") : "#e3e3e3"}` }}>
                          {l.imageUrl ? <img src={largerImage(l.imageUrl, 240)} alt="" width="96" height="96" style={{ objectFit: "cover", borderRadius: "8px", background: "#eee" }} /> : <span style={{ width: 96, height: 96, borderRadius: 8, background: "#eee", display: "grid", placeItems: "center", color: "#8a8a8a", fontSize: "12px" }}>No image</span>}
                          <span style={{ flex: 1 }}>
                            <strong>{l.title}</strong>
                            {l.variantTitle && <span style={{ color: "#616161" }}> – {l.variantTitle}</span>}
                            <div style={{ color: "#616161", fontSize: "12px" }}>
                              {l.scanned}/{l.qty} scanned{l.score !== null ? ` · ${Math.round(Math.max(0, l.score) * 100)}% similar` : ""}
                            </div>
                          </span>
                          <button type="button" onClick={() => confirmMatch(l)} style={{ padding: "8px 14px", borderRadius: "999px", border: 0, background: "#303030", color: "#fff", font: "inherit", fontWeight: 700, cursor: "pointer" }}>
                            This one
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {uploads.length > 0 && (
        <footer style={{ padding: "0 16px 16px", color: "#616161", fontSize: "12px" }}>
          Waiting to upload (kept in this browser until Google Drive has them):{" "}
          {uploads.map((u) => `${u.orderName}${u.part ? ` (${u.part})` : ""} · ${mb(u.blob.size)}`).join(", ")}
        </footer>
      )}
    </div>
  );
}
