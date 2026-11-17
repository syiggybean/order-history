import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import { appUrl } from "../print.server";
import { PackCamError, createClip, listRecordings, revokeClip } from "../packcam.server";

// Packing videos: every box's recording (Pack Cam or the built-in camera), kept
// private in Google Drive. Staff can make a customer clip: part of a recording
// that a packing Mac cuts and the customer sees on their order, for a while.

export const loader = async ({ request }) => {
  const { session, user, noAccess } = await loadWithAccess(request, "packingVideos", "view");
  if (noAccess) return { noAccess: true };
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return { q, canClips: can(user, "packingVideos", "clips"), recordings: await listRecordings(session.shop, { q, appOrigin: appUrl(request) }) };
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  if (!can(user, "packingVideos", "view")) return denied("packingVideos", "view");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (intent === "refresh") return { intent, recordings: await listRecordings(session.shop, { q: String(form.get("q") ?? ""), appOrigin: appUrl(request) }) };
    if (!can(user, "packingVideos", "clips")) return denied("packingVideos", "clips");
    if (intent === "createClip") {
      const clip = await createClip(session.shop, admin, user, {
        videoId: form.get("videoId"),
        startSeconds: form.get("start"),
        endSeconds: form.get("end"),
        availabilityDays: form.get("days"),
        notifyCustomer: form.get("notify") === "1",
      });
      return { intent, ok: true, videoId: Number(form.get("videoId")), clip };
    }
    if (intent === "revokeClip") return { intent, ok: true, clip: await revokeClip(session.shop, user, form.get("clipId")) };
  } catch (e) {
    if (!(e instanceof PackCamError)) console.error(`[packing-videos] ${intent}:`, e);
    return { intent, error: e instanceof PackCamError ? e.message : errorMessage(e), videoId: Number(form.get("videoId")) || null };
  }
  return { intent, error: "Unknown action" };
};

// ---------------------------------------------------------------------------

const muted = { color: "#616161", fontSize: "13px" };
const input = { padding: "6px 9px", border: "1px solid #c9c9c9", borderRadius: "8px", font: "inherit", fontSize: "14px" };
const btn = { appearance: "none", border: "1px solid #c9c9c9", background: "#fff", borderRadius: "8px", padding: "5px 10px", font: "inherit", fontSize: "13px", cursor: "pointer" };
const fmt = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "—");
const when = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const CLIP = {
  queued: { text: "Waiting for a packing Mac to cut it", color: "#1c4a9c" },
  cutting: { text: "Being cut on a packing Mac…", color: "#1c4a9c" },
  published: { text: "Shown in the customer's account", color: "#1a7f37" },
  failed: { text: "Couldn't be made", color: "#b42318" },
  revoked: { text: "Revoked", color: "#616161" },
  expired: { text: "Expired", color: "#616161" },
};

export default function PackingVideos() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Packing videos" />;
  return <Page data={data} />;
}

function Page({ data }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(data.q ?? "");
  const refresh = useFetcher();
  const recordings = refresh.data?.recordings ?? data.recordings;
  // While a clip is being made, check on it every 10 seconds
  const working = recordings.some((r) => r.clips.some((c) => c.status === "queued" || c.status === "cutting"));
  const submit = useRef(refresh.submit);
  submit.current = refresh.submit;
  useEffect(() => {
    if (!working) return undefined;
    const t = setInterval(() => document.visibilityState === "visible" && submit.current({ intent: "refresh", q: params.get("q") ?? "" }, { method: "post" }), 10_000);
    return () => clearInterval(t);
  }, [working, params]);
  const reload = () => refresh.submit({ intent: "refresh", q: params.get("q") ?? "" }, { method: "post" });

  return (
    <s-page heading="Packing videos">
      <s-section>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParams(q.trim() ? { q: q.trim() } : {});
          }}
          style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Order number or customer name" aria-label="Search packing videos" style={{ ...input, flex: "1 1 280px" }} />
          <s-button type="submit" variant="primary" onClick={() => setParams(q.trim() ? { q: q.trim() } : {})}>
            Search
          </s-button>
        </form>
        <div style={{ ...muted, marginTop: "8px" }}>
          Recordings stay private in Google Drive. A customer clip is cut on a packing Mac (Pack Cam) and shown on the customer's order until it expires or is revoked.
        </div>
      </s-section>
      <s-section heading={recordings.length ? `${recordings.length} recording${recordings.length === 1 ? "" : "s"}${data.q ? ` for “${data.q}”` : ""}` : "No recordings"}>
        {!recordings.length && <div style={muted}>{data.q ? "No packing videos matched." : "No packing videos have been saved yet."}</div>}
        <div style={{ display: "grid", gap: "12px" }}>
          {recordings.map((r) => (
            <Recording key={r.id} r={r} canClips={data.canClips} onChange={reload} />
          ))}
        </div>
      </s-section>
    </s-page>
  );
}

function Recording({ r, canClips, onChange }) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const video = useRef(null);
  const act = useFetcher();
  const latest = r.clips[0] ?? null;
  const busy = latest && (latest.status === "queued" || latest.status === "cutting");
  useEffect(() => {
    if (act.state === "idle" && act.data?.ok) {
      setMaking(false);
      onChange();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act.state, act.data]);
  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", padding: "12px 14px", background: "#fff" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "baseline" }}>
        <strong style={{ fontSize: "15px" }}>{r.orderName}</strong>
        <span>{r.customerName ?? <span style={muted}>No customer</span>}</span>
        <span style={muted}>
          Packed {when(r.at)}
          {r.packedBy ? ` by ${r.packedBy}` : ""} · {fmt(r.seconds)} · {r.camera}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} onClick={() => setOpen((x) => !x)}>
          {open ? "Hide video" : "Watch"}
        </button>
        {canClips && !busy && latest?.status !== "published" && (
          <button
            type="button"
            style={btn}
            disabled={!r.hasCustomer}
            title={r.hasCustomer ? "" : "This order has no customer account, so there's nowhere to show a clip."}
            onClick={() => {
              setOpen(true);
              setMaking(true);
            }}
          >
            Make customer clip
          </button>
        )}
      </div>

      {r.clips.length > 0 && (
        <div style={{ display: "grid", gap: "4px", marginTop: "8px" }}>
          {r.clips.slice(0, 3).map((c, i) => (
            <div key={c.id} style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", fontSize: "13px", opacity: i ? 0.7 : 1 }}>
              <span style={{ color: CLIP[c.status]?.color }}>● {CLIP[c.status]?.text ?? c.status}</span>
              <span style={muted}>
                {fmt(c.startSeconds)}–{fmt(c.endSeconds)}
                {c.status === "published" && c.expiresAt ? ` · until ${new Date(c.expiresAt).toLocaleDateString("en-US")}` : ""}
                {c.notifiedAt ? " · customer emailed" : ""}
                {c.createdBy ? ` · by ${c.createdBy}` : ""}
              </span>
              {c.status === "failed" && c.error && <span style={{ color: "#b42318" }}>{c.error}</span>}
              {c.watchUrl && (
                <a href={c.watchUrl} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                  Watch clip
                </a>
              )}
              {canClips && (c.status === "published" || c.status === "queued") && (
                <button type="button" style={{ ...btn, border: 0, padding: 0, color: "#b42318" }} onClick={() => act.submit({ intent: "revokeClip", clipId: String(c.id) }, { method: "post" })}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div style={{ marginTop: "10px" }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={video} src={r.previewUrl} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: "520px", background: "#111", borderRadius: "8px" }} />
          {r.camera.startsWith("Pack Cam") && <div style={{ ...muted, fontSize: "12px", marginTop: "4px" }}>Pack Cam records HEVC: it plays in Safari and Chrome on a Mac. If it won't play, use Safari.</div>}
        </div>
      )}
      {open && making && <ClipForm r={r} video={video} act={act} onCancel={() => setMaking(false)} />}
      {act.data?.error && <div style={{ color: "#b42318", fontSize: "13px", marginTop: "6px" }}>{act.data.error}</div>}
    </div>
  );
}

function ClipForm({ r, video, act, onCancel }) {
  const max = r.seconds ?? 0;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(max, 600));
  const [days, setDays] = useState(30);
  const [notify, setNotify] = useState(true);
  const now = () => Math.round((video.current?.currentTime ?? 0) * 10) / 10;
  const length = end - start;
  const problem = !(end > start) ? "The end has to be after the start." : length > 600 ? "A clip can be at most 10 minutes." : end > max + 1 ? `The video is ${fmt(max)} long.` : null;
  const num = (v) => Math.max(0, Number(v) || 0);
  return (
    <div style={{ marginTop: "10px", padding: "12px", background: "#f7f7f7", borderRadius: "8px", display: "grid", gap: "10px", fontSize: "14px" }}>
      <strong>Customer clip of {r.orderName}</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "center" }}>
        <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          Start
          <input type="number" min="0" step="0.1" value={start} onChange={(e) => setStart(num(e.target.value))} style={{ ...input, width: "90px" }} aria-label="Start (seconds)" />
          <button type="button" style={btn} onClick={() => setStart(now())}>
            Use video's time
          </button>
        </label>
        <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          End
          <input type="number" min="0" step="0.1" value={end} onChange={(e) => setEnd(num(e.target.value))} style={{ ...input, width: "90px" }} aria-label="End (seconds)" />
          <button type="button" style={btn} onClick={() => setEnd(now())}>
            Use video's time
          </button>
        </label>
        <span style={muted}>
          {fmt(start)}–{fmt(end)} ({Math.max(0, Math.round(length))} s)
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "center" }}>
        <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          Available for
          <input type="number" min="1" max="365" value={days} onChange={(e) => setDays(Math.round(num(e.target.value)))} style={{ ...input, width: "70px" }} aria-label="Days available" />
          days
        </label>
        <label style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer when it's ready
        </label>
      </div>
      {problem && <div style={{ color: "#b42318", fontSize: "13px" }}>{problem}</div>}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <s-button
          variant="primary"
          onClick={() =>
            act.submit({ intent: "createClip", videoId: String(r.id), start: String(start), end: String(end), days: String(days), notify: notify ? "1" : "" }, { method: "post" })
          }
          {...(problem ? { disabled: true } : {})}
          {...(act.state !== "idle" ? { loading: true } : {})}
        >
          Make clip
        </s-button>
        <s-button onClick={onCancel}>Cancel</s-button>
        <span style={muted}>A packing Mac running Pack Cam cuts it (usually within a minute), then it appears on the customer's order.</span>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
