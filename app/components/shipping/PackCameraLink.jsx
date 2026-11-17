import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { muted, small } from "./ui";
import { usePrinting } from "./Printing";
import { PackCamPrompt, usePackCamStatus } from "./PackCam";

// The pack bench's side of the pack camera (a separate window, because Shopify's
// admin doesn't give embedded apps the camera):
//   - opens the camera window (or shows a link and QR code for another device)
//   - tells it which box is open, so it can show the items and record the box
//   - picks up its scans and hands them to the bench like a handheld scanner's
// onScans([{ code, via }]) is called with each batch of scans.
//
// Pack Cam (the Mac app) on this bench's packing computer ("Printing on") is the
// camera when it's running there: the bench then works with it automatically,
// exactly as with a camera window. When it isn't, the bench offers to install,
// update or open it, next to the built-in camera.

const QR_URL = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
const WIN = "mb-pack-camera";
const FEATURES = "popup=yes,width=1280,height=860";

export function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = QR_URL;
    s.onload = () => resolve(window.qrcode);
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export function usePackCamera({ batchId, box, onScans, enabled = true }) {
  const { stationId } = usePrinting();
  const packCam = usePackCamStatus(stationId, enabled);
  const packCamReady = packCam?.state === "ready" || packCam?.state === "outdated"; // an older Pack Cam still records
  const scans = useFetcher();
  const ctx = useFetcher();
  const [cameras, setCameras] = useState([]);
  const [polling, setPolling] = useState(false);
  const onScansRef = useRef(onScans);
  onScansRef.current = onScans;
  const scansRef = useRef(scans); // the latest fetcher (the interval below outlives renders)
  scansRef.current = scans;

  // On opening the bench: is a camera already linked?
  useEffect(() => {
    if (enabled) scans.submit({ intent: "cameraScans" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => {
    const d = scans.data;
    if (d?.intent !== "cameraScans" || !d.ok) return;
    setCameras(d.cameras ?? []);
    if (d.cameras?.length) setPolling(true);
    if (d.scans?.length) onScansRef.current(d.scans);
  }, [scans.data]);
  // Pack Cam running on this computer: work with it like a linked camera
  useEffect(() => {
    if (packCamReady && enabled) setPolling(true);
  }, [packCamReady, enabled]);
  // About once a second while a camera is linked
  useEffect(() => {
    if (!polling || !enabled) return undefined;
    const t = setInterval(() => {
      const f = scansRef.current;
      if (f.state === "idle") f.submit({ intent: "cameraScans" }, { method: "post" });
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, enabled]);

  // Tell the camera which box is open (and when it's packed)
  const boxKey = box ? `${box.id}:${box.state}` : "none";
  useEffect(() => {
    if (!polling || !enabled) return;
    ctx.submit({ intent: "cameraContext", batchId: String(batchId), shipmentId: box ? String(box.id) : "", stationId: stationId ? String(stationId) : "" }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxKey, polling, enabled, batchId, stationId, packCamReady]);

  // What's open now, for a new camera link to start from
  const context = { batchId: batchId ? String(batchId) : "", shipmentId: box ? String(box.id) : "" };
  return { cameras, linked: polling, context, packCam, packCamReady, startPolling: () => setPolling(true), stopPolling: () => setPolling(false) };
}

export function PackCameraBar({ cam }) {
  const link = useFetcher();
  const unlink = useFetcher();
  const [other, setOther] = useState(null); // { url, qr, blocked } for another device (or a blocked window)
  const pending = useRef(null); // the window opened on click, waiting for its link
  const busy = link.state !== "idle";

  const wanted = useRef(false); // a window was asked for (not "another device")
  const open = (forOther = false) => {
    // Open the window straight away (browsers block windows opened later), then send it to the link
    wanted.current = !forOther;
    if (!forOther) pending.current = window.open("", WIN, FEATURES);
    link.submit({ intent: "cameraLink", other: forOther ? "1" : "", ...cam.context }, { method: "post" });
  };
  useEffect(() => {
    const d = link.data;
    if (d?.intent !== "cameraLink" || link.state !== "idle") return;
    if (!d.ok) {
      pending.current?.close();
      pending.current = null;
      return;
    }
    cam.startPolling();
    if (pending.current) {
      pending.current.location.href = d.url;
      pending.current.focus?.();
      pending.current = null;
    } else {
      const blocked = wanted.current;
      setOther({ url: d.url, qr: null, blocked });
      loadQr()
        .then((qrcode) => {
          const q = qrcode(0, "M");
          q.addData(d.url);
          q.make();
          setOther({ url: d.url, qr: q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }), blocked });
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.data, link.state]);
  useEffect(() => {
    if (unlink.data?.intent === "cameraUnlink" && unlink.data.ok) {
      if (!cam.packCamReady) cam.stopPolling();
      setOther(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlink.data]);

  // Camera windows (browser) and Pack Cam are shown separately
  const windows = cam.cameras.filter((c) => !c.packCam);
  const connected = windows.filter((c) => c.connected);
  const packCamLive = cam.cameras.some((c) => c.packCam && c.connected);
  const usingBuiltIn = windows.length > 0;
  const btn = { appearance: "none", border: "1px solid #c9c9c9", background: "#fff", borderRadius: "8px", padding: "5px 10px", font: "inherit", fontSize: "13px", cursor: "pointer" };
  // The QR code panel sits in the page (a full-width row under the toolbar) rather
  // than floating, so it's never cut off on a short page
  return (
    <>
      <div style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
        {cam.packCamReady && (
          <span style={{ ...small, color: packCamLive ? "#1a7f37" : "#8a6116" }} title={[cam.packCam?.host, cam.packCam?.camera].filter(Boolean).join(" · ")}>
            🎥 Pack Cam on {cam.packCam?.station?.name}: {packCamLive ? "● connected" : "○ starting…"}
          </span>
        )}
        <button type="button" style={btn} onClick={() => open(false)} disabled={busy}>
          📷 {usingBuiltIn ? "Camera window" : cam.packCamReady ? "Built-in camera" : "Open pack camera"}
        </button>
        {usingBuiltIn && (
          <span style={{ ...small, color: connected.length ? "#1a7f37" : "#8a6116" }} title={connected.map((c) => c.info).filter(Boolean).join(", ")}>
            {connected.length ? `● Camera connected${connected.length > 1 ? ` (${connected.length})` : ""}` : "○ Waiting for the camera…"}
          </span>
        )}
        <button type="button" style={{ ...btn, border: 0, color: "#005bd3", padding: 0 }} onClick={() => open(true)} disabled={busy}>
          Use another device
        </button>
        {usingBuiltIn && (
          <button type="button" style={{ ...btn, border: 0, color: "#005bd3", padding: 0 }} onClick={() => unlink.submit({ intent: "cameraUnlink" }, { method: "post" })}>
            Unlink
          </button>
        )}
        {link.data?.error && <span style={{ ...small, color: "#b42318" }}>{link.data.error}</span>}
      </div>
      <PackCamPrompt status={cam.packCam} usingBuiltIn={usingBuiltIn} onBuiltIn={() => open(false)} />
      {other && (
        <div
          role="region"
          aria-label="Camera on another device"
          style={{ flexBasis: "100%", display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center", background: "#fff", border: "1px solid #e3e3e3", borderRadius: "10px", padding: "12px 14px", boxSizing: "border-box" }}
        >
          {other.qr ? (
            <div style={{ width: "168px", flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: other.qr }} />
          ) : (
            <div style={{ ...small, width: "168px", height: "168px", display: "grid", placeItems: "center", background: "#f6f6f7", borderRadius: "8px" }}>Loading QR code…</div>
          )}
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
              <strong>{other.blocked ? "Open the camera window" : "Camera on another device"}</strong>
              <button type="button" onClick={() => setOther(null)} aria-label="Close" style={{ border: 0, background: "none", fontSize: "18px", cursor: "pointer", lineHeight: 1 }}>
                ×
              </button>
            </div>
            <p style={{ ...muted, fontSize: "12px", margin: "6px 0" }}>
              {other.blocked ? (
                <>
                  The browser blocked the window.{" "}
                  <a href={other.url} target={WIN} rel="opener">
                    Open the pack camera
                  </a>
                  , or allow pop-ups for this site. Or scan the code with another device.
                </>
              ) : (
                "Scan the code with the device's camera app, or open the link on it."
              )}{" "}
              It's linked to you: anyone with the link can scan into your bench, so don't share it.
            </p>
            <input readOnly value={other.url} onFocus={(e) => e.target.select()} aria-label="Camera link" style={{ width: "100%", boxSizing: "border-box", fontSize: "11px", padding: "4px 6px" }} />
          </div>
        </div>
      )}
    </>
  );
}
