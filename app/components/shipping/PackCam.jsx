import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ago, input, muted, small } from "./ui";

// ---------------------------------------------------------------------------
// Pack Cam (the Packing Station Mac app) in MonkeyBean:
//   - settings: connect each packing computer's Pack Cam, upload the installer
//   - the pack bench: Pack Cam is the camera when it's running on this bench's
//     computer; otherwise offer Install / Update / Try again alongside the
//     built-in (browser) camera, which always works straight away
// ---------------------------------------------------------------------------

const btn = { appearance: "none", border: "1px solid #c9c9c9", background: "#fff", borderRadius: "8px", padding: "5px 10px", font: "inherit", fontSize: "13px", cursor: "pointer" };
const linkBtn = { ...btn, border: 0, color: "#005bd3", padding: 0, background: "none" };
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// Opens packcam:// links without leaving the page (does nothing if Pack Cam isn't installed).
// Only straight after a click. Inside Shopify admin MonkeyBean runs in a frame that
// can't open another app itself (Chrome replaces the frame with "This content is
// blocked"), so the link goes to the whole window: the browser asks to open Pack
// Cam and the page stays where it is.
export function openPackCam(url) {
  if (!url) return;
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  let framed = true;
  try {
    framed = window.top !== window.self;
  } catch {
    // Cross-origin parent: framed
  }
  if (framed) a.target = "_top";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The installer download: a fresh signed link each time, opened in a new tab
function useDownload() {
  const f = useFetcher();
  const want = useRef(null);
  const start = () => {
    // A tab opened now (a later one would be blocked), sent to the link when it arrives
    want.current = window.open("", "_blank");
    f.submit({ intent: "packCamDownload" }, { method: "post" });
  };
  useEffect(() => {
    const d = f.data;
    if (d?.intent !== "packCamDownload" || f.state !== "idle") return;
    if (d.ok && d.url) {
      if (want.current) want.current.location.href = d.url;
      else window.location.href = d.url;
    } else want.current?.close();
    want.current = null;
  }, [f.data, f.state]);
  return { start, busy: f.state !== "idle", error: f.data?.intent === "packCamDownload" ? f.data.error : null };
}

// A ready-made link that opens Pack Cam already connected to this bench's
// packing computer (packcam://connect with a one-time code). Fetched ahead of
// time, because browsers only let a page open another app straight after a
// click. Codes last 15 minutes, so it's renewed every 10.
function useConnectLink(stationId, wanted) {
  const f = useFetcher();
  const submit = useRef(f.submit);
  submit.current = f.submit;
  useEffect(() => {
    if (!wanted || !stationId) return undefined;
    const ask = () => submit.current({ intent: "packCamPairCode", stationId: String(stationId) }, { method: "post" });
    ask();
    const t = setInterval(ask, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, [stationId, wanted]);
  const d = f.data?.intent === "packCamPairCode" && f.data.stationId === Number(stationId) ? f.data : null;
  return { url: d?.ok ? d.url : null, code: d?.ok ? d.code : null, error: d?.error ?? null };
}

// ---- Settings: one packing computer's Pack Cam ------------------------------

export function PackCamStationRow({ st, canSettings, latest }) {
  const pc = st.packCam ?? {};
  const forget = useFetcher();
  const [confirm, setConfirm] = useState(false);
  const outdated = Boolean(latest && pc.version && isOlder(pc.version, latest.version));
  const status = !pc.paired
    ? { text: "Not connected", color: "#616161" }
    : pc.running
      ? { text: outdated ? `Running ${pc.version}, update to ${latest.version}` : `Running${pc.version ? ` ${pc.version}` : ""}`, color: outdated ? "#8a6116" : "#1a7f37" }
      : { text: `Not running${pc.seenAt ? ` (last seen ${ago(pc.seenAt)})` : ""}`, color: "#8a6116" };
  return (
    <div style={{ borderTop: "1px solid #ebebeb", marginTop: "10px", paddingTop: "10px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", fontSize: "13px" }}>
        <strong>🎥 Pack Cam</strong>
        <span style={{ color: status.color }}>● {status.text}</span>
        {pc.paired && (pc.host || pc.camera) && <span style={small}>{[pc.host, pc.camera].filter(Boolean).join(" · ")}</span>}
        <span style={{ flex: 1 }} />
        {!pc.paired && <span style={small}>Connects from the pack bench on that Mac (Open Pack Cam).</span>}
        {canSettings &&
          pc.paired &&
          (confirm ? (
            <>
              <span>Disconnect Pack Cam from {st.name}? Its Mac stops recording until connected again.</span>
              <button
                type="button"
                style={{ ...btn, borderColor: "#b42318", color: "#b42318" }}
                onClick={() => {
                  forget.submit({ intent: "packCamForget", stationId: String(st.id) }, { method: "post" });
                  setConfirm(false);
                }}
              >
                Disconnect
              </button>
              <button type="button" style={btn} onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" style={{ ...linkBtn, color: "#b42318" }} onClick={() => setConfirm(true)}>
              Disconnect
            </button>
          ))}
        {forget.data?.error && <span style={{ color: "#b42318" }}>{forget.data.error}</span>}
        {forget.data?.ok && !pc.paired && <span style={small}>Disconnected.</span>}
      </div>
    </div>
  );
}

// ---- Settings: the installer ------------------------------------------------

export function PackCamInstaller({ packCam, canSettings }) {
  const up = useFetcher();
  const dl = useDownload();
  const [version, setVersion] = useState("");
  const [file, setFile] = useState(null);
  const fileRef = useRef(null);
  const releases = up.data?.intent === "packCamRelease" && up.data.releases ? up.data.releases : (packCam?.releases ?? []);
  const latest = releases[0] ?? packCam?.latest ?? null;
  useEffect(() => {
    if (up.data?.intent === "packCamRelease" && up.data.ok) {
      setVersion("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [up.data]);
  const send = () => {
    const fd = new FormData();
    fd.set("intent", "packCamRelease");
    fd.set("version", version.trim());
    fd.set("file", file);
    up.submit(fd, { method: "post", encType: "multipart/form-data" });
  };
  // "Pack Cam 1.2.0.pkg" → 1.2.0, to save typing
  const pick = (f) => {
    setFile(f);
    const m = f?.name.match(/(\d+\.\d+(?:\.\d+){0,2})/);
    if (m && !version) setVersion(m[1]);
  };
  return (
    <div style={{ marginTop: "14px", padding: "12px 14px", border: "1px solid #e3e3e3", borderRadius: "10px", background: "#fff" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <strong>🎥 Pack Cam installer</strong>
        {latest ? (
          <span style={small}>
            Version {latest.version} · {latest.fileName} · {mb(latest.sizeBytes)}
            {latest.uploadedBy ? ` · uploaded by ${latest.uploadedBy}` : ""}
          </span>
        ) : (
          <span style={small}>None uploaded yet. Packing benches can't offer Pack Cam until there is one.</span>
        )}
        <span style={{ flex: 1 }} />
        {latest && (
          <button type="button" style={btn} onClick={dl.start} disabled={dl.busy}>
            Download
          </button>
        )}
      </div>
      <p style={{ ...muted, fontSize: "12px", margin: "6px 0 0" }}>
        Pack Cam records each box on the packing Mac and is the pack bench's camera when it's running. Benches offer this installer when Pack Cam is missing or older,
        alongside the built-in camera. It must be the signed and notarized .pkg, or macOS won't open it.
      </p>
      {dl.error && <div style={{ color: "#b42318", fontSize: "13px", marginTop: "6px" }}>{dl.error}</div>}
      {canSettings && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "10px" }}>
          <input ref={fileRef} type="file" accept=".pkg" onChange={(e) => pick(e.target.files?.[0] ?? null)} aria-label="Pack Cam installer" style={{ fontSize: "13px" }} />
          <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="Version, e.g. 1.0.0" aria-label="Version" style={{ ...input, width: "150px" }} />
          <s-button onClick={send} {...(!file || !version.trim() ? { disabled: true } : {})} {...(up.state !== "idle" ? { loading: true } : {})}>
            Upload new version
          </s-button>
          {up.data?.intent === "packCamRelease" && up.data.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{up.data.error}</span>}
          {up.data?.intent === "packCamRelease" && up.data.ok && <span style={{ color: "#1a5e20", fontSize: "13px" }}>Version {up.data.release.version} is now offered to every bench.</span>}
        </div>
      )}
      {releases.length > 1 && (
        <div style={{ ...small, marginTop: "8px" }}>Earlier: {releases.slice(1).map((r) => `${r.version} (${new Date(r.createdAt).toLocaleDateString("en-US")})`).join(", ")}</div>
      )}
    </div>
  );
}

// ---- The pack bench ---------------------------------------------------------

const DISMISS = "mb-packcam-dismissed";

// Pack Cam on this bench's computer: { state, ... } from the server, checked every few seconds
export function usePackCamStatus(stationId, enabled = true) {
  const f = useFetcher();
  const [status, setStatus] = useState(null);
  const submit = useRef(f.submit);
  submit.current = f.submit;
  const fast = status && status.state !== "ready";
  useEffect(() => {
    if (!enabled) return undefined;
    const ask = () => submit.current({ intent: "packCamStatus", stationId: stationId ? String(stationId) : "" }, { method: "post" });
    ask();
    const t = setInterval(() => document.visibilityState === "visible" && ask(), fast ? 4000 : 8000);
    return () => clearInterval(t);
  }, [stationId, enabled, fast]);
  useEffect(() => {
    if (f.data?.intent === "packCamStatus" && f.data.ok) setStatus(f.data);
  }, [f.data]);
  return status;
}

// What the bench offers when Pack Cam isn't recording here: one "Open Pack Cam"
// button that opens it (connecting this bench's computer if it isn't yet). If
// Pack Cam doesn't answer soon after, it's probably not installed (or broken),
// so installing it becomes the main choice.
const GIVE_UP_MS = 15_000;

export function PackCamPrompt({ status, usingBuiltIn, onBuiltIn }) {
  const dl = useDownload();
  const unpaired = status?.state === "notInstalled";
  const link = useConnectLink(status?.station?.id, Boolean(status) && unpaired);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS) === "1";
    } catch {
      return false;
    }
  });
  const [tried, setTried] = useState(null); // when "Open Pack Cam" was last clicked
  const [now, setNow] = useState(() => Date.now());
  const [showCode, setShowCode] = useState(false);
  useEffect(() => {
    if (!tried) return undefined;
    const t = setTimeout(() => setNow(Date.now()), GIVE_UP_MS + 200);
    return () => clearTimeout(t);
  }, [tried]);
  if (!status || status.state === "none" || status.state === "ready" || dismissed) return null;
  const hasInstaller = Boolean(status.latest);
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS, "1");
    } catch {
      /* not saved */
    }
    setDismissed(true);
  };
  const where = status.station?.name ?? "this computer";
  const openUrl = unpaired ? link.url : status.launchUrl;
  const noAnswer = Boolean(tried && now - tried >= GIVE_UP_MS);
  const open = () => {
    if (!openUrl) return;
    openPackCam(openUrl);
    setTried(Date.now());
    setNow(Date.now());
  };
  const msg =
    status.state === "outdated"
      ? `Pack Cam on ${where} is out of date (${status.version}; ${status.latest?.version} is available).`
      : noAnswer
        ? `Pack Cam didn't open on ${where}. It may not be installed, or it needs reinstalling.`
        : tried
          ? "Opening Pack Cam…"
          : `Pack Cam isn't running on ${where}.`;
  const dark = { ...btn, background: "#1a1a1a", color: "#fff", borderColor: "#1a1a1a" };
  const installFirst = noAnswer || status.state === "outdated";
  return (
    <div
      role="region"
      aria-label="Pack Cam"
      style={{ flexBasis: "100%", background: "#fffbea", border: "1px solid #ecd58f", borderRadius: "10px", padding: "10px 12px", boxSizing: "border-box", fontSize: "13px" }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <strong>🎥 {msg}</strong>
        <span style={{ color: "#5c4b00" }}>{usingBuiltIn ? "The built-in camera is recording this bench meanwhile." : "You can use the built-in camera meanwhile."}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "8px" }}>
        {status.state !== "outdated" && (
          <button type="button" style={installFirst ? btn : dark} onClick={open} disabled={!openUrl}>
            {noAnswer ? "Try opening again" : "Open Pack Cam"}
          </button>
        )}
        {hasInstaller && (
          <button type="button" style={installFirst ? dark : btn} onClick={dl.start} disabled={dl.busy}>
            {status.state === "outdated" ? `Update to ${status.latest.version}` : noAnswer ? "Install Pack Cam" : "Install or reinstall"}
          </button>
        )}
        {!usingBuiltIn && (
          <button type="button" style={btn} onClick={onBuiltIn}>
            📷 Use built-in camera
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...linkBtn, color: "#616161", fontSize: "12px" }} onClick={dismiss} title="This browser stops offering Pack Cam">
          Don't ask again on this computer
        </button>
      </div>
      {!hasInstaller && <div style={{ ...small, marginTop: "6px" }}>No installer has been uploaded yet (Shipping → Settings → Packing computers).</div>}
      {noAnswer && hasInstaller && (
        <div style={{ ...small, marginTop: "6px" }}>
          After installing, Pack Cam opens by itself. If it asks to connect, come back here and click Open Pack Cam.
          {unpaired && link.code && (
            <>
              {" "}
              {showCode ? (
                <>
                  Or type this code in Pack Cam: <strong style={{ letterSpacing: "2px" }}>{link.code}</strong>
                </>
              ) : (
                <button type="button" style={{ ...linkBtn, fontSize: "12px" }} onClick={() => setShowCode(true)}>
                  Show a code to type instead
                </button>
              )}
            </>
          )}
        </div>
      )}
      {(dl.error || link.error) && <div style={{ color: "#b42318", marginTop: "6px" }}>{dl.error || link.error}</div>}
    </div>
  );
}

// "1.10.0" vs "1.9.2"
export function isOlder(have, want) {
  if (!have || !want) return false;
  const a = String(have).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const b = String(want).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y;
    return String(x) < String(y);
  }
  return false;
}
