import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ago, box, cell, fmtDate, head, input, muted, small } from "./ui";

// ---------------------------------------------------------------------------
// Direct printing through MonkeyBean Print on the packing Macs.
//
// Each browser remembers which packing computer it's on (and the server remembers
// each person's last one, for when the browser forgets). Printing sends a job to that
// computer; if it's off or has no printer chosen, printing falls back to the browser.
// ---------------------------------------------------------------------------

const KEY = "mb-print-station";
const PrintContext = createContext({ stations: [], station: null, stationId: null, choose: () => {} });
export const usePrinting = () => useContext(PrintContext);

export function PrintProvider({ printing, children }) {
  const stations = printing?.stations ?? [];
  const pref = useFetcher();
  // null: never chosen in this browser (use the person's last one); 0: print from the browser
  const [stationId, setStationId] = useState(printing?.myStationId ?? null);
  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v !== null) setStationId(Number(v) || 0);
    } catch {
      /* private mode: the person's last computer is used */
    }
  }, []);
  const choose = (id) => {
    const v = Number(id) || 0;
    setStationId(v);
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      /* fine */
    }
    pref.submit({ intent: "setMyStation", stationId: String(v) }, { method: "post" });
  };
  const station = stations.find((s) => s.id === stationId) ?? null;
  return <PrintContext.Provider value={{ stations, station, stationId, choose }}>{children}</PrintContext.Provider>;
}

// The packing computer's printer for labels or slips, or null (print from the browser)
export function usePrinterFor(role) {
  const { station } = usePrinting();
  if (!station) return null;
  const printer = role === "slip" ? station.slipPrinter : station.labelPrinter;
  return printer ? { station, printer } : null;
}

// Why printing will use the browser's dialog here (null when it goes to a packing computer)
export function useWhyBrowser(role) {
  const { stations, station, stationId } = usePrinting();
  const what = role === "slip" ? "packing slip" : "label";
  if (!stations.length) return null; // no packing computers set up at all: the dialog is expected
  if (!station) {
    return stationId && stationId !== 0
      ? "The packing computer chosen in this browser was removed. Choose this computer under “Printing on”."
      : "This browser isn't set to a packing computer, so the print dialog opens. Choose this computer under “Printing on” to print directly.";
  }
  const printer = role === "slip" ? station.slipPrinter : station.labelPrinter;
  if (!printer) return `${station.name} has no ${what} printer chosen (Shipping → Settings → Packing computers), so the print dialog opens.`;
  return null;
}

const STATUS = {
  queued: (j) => ({ busy: true, text: `Waiting for ${j.station}…` }),
  printing: (j) => ({ busy: true, text: `Printing on ${j.printer}…` }),
  printed: (j) => ({ ok: true, text: `✓ Printed on ${j.printer}` }),
  waiting: (j) => ({
    warn: true,
    text: `⚠ Sent to ${j.printer}, but it hasn't printed yet. The printer may be off, out of labels, or paused on the Mac.`,
  }),
  failed: (j) => ({ error: true, text: `✗ Didn't print: ${j.message ?? "unknown problem"}` }),
  expired: (j) => ({ error: true, text: `✗ ${j.message ?? "Dropped"}` }),
};

// Send something to this computer's printer and follow it until it's printed.
// print(payload, { onFallback(text) }) — onFallback runs when the browser should print instead.
export function useAgentPrint() {
  const { station } = usePrinting();
  const send = useFetcher();
  const poll = useFetcher();
  const [job, setJob] = useState(null);
  const [note, setNote] = useState(null);
  const fallback = useRef(null);
  const handled = useRef(null);
  const polls = useRef(0);

  const print = (payload, { onFallback } = {}) => {
    fallback.current = onFallback ?? null;
    handled.current = null;
    setJob(null);
    setNote({ busy: true, text: `Sending to ${station?.name ?? "the packing computer"}…` });
    send.submit({ intent: "agentPrint", stationId: String(station?.id ?? ""), ...payload }, { method: "post" });
  };

  useEffect(() => {
    const d = send.data;
    if (send.state !== "idle" || !d || handled.current === d) return;
    handled.current = d;
    if (d.fallback) {
      setNote(null);
      if (fallback.current) fallback.current(d.text);
      else setNote({ error: true, text: d.text });
    } else if (d.error) setNote({ error: true, text: d.error });
    else if (d.job) {
      polls.current = 0;
      setJob(d.job);
    }
  }, [send.state, send.data]);

  // Follow the job (about once a second, for up to a minute)
  const submitPoll = useRef(poll.submit);
  submitPoll.current = poll.submit;
  useEffect(() => {
    if (!job || job.done) return undefined;
    const t = setInterval(() => {
      polls.current += 1;
      if (polls.current > 60) {
        clearInterval(t);
        setNote({ warn: true, text: `Still waiting for ${job.station}. Check that the Mac is awake and online.` });
        return;
      }
      submitPoll.current({ intent: "printJobs", ids: JSON.stringify([job.id]) }, { method: "post" });
    }, 1000);
    return () => clearInterval(t);
  }, [job?.id, job?.done]);
  useEffect(() => {
    const j = poll.data?.jobs?.find((x) => x.id === job?.id);
    if (j && (j.status !== job.status || j.done !== job.done)) setJob(j);
  }, [poll.data]);
  useEffect(() => {
    if (job) setNote(STATUS[job.status]?.(job) ?? null);
  }, [job]);

  return { print, note, busy: send.state !== "idle" || Boolean(job && !job.done), job };
}

export function PrintNote({ note, style }) {
  if (!note) return null;
  const color = note.error ? "#b42318" : note.warn ? "#8a6100" : note.ok ? "#1a5e20" : "#4a4a4a";
  return (
    <span role="status" style={{ fontSize: "12px", color, ...style }}>
      {note.text}
    </span>
  );
}

// "Printing on: Packing 1 ▾" — which packing computer this browser is on
export function ThisComputer({ compact = false }) {
  const { stations, stationId, station, choose } = usePrinting();
  if (!stations.length) return null;
  const status = station ? (station.online ? "🟢" : "⚪") : "";
  return (
    <label style={{ display: "inline-flex", gap: "6px", alignItems: "center", fontSize: "13px" }} title="Labels and packing slips print on this computer's printers">
      {!compact && <span style={muted}>Printing on</span>}
      {status && <span aria-hidden="true">{status}</span>}
      <select value={String(stationId ?? 0)} onChange={(e) => choose(e.target.value)} style={{ ...input, padding: "3px 6px", fontSize: "13px" }} aria-label="This computer">
        <option value="0">This browser (print dialog)</option>
        {stations.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.name}
            {s.online ? "" : " (not connected)"}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Settings → Packing computers
// ---------------------------------------------------------------------------

const btn = { appearance: "none", border: "1px solid #c9c9c9", background: "#fff", color: "#1a1a1a", borderRadius: "8px", padding: "5px 10px", font: "inherit", fontSize: "13px", cursor: "pointer" };

function Copy({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      style={btn}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => setDone(true), () => setDone(false));
        setTimeout(() => setDone(false), 2500);
      }}
    >
      {done ? "Copied ✓" : "Copy"}
    </button>
  );
}

function InstallSteps({ install, name }) {
  return (
    <div style={{ marginTop: "10px", padding: "12px", borderRadius: "10px", background: "#f4f8ff", border: "1px solid #b9d2f5" }}>
      <strong>Install on {name}</strong>
      <ol style={{ margin: "6px 0 8px", paddingLeft: "20px", fontSize: "13px", lineHeight: 1.7 }}>
        <li>
          On that Mac, open <strong>Terminal</strong> (press ⌘ Space, type “Terminal”, press Return).
        </li>
        <li>Copy this command, paste it into Terminal and press Return:</li>
      </ol>
      <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
        <code style={{ flex: 1, display: "block", padding: "8px 10px", background: "#fff", border: "1px solid #dfe3e8", borderRadius: "8px", fontSize: "12px", wordBreak: "break-all" }}>{install.command}</code>
        <Copy text={install.command} />
      </div>
      <div style={{ ...small, marginTop: "8px" }}>
        The code in it works once, until {fmtDate(install.expiresAt, true)}. It doesn't need an admin password. The Mac shows up as connected here within a few seconds, with its printers.
      </div>
    </div>
  );
}

function StationCard({ st, install, canSettings, canTest, isThis }) {
  const save = useFetcher();
  const act = useFetcher();
  const test = useAgentTest(st);
  const [f, setF] = useState({ name: st.name, labelPrinter: st.labelPrinter ?? "", slipPrinter: st.slipPrinter ?? "", slipSize: st.slipSize, labelOptions: st.labelOptions, slipOptions: st.slipOptions });
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    // Printers picked automatically on first connect arrive with the refresh
    setF((x) => ({ ...x, labelPrinter: x.labelPrinter || st.labelPrinter || "", slipPrinter: x.slipPrinter || st.slipPrinter || "" }));
  }, [st.labelPrinter, st.slipPrinter]);
  const dirty =
    f.name !== st.name || f.labelPrinter !== (st.labelPrinter ?? "") || f.slipPrinter !== (st.slipPrinter ?? "") || f.slipSize !== st.slipSize || f.labelOptions !== st.labelOptions || f.slipOptions !== st.slipOptions;
  const printerSelect = (k, label) => (
    <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <select value={f[k]} disabled={!canSettings} onChange={(e) => setF({ ...f, [k]: e.target.value })} style={{ ...input, maxWidth: "320px" }}>
        <option value="">None (use the print dialog)</option>
        {st.printers.map((p) => (
          <option key={p.name} value={p.name}>
            {p.description || p.name}
            {p.isDefault ? " · Mac's default" : ""}
            {p.state === "disabled" ? " · paused" : ""}
          </option>
        ))}
        {f[k] && !st.printers.some((p) => p.name === f[k]) && <option value={f[k]}>{f[k]} (not found on the Mac)</option>}
      </select>
    </label>
  );
  // A command made here (Reinstall / New install command); hidden once the Mac has used it
  const fresh = act.data?.intent === "installCode" && act.data.command ? act.data : null;
  const paused = st.printers.filter((p) => p.state === "disabled" && [st.labelPrinter, st.slipPrinter].includes(p.name));

  return (
    <div style={{ border: "1px solid #e3e3e3", borderRadius: "10px", padding: "12px 14px", background: "#fff" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <span aria-hidden="true">{st.online ? "🟢" : st.paired ? "⚪" : "🔵"}</span>
        {canSettings ? (
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Name" style={{ ...input, fontWeight: 600, width: "180px" }} />
        ) : (
          <strong>{st.name}</strong>
        )}
        <span style={small}>
          {st.online ? "Connected" : st.paired ? `Not connected${st.lastSeenAt ? ` · last seen ${ago(st.lastSeenAt)}` : ""}` : "Waiting to be installed"}
          {st.host ? ` · ${st.host}` : ""}
          {st.osVersion ? ` · macOS ${st.osVersion}` : ""}
          {st.agentVersion ? ` · agent v${st.agentVersion}` : ""}
          {st.outdated ? " (updating itself)" : ""}
        </span>
        {isThis && <span style={{ fontSize: "12px", fontWeight: 600, color: "#1a5e20" }}>This computer</span>}
      </div>

      {st.paired && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "16px", marginTop: "10px", alignItems: "flex-end" }}>
          {printerSelect("labelPrinter", "Shipping labels")}
          {printerSelect("slipPrinter", "Packing slips")}
          <label style={{ display: "grid", gap: "4px", fontSize: "13px" }}>
            <span style={{ fontWeight: 600 }}>Slip paper</span>
            <select value={f.slipSize} disabled={!canSettings} onChange={(e) => setF({ ...f, slipSize: e.target.value })} style={input}>
              <option value="letter">Letter (8.5 × 11)</option>
              <option value="4x6">4 × 6 label</option>
            </select>
          </label>
        </div>
      )}
      {st.paired && !st.printers.length && <div style={{ ...small, marginTop: "8px" }}>No printers reported yet. Add the printers in the Mac's System Settings → Printers & Scanners, then Refresh printers.</div>}
      {st.labelZebra && <div style={{ ...small, marginTop: "6px" }}>Zebra label printer: labels in ZPL format print natively; PDF labels print through its Mac driver.</div>}
      {paused.length > 0 && (
        <div style={{ fontSize: "12px", color: "#8a6100", marginTop: "6px" }}>
          ⚠ {paused.map((p) => p.description || p.name).join(", ")} {paused.length === 1 ? "is" : "are"} paused on the Mac. Resume in System Settings → Printers & Scanners (or check the printer's
          paper and cable).
        </div>
      )}
      {st.paired && canSettings && (
        <details style={{ marginTop: "8px", fontSize: "13px" }}>
          <summary style={{ cursor: "pointer", ...small }}>Advanced print options</summary>
          <div style={{ display: "grid", gap: "6px", marginTop: "6px", maxWidth: "520px" }}>
            <label style={{ display: "grid", gap: "2px" }}>
              <span style={small}>Label options (macOS lp, space-separated), e.g. fit-to-page or media=w288h432</span>
              <input value={f.labelOptions} onChange={(e) => setF({ ...f, labelOptions: e.target.value })} style={input} />
            </label>
            <label style={{ display: "grid", gap: "2px" }}>
              <span style={small}>Packing slip options, e.g. sides=two-sided-long-edge</span>
              <input value={f.slipOptions} onChange={(e) => setF({ ...f, slipOptions: e.target.value })} style={input} />
            </label>
          </div>
        </details>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "10px", alignItems: "center" }}>
        {canSettings && st.paired && (
          <s-button
            variant="primary"
            onClick={() => save.submit({ intent: "saveStation", id: String(st.id), ...f }, { method: "post" })}
            {...(save.state !== "idle" ? { loading: true } : {})}
            {...(!dirty ? { disabled: true } : {})}
          >
            Save
          </s-button>
        )}
        {canSettings && !st.paired && f.name !== st.name && (
          <s-button variant="primary" onClick={() => save.submit({ intent: "saveStation", id: String(st.id), name: f.name }, { method: "post" })}>
            Save name
          </s-button>
        )}
        {canTest && st.paired && (
          <>
            <button type="button" style={btn} disabled={!st.labelPrinter || dirty} onClick={() => test.run("label")} title={dirty ? "Save first" : ""}>
              Test label
            </button>
            <button type="button" style={btn} disabled={!st.slipPrinter || dirty} onClick={() => test.run("slip")} title={dirty ? "Save first" : ""}>
              Test slip
            </button>
          </>
        )}
        {canSettings && st.paired && (
          <button type="button" style={btn} onClick={() => act.submit({ intent: "refreshPrinters", id: String(st.id) }, { method: "post" })} disabled={!st.online}>
            Refresh printers
          </button>
        )}
        {canSettings && (
          <button type="button" style={btn} onClick={() => act.submit({ intent: "installCode", id: String(st.id) }, { method: "post" })}>
            {st.paired ? "Reinstall…" : "New install command"}
          </button>
        )}
        {canSettings &&
          (confirmRemove ? (
            <>
              <span style={{ fontSize: "13px" }}>Remove {st.name}? Its Mac stops printing.</span>
              <button type="button" style={{ ...btn, borderColor: "#b42318", color: "#b42318" }} onClick={() => act.submit({ intent: "removeStation", id: String(st.id) }, { method: "post" })}>
                Remove
              </button>
              <button type="button" style={btn} onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" style={{ ...btn, border: 0, color: "#b42318" }} onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          ))}
        {save.data?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{save.data.error}</span>}
        {save.state === "idle" && save.data?.ok && !dirty && <span style={{ color: "#1a5e20", fontSize: "13px" }}>Saved</span>}
        {act.data?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{act.data.error}</span>}
        {act.data?.intent === "refreshPrinters" && act.data.ok && <span style={small}>Asked the Mac for its printers…</span>}
        <PrintNote note={test.note} />
      </div>
      {st.installPending && (fresh ?? install) && <InstallSteps install={fresh ?? install} name={st.name} />}
    </div>
  );
}

// Test pages go to a specific computer (not necessarily this one)
function useAgentTest(st) {
  const f = useFetcher();
  const poll = useFetcher();
  const [job, setJob] = useState(null);
  const [note, setNote] = useState(null);
  const seen = useRef(null);
  const run = (role) => {
    seen.current = null;
    setJob(null);
    setNote({ busy: true, text: "Sending…" });
    f.submit({ intent: "testPrint", id: String(st.id), role }, { method: "post" });
  };
  useEffect(() => {
    if (f.state !== "idle" || !f.data || seen.current === f.data) return;
    seen.current = f.data;
    if (f.data.job) setJob(f.data.job);
    else setNote({ error: true, text: f.data.text ?? f.data.error ?? "Couldn't send the test." });
  }, [f.state, f.data]);
  const submit = useRef(poll.submit);
  submit.current = poll.submit;
  useEffect(() => {
    if (!job || job.done) return undefined;
    let n = 0;
    const t = setInterval(() => {
      if (++n > 60) return clearInterval(t);
      submit.current({ intent: "printJobs", ids: JSON.stringify([job.id]) }, { method: "post" });
    }, 1000);
    return () => clearInterval(t);
  }, [job?.id, job?.done]);
  useEffect(() => {
    const j = poll.data?.jobs?.find((x) => x.id === job?.id);
    if (j && j.status !== job.status) setJob(j);
  }, [poll.data]);
  useEffect(() => {
    if (job) setNote(STATUS[job.status]?.(job) ?? null);
  }, [job]);
  return { run, note };
}

const JOB_STATUS = { queued: "Waiting", printing: "Printing", printed: "Printed", waiting: "Stuck on the Mac", failed: "Failed", expired: "Dropped" };

function JobHistory({ jobs, canRetry }) {
  const retry = useFetcher();
  if (!jobs?.length) return <div style={small}>Nothing printed yet.</div>;
  return (
    <div style={{ ...box, maxHeight: "320px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr>
            <th style={head}>When</th>
            <th style={head}>What</th>
            <th style={head}>Computer · printer</th>
            <th style={head}>By</th>
            <th style={head}>Result</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td style={{ ...cell, whiteSpace: "nowrap" }}>{fmtDate(j.createdAt, true)}</td>
              <td style={cell}>
                {j.title}
                {j.format === "ZPL" ? " (ZPL)" : ""}
              </td>
              <td style={cell}>
                {j.station} · {j.printer}
              </td>
              <td style={cell}>{j.by ?? ""}</td>
              <td style={{ ...cell, color: ["failed", "expired"].includes(j.status) ? "#b42318" : j.status === "waiting" ? "#8a6100" : undefined }}>
                {JOB_STATUS[j.status] ?? j.status}
                {j.message && j.status !== "printed" ? <div style={small}>{j.message}</div> : null}
                {canRetry && ["failed", "expired"].includes(j.status) && (
                  <button type="button" style={{ ...btn, marginTop: "4px", padding: "2px 8px", fontSize: "12px" }} onClick={() => retry.submit({ intent: "retryPrint", id: String(j.id) }, { method: "post" })}>
                    Print again
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {retry.data?.error && <div style={{ color: "#b42318", fontSize: "13px", padding: "6px" }}>{retry.data.error}</div>}
      {retry.data?.fallback && <div style={{ color: "#b42318", fontSize: "13px", padding: "6px" }}>{retry.data.text}</div>}
    </div>
  );
}

export function PackingComputers({ printing, canSettings, canPrint }) {
  const add = useFetcher();
  const refresh = useFetcher();
  const { stationId } = usePrinting();
  const [name, setName] = useState("");
  const [stations, setStations] = useState(printing?.stations ?? []);
  const [jobs, setJobs] = useState(printing?.jobs ?? []);
  useEffect(() => setStations(printing?.stations ?? []), [printing?.stations]);
  useEffect(() => setJobs(printing?.jobs ?? []), [printing?.jobs]);
  // Live status while this page is open (faster while a Mac is being installed)
  const installing = stations.some((s) => !s.paired && s.installPending) || add.data?.station;
  const submit = useRef(refresh.submit);
  submit.current = refresh.submit;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") submit.current({ intent: "printStations", jobs: "1" }, { method: "post" });
    }, installing ? 3000 : 10000);
    return () => clearInterval(t);
  }, [installing]);
  useEffect(() => {
    if (refresh.data?.stations) setStations(refresh.data.stations);
    if (refresh.data?.jobs) setJobs(refresh.data.jobs);
  }, [refresh.data]);
  useEffect(() => {
    if (add.data?.ok) setName("");
  }, [add.data]);
  const newInstall = add.data?.ok ? add.data : null;

  return (
    <s-section heading="Packing computers (direct printing)">
      <s-paragraph>
        <span style={muted}>
          Labels and packing slips print straight to the right printer, with no print dialog, from any browser. Each packing Mac runs MonkeyBean Print, a small
          background app that starts at login. Without it, printing uses the browser's print dialog as before.
        </span>
      </s-paragraph>

      {stations.length > 0 && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", margin: "10px 0", padding: "8px 10px", background: "#f7f7f7", borderRadius: "8px" }}>
          <strong style={{ fontSize: "13px" }}>This computer:</strong>
          <ThisComputer compact />
          <span style={small}>Remembered in this browser. Set it once on each packing computer.</span>
        </div>
      )}

      <div style={{ display: "grid", gap: "10px", marginTop: "10px" }}>
        {stations.map((st) => (
          <StationCard
            key={st.id}
            st={st}
            isThis={st.id === stationId}
            install={newInstall?.station?.id === st.id ? newInstall : null}
            canSettings={canSettings}
            canTest={canSettings || canPrint}
          />
        ))}
      </div>

      {canSettings && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.submit({ intent: "addStation", name }, { method: "post" });
          }}
          style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "12px" }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. Packing ${stations.length + 1}`} aria-label="Computer name" style={{ ...input, width: "200px" }} />
          <s-button onClick={() => add.submit({ intent: "addStation", name }, { method: "post" })} {...(add.state !== "idle" ? { loading: true } : {})} {...(!name.trim() ? { disabled: true } : {})}>
            Add a packing computer
          </s-button>
          {add.data?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{add.data.error}</span>}
        </form>
      )}

      <details style={{ marginTop: "14px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "13px" }}>Recent print jobs</summary>
        <div style={{ marginTop: "8px" }}>
          <JobHistory jobs={jobs} canRetry={canPrint || canSettings} />
        </div>
      </details>

      <details style={{ marginTop: "8px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "13px" }}>Help</summary>
        <ul style={{ fontSize: "13px", lineHeight: 1.7, paddingLeft: "20px", margin: "6px 0 0" }}>
          <li>Add the printers on the Mac first (System Settings → Printers & Scanners). For a 4 × 6 label printer, set its default paper to 4 × 6 there.</li>
          <li>
            Jobs wait up to 10 minutes for the Mac. After that they're dropped (so a Mac that was asleep never prints a pile of old labels) and show in Recent print
            jobs with Print again.
          </li>
          <li>“Stuck on the Mac” means macOS took the job but the printer hasn't printed it: it's usually off, out of labels, unplugged, or paused.</li>
          <li>The Mac's log: ~/Library/Logs/MonkeyBean Print.log (open it with Console).</li>
          <li>
            To remove it from a Mac, run this in Terminal there:
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginTop: "4px" }}>
              <code style={{ padding: "4px 8px", background: "#f7f7f7", borderRadius: "6px", fontSize: "12px" }}>{printing?.uninstall}</code>
              <Copy text={printing?.uninstall ?? ""} />
            </div>
          </li>
        </ul>
      </details>
    </s-section>
  );
}

// Packing slips: straight to this computer's slip printer, or the slips page (browser print)
export function SlipPrintButton({ batchId, ids = null, children, variant, onBrowser }) {
  const target = usePrinterFor("slip");
  const whyBrowser = useWhyBrowser("slip");
  const agent = useAgentPrint();
  const [fallback, setFallback] = useState(null);
  const click = () => {
    setFallback(null);
    if (!target) return onBrowser();
    agent.print({ what: "slips", id: String(batchId), ...(ids?.length ? { ids: ids.join(",") } : {}) }, { onFallback: (text) => setFallback(text) });
  };
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
      <s-button {...(variant ? { variant } : {})} onClick={click} {...(agent.busy ? { loading: true } : {})} title={target ? `Print on ${target.printer} (${target.station.name})` : whyBrowser ?? "Opens the slips to print"}>
        {children}
      </s-button>
      {fallback ? (
        <span style={{ fontSize: "12px", color: "#8a6100" }}>
          {fallback}.{" "}
          <button type="button" onClick={onBrowser} style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer", textDecoration: "underline" }}>
            Print from the browser
          </button>
        </span>
      ) : (
        <PrintNote note={agent.note} />
      )}
    </span>
  );
}
