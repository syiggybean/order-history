import { useContext, useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { GreenButton, input, muted, small } from "./ui";
import { ShopAdminContext } from "./Notice";
import { downloadFile, openViewer, quickPrint, showInViewer } from "./labelPrint";
import { DEFAULT_METHOD_RULES, METHOD_KINDS } from "./methods";
import { PrintNote, useAgentPrint, usePrinterFor, useWhyBrowser } from "./Printing";

// ---------------------------------------------------------------------------
// Labels bought in the app: print, view, download; buy a whole batch at once;
// the settings behind them.
// ---------------------------------------------------------------------------

const btn = (primary) => ({
  appearance: "none",
  border: `1px solid ${primary ? "#1a1a1a" : "#c9c9c9"}`,
  background: primary ? "#1a1a1a" : "#fff",
  color: primary ? "#fff" : "#1a1a1a",
  borderRadius: "8px",
  padding: "6px 12px",
  font: "inherit",
  fontSize: "13px",
  fontWeight: 600,
  cursor: "pointer",
});

// Quick print / View / Download for one box's label, or a whole batch (batch=true).
// Quick print goes to this packing computer's label printer when it has one (no dialog),
// otherwise through the browser.
export function LabelActions({ batchId, shipmentId = null, batch = false, autoPrintKey = null, compact = false }) {
  const f = useFetcher();
  const agent = useAgentPrint();
  const target = usePrinterFor("label");
  const whyBrowser = useWhyBrowser("label");
  const viewer = useRef(null);
  const [note, setNote] = useState(null);
  const done = useRef(null);
  const why = useRef(null);
  const ask = (purpose, { browser = false, why: reason = null } = {}) => {
    setNote(null);
    why.current = reason;
    if (purpose === "print" && target && !browser) {
      agent.print(
        { what: batch ? "labels" : "label", id: String(batchId), ...(shipmentId ? { shipmentId: String(shipmentId) } : {}) },
        { onFallback: (text) => ask("print", { browser: true, why: text }) },
      );
      return;
    }
    if (purpose === "view") viewer.current = openViewer();
    done.current = purpose;
    f.submit({ intent: batch ? "batchLabelFile" : "labelFile", id: String(batchId), ...(shipmentId ? { shipmentId: String(shipmentId) } : {}), purpose }, { method: "post" });
  };
  // Print straight away once (e.g. right after buying)
  const printedFor = useRef(null);
  useEffect(() => {
    if (autoPrintKey && printedFor.current !== autoPrintKey) {
      printedFor.current = autoPrintKey;
      ask("print");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrintKey]);
  useEffect(() => {
    if (f.state !== "idle" || !f.data) return;
    if (f.data.error) {
      setNote({ error: true, text: f.data.error });
      done.current = null;
      if (viewer.current && !viewer.current.closed) viewer.current.close();
      return;
    }
    const file = f.data.file;
    if (!file || !done.current) return;
    if (done.current === "download") downloadFile(file);
    else if (done.current === "view") showInViewer(viewer.current, file);
    else {
      const how = quickPrint(file);
      const prefix = why.current ? `${why.current}, so the browser printed it. ` : whyBrowser ? `${whyBrowser} ` : "";
      setNote({
        text:
          prefix +
          (how === "downloaded"
            ? "ZPL labels can't print from the browser, so it downloaded. Set up this packing computer (Settings → Packing computers) to print ZPL directly."
            : batch
              ? `Sent ${file.count} label${file.count === 1 ? "" : "s"} to the print dialog.`
              : "Sent to the print dialog."),
      });
      why.current = null;
    }
    done.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.state, f.data, batch]);
  const busy = f.state !== "idle" || agent.busy;
  const shown = note ?? agent.note;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
      <button
        type="button"
        style={btn(true)}
        onClick={() => ask("print")}
        disabled={busy}
        title={target ? `Print on ${target.printer} (${target.station.name})` : whyBrowser ?? "Print with the browser's print dialog"}
      >
        {busy && (agent.busy || done.current === "print") ? "Printing…" : batch ? "🖨 Print all labels" : "🖨 Quick print"}
      </button>
      <button type="button" style={btn(false)} onClick={() => ask("view")} disabled={busy} title="Open the label, to check it or print with the print dialog">
        View
      </button>
      <button type="button" style={btn(false)} onClick={() => ask("download")} disabled={busy} title="Save a copy">
        Download
      </button>
      {shown && !compact && <PrintNote note={shown} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The whole batch at once (every box with the same items): before or after packing
// ---------------------------------------------------------------------------

export function BulkLabelsPanel({ batch, bulk, cfg, canShip, canPrint }) {
  const buy = useFetcher();
  const status = useFetcher();
  const revalidator = useRevalidator();
  const admin = useContext(ShopAdminContext);
  const today = new Date().toLocaleDateString("en-CA");
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const defaultBox = cfg.labelBoxId ?? cfg.boxes[0]?.id ?? "custom";
  const [f, setF] = useState({ boxId: defaultBox, l: "", w: "", h: "", weight: "", shipDate: today, notify: cfg.labelNotify !== false });
  const job = (status.data?.job ?? buy.data?.job) || null;
  const running = Boolean(job?.running) || buy.state !== "idle";

  // Follow a purchase in progress
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => status.submit({ intent: "bulkLabelStatus", id: String(batch.id) }, { method: "post" }), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, batch.id]);
  // Picks up a purchase started elsewhere (or before a reload)
  useEffect(() => {
    status.submit({ intent: "bulkLabelStatus", id: String(batch.id) }, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.id]);
  const finished = job && !job.running;
  const lastFinished = useRef(null);
  useEffect(() => {
    if (finished && lastFinished.current !== job.finishedAt) {
      lastFinished.current = job.finishedAt;
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, job?.finishedAt]);

  if (!bulk?.identical) return null;
  const n = bulk.unlabelled ?? 0;
  if (!n && !job && !bulk.labelled) return null;

  const submit = () => {
    setConfirm(false);
    const override =
      f.boxId === "custom" ? { l: f.l, w: f.w, h: f.h, weight: f.weight || null } : { boxId: f.boxId, weight: f.weight || null };
    buy.submit({ intent: "buyLabels", id: String(batch.id), override: JSON.stringify(override), notify: f.notify ? "1" : "0", shipDate: f.shipDate }, { method: "post" });
  };
  const box = cfg.boxes.find((b) => b.id === f.boxId);
  const ready = f.boxId === "custom" ? [f.l, f.w, f.h].every((v) => Number(v) > 0) : Boolean(box);

  return (
    <div style={{ padding: "12px", border: "1px solid #b7dfc2", background: "#f6fbf7", borderRadius: "10px", margin: "10px 0" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <strong>Every box in {batch.tag} has the same items</strong>
        <span style={small}>
          {n ? `${n} without a label` : "All labelled"}
          {bulk.labelled ? ` · ${bulk.labelled} bought in the app` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {canShip && n > 0 && !open && !running && <GreenButton onClick={() => setOpen(true)}>Buy all {n} labels</GreenButton>}
        {canPrint && bulk.labelled > 0 && !running && <LabelActions batchId={batch.id} batch />}
      </div>

      {open && canShip && n > 0 && !running && (
        <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center" }}>
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              Box for all
              <select value={f.boxId} onChange={(e) => setF({ ...f, boxId: e.target.value })} style={input}>
                {cfg.boxes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.l} × {b.w} × {b.h} {cfg.dimUnit})
                  </option>
                ))}
                <option value="custom">Other size…</option>
              </select>
            </label>
            {f.boxId === "custom" &&
              ["l", "w", "h"].map((k, i) => (
                <span key={k} style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
                  {i > 0 && "×"}
                  <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} inputMode="decimal" placeholder={k.toUpperCase()} aria-label={k} style={{ ...input, width: "56px" }} />
                </span>
              ))}
            {f.boxId === "custom" && <span style={small}>{cfg.dimUnit}</span>}
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              Weight for each
              <input value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} inputMode="decimal" placeholder="auto" aria-label="Weight" style={{ ...input, width: "72px" }} />
              {cfg.weightUnit}
            </label>
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              Ship date
              <input type="date" value={f.shipDate} min={today} onChange={(e) => setF({ ...f, shipDate: e.target.value })} style={input} />
            </label>
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} />
              Email customers
            </label>
          </div>
          <div style={small}>
            Applies to every box. Leave the weight blank to use Shopify's product weights plus the box's empty weight. Boxes that already have a weight from
            the pack bench still use the size chosen here.
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            {confirm ? (
              <>
                <span style={{ fontWeight: 600 }}>Buy {n} labels now? They're charged to your Shopify bill.</span>
                <GreenButton onClick={submit}>Yes, buy {n}</GreenButton>
                <s-button variant="tertiary" onClick={() => setConfirm(false)}>
                  Cancel
                </s-button>
              </>
            ) : (
              <>
                <GreenButton onClick={() => setConfirm(true)} disabled={!ready}>
                  Buy {n} labels
                </GreenButton>
                <s-button variant="tertiary" onClick={() => setOpen(false)}>
                  Cancel
                </s-button>
              </>
            )}
            {admin && bulk.tagging && bulk.ready > 0 && (
              <a href={`${admin}/orders?query=${encodeURIComponent(bulk.query)}`} target="_blank" rel="noreferrer" style={{ ...small, color: "#005bd3", marginLeft: "auto" }}>
                Or buy on Shopify's bulk page ↗
              </a>
            )}
          </div>
          {buy.data?.error && <div style={{ color: "#b42318", fontSize: "13px" }}>{buy.data.error}</div>}
        </div>
      )}

      {job && (
        <div style={{ marginTop: "10px", fontSize: "13px" }}>
          {job.running ? (
            <span>
              ⏳ Buying labels: {job.done} of {job.total}
              {job.failed ? ` (${job.failed} failed)` : ""}…
            </span>
          ) : (
            <span>
              {job.bought} label{job.bought === 1 ? "" : "s"} bought{job.failed ? `, ${job.failed} failed` : ""}
              {job.by ? ` by ${job.by}` : ""}.
            </span>
          )}
          <div style={{ height: "6px", background: "#e3efe6", borderRadius: "3px", marginTop: "6px", overflow: "hidden" }}>
            <div style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%`, height: "100%", background: "#29845a", transition: "width .3s" }} />
          </div>
          {job.stopped && <div style={{ color: "#b42318", marginTop: "6px" }}>Stopped: {job.stopped}</div>}
          {job.results.some((r) => !r.ok) && (
            <ul style={{ margin: "6px 0 0", paddingLeft: "18px", color: "#b42318" }}>
              {job.results
                .filter((r) => !r.ok)
                .slice(0, 20)
                .map((r) => (
                  <li key={r.id}>
                    {r.orderName}: {r.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings: shipping method badges, and label printing on this computer
// ---------------------------------------------------------------------------

export function MethodRulesSettings({ rules, methods = [], canSettings }) {
  const fetcher = useFetcher();
  const r = rules ?? DEFAULT_METHOD_RULES;
  const toText = (a) => (a ?? []).join(", ");
  const [f, setF] = useState({ fastest: toText(r.fastest), cheapest: toText(r.cheapest), buyer: toText(r.buyer), otherwise: r.otherwise ?? "buyer" });
  const [dirty, setDirty] = useState(false);
  const set = (patch) => {
    setF({ ...f, ...patch });
    setDirty(true);
  };
  const saved = fetcher.state === "idle" && fetcher.data?.intent === "methodRules";
  useEffect(() => {
    if (saved && fetcher.data.ok) setDirty(false);
  }, [saved, fetcher.data]);
  const words = (t) => t.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  const live = { fastest: words(f.fastest), cheapest: words(f.cheapest), buyer: words(f.buyer), otherwise: f.otherwise };
  const kindOf = (m) => {
    const x = String(m).toLowerCase();
    for (const k of ["buyer", "fastest", "cheapest"]) if (live[k].some((w) => x.includes(w))) return k;
    return f.otherwise === "none" ? null : f.otherwise;
  };
  const row = (kind, help) => (
    <label style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "8px", alignItems: "center" }}>
      <span style={{ display: "inline-block", padding: "1px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: METHOD_KINDS[kind].bg, color: METHOD_KINDS[kind].fg, border: `1px solid ${METHOD_KINDS[kind].border}`, justifySelf: "start" }}>
        {METHOD_KINDS[kind].label}
      </span>
      <span>
        <input value={f[kind]} disabled={!canSettings} onChange={(e) => set({ [kind]: e.target.value })} placeholder={help} aria-label={`${METHOD_KINDS[kind].label} words`} style={{ ...input, width: "100%" }} />
      </span>
    </label>
  );
  return (
    <s-section heading="Shipping method badges">
      <s-paragraph>
        <span style={muted}>
          Each shipment's checkout shipping option shows as a colored badge. A method gets the color of the first words it contains (separate words with
          commas; capitals don't matter).
        </span>
      </s-paragraph>
      <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
        {row("fastest", "e.g. express, priority, overnight")}
        {row("cheapest", "e.g. economy, ground advantage, media mail")}
        {row("buyer", "words for options the buyer picked specifically")}
        <label style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "8px", alignItems: "center" }}>
          <span style={small}>Anything else</span>
          <select value={f.otherwise} disabled={!canSettings} onChange={(e) => set({ otherwise: e.target.value })} style={{ ...input, justifySelf: "start" }}>
            <option value="buyer">Buyer-selected (pink)</option>
            <option value="cheapest">Cheapest (green)</option>
            <option value="fastest">Fastest (blue)</option>
            <option value="none">Plain grey</option>
          </select>
        </label>
      </div>
      {methods.length > 0 && (
        <div style={{ marginTop: "10px" }}>
          <div style={small}>Your current shipping methods:</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "4px" }}>
            {methods.slice(0, 30).map((m) => {
              const k = kindOf(m.method);
              const c = k ? METHOD_KINDS[k] : { bg: "#f1f1f1", fg: "#4a4a4a", border: "#dcdcdc" };
              return (
                <span key={m.method} style={{ display: "inline-block", padding: "1px 9px", borderRadius: "999px", fontSize: "12px", fontWeight: 600, background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>
                  {m.method} <span style={{ fontWeight: 400 }}>({m.count})</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
      {canSettings && (
        <div style={{ marginTop: "12px", display: "flex", gap: "8px", alignItems: "center" }}>
          <s-button variant="primary" onClick={() => fetcher.submit({ intent: "methodRules", rules: JSON.stringify(live) }, { method: "post" })} {...(fetcher.state !== "idle" ? { loading: true } : {})} {...(!dirty ? { disabled: true } : {})}>
            Save
          </s-button>
          {saved && fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
          {saved && fetcher.data?.ok && !dirty && <span style={{ color: "#1a5e20" }}>Saved</span>}
        </div>
      )}
    </s-section>
  );
}

export function LabelPrintingHelp() {
  return (
    <s-section heading="Printing without a packing computer">
      <s-paragraph>
        <span style={muted}>
          On a computer that isn't set up above, Quick print and packing slips use the browser's print dialog, with the last-used printer chosen, so Enter prints.
          Set the label printer's paper to 4 × 6 in and margins to None in the dialog once.
        </span>
      </s-paragraph>
      <div style={{ ...small, marginTop: "6px" }}>
        Labels come in the format set in Shopify (Settings → Shipping and delivery → Shipping labels). PDF works everywhere; ZPL only prints through a packing
        computer with a Zebra printer (from the browser it downloads instead).
      </div>
    </s-section>
  );
}
