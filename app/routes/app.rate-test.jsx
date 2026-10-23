import { Fragment, useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { getStaff, loadWithAccess, can, denied } from "../permissions.server";
import {
  CARRIERS,
  StampsError,
  disconnect,
  getRun,
  listRuns,
  rateTestJob,
  redirectUri,
  saveFrom,
  stampsStatus,
  startConnect,
  startRateTest,
  testShipments,
} from "../stamps.server";

// Label rate test (Debug permission): times Stamps.com rate requests for past
// shipments. Only asks for rates; nothing is bought.

export const loader = async ({ request }) => {
  const { session, admin, noAccess } = await loadWithAccess(request, "debug", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const [status, shipments, runs] = await Promise.all([stampsStatus(shop, admin), testShipments(shop), listRuns(shop)]);
  return { status, shipments, runs, job: rateTestJob(shop), carriers: CARRIERS, redirect: redirectUri(request) };
};

export const action = async ({ request }) => {
  const { session, admin, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!can(user, "debug", "view")) return { intent, ...denied("debug", "view") };
  const shop = session.shop;
  try {
    if (intent === "connect") return { intent, ...(await startConnect(shop, user, request)) };
    if (intent === "disconnect") return (await disconnect(shop), { intent, ok: true });
    if (intent === "status") return { intent, status: await stampsStatus(shop) };
    if (intent === "saveFrom") {
      await saveFrom(shop, Object.fromEntries(["name", "line1", "city", "state", "zip", "country"].map((k) => [k, form.get(k)])));
      return { intent, ok: true };
    }
    if (intent === "shipments") return { intent, shipments: await testShipments(shop, form.get("q")) };
    if (intent === "run") {
      const job = await startRateTest(
        shop,
        admin,
        {
          ids: JSON.parse(String(form.get("ids") ?? "[]")),
          carriers: JSON.parse(String(form.get("carriers") ?? "[]")),
          weight: form.get("weight"),
          weightUnit: form.get("weightUnit"),
          l: form.get("l"),
          w: form.get("w"),
          h: form.get("h"),
          dimUnit: form.get("dimUnit"),
          useBench: form.get("useBench") === "1",
          concurrency: form.get("concurrency"),
        },
        user,
      );
      return { intent, job: { ...job } };
    }
    if (intent === "job") return { intent, job: rateTestJob(shop) };
    if (intent === "runDetail") return { intent, run: await getRun(shop, form.get("id")) };
  } catch (e) {
    if (!(e instanceof StampsError)) console.error(`[stamps] ${intent}:`, e);
    return { intent, error: e?.message ?? String(e) };
  }
  return { intent, error: "Unknown action" };
};

export const shouldRevalidate = ({ formData, defaultShouldRevalidate }) =>
  ["status", "shipments", "job", "runDetail", "run"].includes(formData?.get("intent")) ? false : defaultShouldRevalidate;

// ---------------------------------------------------------------------------

const cell = { padding: "7px 9px", borderBottom: "1px solid #ebebeb", textAlign: "left", verticalAlign: "top", fontSize: "13px" };
const head = { ...cell, fontWeight: 600, background: "#f7f7f7", position: "sticky", top: 0, whiteSpace: "nowrap" };
const input = { padding: "5px 8px", border: "1px solid #c9c9c9", borderRadius: "6px", font: "inherit", fontSize: "13px", background: "#fff" };
const muted = { color: "#616161", fontSize: "12px" };
const money = (n, cur = "USD") => (n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: cur || "USD" }));
const ms = (n) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`);
const when = (s) => new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" });
const service = (s) => String(s ?? "").replace(/^(usps|ups|fedex|dhl_express|globalpost)_/, "").replace(/_/g, " ");
const speedColor = (n) => (n == null ? "#616161" : n < 1000 ? "#1a5e20" : n < 3000 ? "#8a6100" : "#b42318");

export default function RateTest() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Debug" />;
  return <Page />;
}

function Page() {
  const d = useLoaderData();
  return (
    <s-page heading="Label rate test (Stamps.com)">
      <s-banner tone="info" heading="Rates only">
        <s-paragraph>
          This asks Stamps.com for rates on past shipments and times every request. Nothing is bought and nothing changes in Shopify. {d.status.envLabel}.
        </s-paragraph>
      </s-banner>
      <Connection status={d.status} redirect={d.redirect} />
      {d.status.connected && <TestForm shipments={d.shipments} carriers={d.carriers} job={d.job} from={d.status.from} />}
      <History runs={d.runs} carriers={d.carriers} />
    </s-page>
  );
}

function Connection({ status, redirect }) {
  const f = useFetcher();
  const poll = useFetcher();
  const revalidator = useRevalidator();
  const win = useRef(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (f.state !== "idle" || f.data?.intent !== "connect") return;
    if (f.data.url) {
      if (win.current && !win.current.closed) win.current.location.href = f.data.url;
      else window.open(f.data.url, "_blank");
      setWaiting(true);
    } else if (win.current && !win.current.closed) win.current.close();
  }, [f.state, f.data]);
  // Watch for the sign-in finishing in the other tab
  const submitPoll = useRef(poll.submit);
  submitPoll.current = poll.submit;
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(() => submitPoll.current({ intent: "status" }, { method: "post" }), 3000);
    const stop = setTimeout(() => setWaiting(false), 15 * 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [waiting]);
  useEffect(() => {
    if (waiting && poll.data?.status?.connected) {
      setWaiting(false);
      revalidator.revalidate();
    }
  }, [poll.data]);

  return (
    <s-section heading="Stamps.com account">
      {!status.configured ? (
        <div style={{ fontSize: "13px", lineHeight: 1.6 }}>
          <div>Not set up yet. To connect:</div>
          <ol style={{ margin: "4px 0 0", paddingLeft: "20px" }}>
            <li>In the Stamps.com developer portal, create an app and add this redirect address: <code>{redirect}</code></li>
            <li>
              In Railway, add <code>STAMPS_CLIENT_ID</code> and <code>STAMPS_CLIENT_SECRET</code>. It uses Stamps.com's test (staging) system unless{" "}
              <code>STAMPS_ENV</code> is <code>production</code>.
            </li>
            <li>Come back here and choose Connect.</li>
          </ol>
        </div>
      ) : status.connected ? (
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", fontSize: "13px" }}>
          <span>
            ✓ Connected{status.connectedBy ? ` by ${status.connectedBy}` : ""}
            {status.connectedAt ? ` · ${when(status.connectedAt)}` : ""}
          </span>
          <s-button variant="tertiary" onClick={() => f.submit({ intent: "disconnect" }, { method: "post" })}>
            Disconnect
          </s-button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", fontSize: "13px" }}>
          {status.otherEnv && <span style={{ color: "#8a6100" }}>The saved account was for the other Stamps.com system; connect again.</span>}
          <s-button
            variant="primary"
            onClick={() => {
              win.current = window.open("", "_blank");
              f.submit({ intent: "connect" }, { method: "post" });
            }}
          >
            Connect Stamps.com
          </s-button>
          {waiting && <span style={muted}>Finish signing in to Stamps.com in the new tab. This updates by itself.</span>}
        </div>
      )}
      {f.data?.error && <div style={{ color: "#b42318", fontSize: "13px", marginTop: "6px" }}>{f.data.error}</div>}
    </s-section>
  );
}

function TestForm({ shipments: initial, carriers, job: initialJob, from }) {
  const search = useFetcher();
  const run = useFetcher();
  const poll = useFetcher();
  const saveF = useFetcher();
  const revalidator = useRevalidator();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState([]);
  const [f, setF] = useState({ carriers: ["usps", "ups"], weight: "1", weightUnit: "lb", l: "", w: "", h: "", dimUnit: "in", useBench: true, concurrency: "1" });
  const [fromF, setFromF] = useState(from);
  const [job, setJob] = useState(initialJob);
  const [result, setResult] = useState(null);
  const detail = useFetcher();
  const shipments = search.data?.shipments ?? initial;
  const timer = useRef(null);

  useEffect(() => {
    if (run.state === "idle" && run.data?.job) setJob(run.data.job);
  }, [run.state, run.data]);
  const submitPoll = useRef(poll.submit);
  submitPoll.current = poll.submit;
  useEffect(() => {
    if (!job?.running) return undefined;
    const t = setInterval(() => submitPoll.current({ intent: "job" }, { method: "post" }), 1000);
    return () => clearInterval(t);
  }, [job?.running]);
  useEffect(() => {
    if (poll.data?.job) setJob(poll.data.job);
  }, [poll.data]);
  const shownRun = useRef(null);
  useEffect(() => {
    if (job && !job.running && job.runId && shownRun.current !== job.runId) {
      shownRun.current = job.runId;
      detail.submit({ intent: "runDetail", id: String(job.runId) }, { method: "post" });
      revalidator.revalidate();
    }
  }, [job?.running, job?.runId]);
  useEffect(() => {
    if (detail.data?.run) setResult(detail.data.run);
  }, [detail.data]);

  const toggle = (id) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 25 ? s : [...s, id]));
  const go = () =>
    run.submit(
      { intent: "run", ids: JSON.stringify(sel), carriers: JSON.stringify(f.carriers), weight: f.weight, weightUnit: f.weightUnit, l: f.l, w: f.w, h: f.h, dimUnit: f.dimUnit, useBench: f.useBench ? "1" : "", concurrency: f.concurrency },
      { method: "post" },
    );
  const running = Boolean(job?.running) || run.state !== "idle";

  return (
    <>
      <s-section heading="Ship from">
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}>
          {[
            ["name", "Name", 160],
            ["line1", "Street", 200],
            ["city", "City", 130],
            ["state", "State", 60],
            ["zip", "ZIP", 80],
            ["country", "Country", 60],
          ].map(([k, label, w]) => (
            <input key={k} value={fromF[k] ?? ""} onChange={(e) => setFromF({ ...fromF, [k]: e.target.value })} placeholder={label} aria-label={`Ship from ${label}`} style={{ ...input, width: `${w}px` }} />
          ))}
          <s-button variant="tertiary" onClick={() => saveF.submit({ intent: "saveFrom", ...fromF }, { method: "post" })}>
            Save
          </s-button>
          {saveF.data?.error && <span style={{ color: "#b42318", fontSize: "13px" }}>{saveF.data.error}</span>}
          {saveF.state === "idle" && saveF.data?.ok && <span style={{ color: "#1a5e20", fontSize: "13px" }}>Saved</span>}
        </div>
      </s-section>

      <s-section heading="Test">
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "8px", flexWrap: "wrap" }}>
          <input
            type="search"
            value={q}
            placeholder="Find an order or customer"
            aria-label="Find shipments"
            onChange={(e) => {
              setQ(e.target.value);
              clearTimeout(timer.current);
              const v = e.target.value;
              timer.current = setTimeout(() => search.submit({ intent: "shipments", q: v }, { method: "post" }), 300);
            }}
            style={{ ...input, width: "260px" }}
          />
          <span style={muted}>
            {sel.length} chosen (up to 25){sel.length > 0 && " · "}
          </span>
          {sel.length > 0 && (
            <button type="button" onClick={() => setSel([])} style={{ ...input, border: 0, color: "#005bd3", cursor: "pointer", padding: 0 }}>
              Clear
            </button>
          )}
        </div>
        <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", maxHeight: "300px", overflow: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...head, width: "28px" }} />
                <th style={head}>Order</th>
                <th style={head}>Placed</th>
                <th style={head}>Status</th>
                <th style={head}>To</th>
                <th style={head}>Items</th>
                <th style={head}>Pack bench package</th>
              </tr>
            </thead>
            <tbody>
              {shipments.map((s) => (
                <tr key={s.id} onClick={() => toggle(s.id)} style={{ cursor: "pointer", background: sel.includes(s.id) ? "#f4f8ff" : undefined }}>
                  <td style={cell}>
                    <input type="checkbox" checked={sel.includes(s.id)} onChange={() => toggle(s.id)} onClick={(e) => e.stopPropagation()} aria-label={`Choose ${s.orderName}`} />
                  </td>
                  <td style={cell}>
                    {s.orderName}
                    {s.part ? <span style={muted}> · part {s.part}</span> : null}
                  </td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>{when(s.placedAt)}</td>
                  <td style={cell}>{s.state}</td>
                  <td style={cell}>{s.where || "—"}</td>
                  <td style={cell}>{s.units}</td>
                  <td style={cell}>
                    {s.pkg ? `${s.pkg.weight != null ? `${s.pkg.weight} ${s.pkg.weightUnit}` : ""}${s.pkg.l != null ? ` · ${s.pkg.l}×${s.pkg.w}×${s.pkg.h} ${s.pkg.dimUnit}` : ""}` : <span style={muted}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: "grid", gap: "10px", marginTop: "12px", fontSize: "13px" }}>
          <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
            <strong>Carriers</strong>
            {Object.entries(carriers).map(([k, label]) => (
              <label key={k} style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={f.carriers.includes(k)}
                  onChange={(e) => setF({ ...f, carriers: e.target.checked ? [...f.carriers, k] : f.carriers.filter((c) => c !== k) })}
                />
                {label}
              </label>
            ))}
            <span style={muted}>One request per carrier per shipment.</span>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <strong>Package</strong>
            <input value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} inputMode="decimal" aria-label="Weight" style={{ ...input, width: "60px" }} />
            <select value={f.weightUnit} onChange={(e) => setF({ ...f, weightUnit: e.target.value })} style={input} aria-label="Weight unit">
              {["lb", "oz", "kg", "g"].map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
            {["l", "w", "h"].map((k, i) => (
              <Fragment key={k}>
                {i ? "×" : <span style={{ marginLeft: "6px" }} />}
                <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} inputMode="decimal" placeholder={k.toUpperCase()} aria-label={k} style={{ ...input, width: "50px" }} />
              </Fragment>
            ))}
            <select value={f.dimUnit} onChange={(e) => setF({ ...f, dimUnit: e.target.value })} style={input} aria-label="Size unit">
              <option>in</option>
              <option>cm</option>
            </select>
            <label style={{ display: "inline-flex", gap: "4px", alignItems: "center", marginLeft: "6px" }}>
              <input type="checkbox" checked={f.useBench} onChange={(e) => setF({ ...f, useBench: e.target.checked })} />
              Use the pack bench box and weight when there is one
            </label>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <strong>Requests</strong>
            <select value={f.concurrency} onChange={(e) => setF({ ...f, concurrency: e.target.value })} style={input} aria-label="Requests at once">
              <option value="1">One at a time (cleanest timings)</option>
              <option value="4">4 at once (like buying in bulk)</option>
            </select>
            <span style={{ flex: 1 }} />
            <s-button variant="primary" onClick={go} {...(running ? { loading: true } : {})} {...(!sel.length || !f.carriers.length ? { disabled: true } : {})}>
              Get rates for {sel.length || ""} shipment{sel.length === 1 ? "" : "s"}
            </s-button>
          </div>
          {run.data?.error && <div style={{ color: "#b42318" }}>{run.data.error}</div>}
          {job?.running && (
            <div>
              Asking Stamps.com… {job.done} of {job.total}
              <div style={{ height: "6px", background: "#eef1f5", borderRadius: "3px", marginTop: "4px", overflow: "hidden" }}>
                <div style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%`, height: "100%", background: "#2c6ecb", transition: "width .3s" }} />
              </div>
            </div>
          )}
          {job && !job.running && job.error && <div style={{ color: "#b42318" }}>{job.error}</div>}
        </div>
      </s-section>

      {result && <Results run={result} carriers={carriers} />}
    </>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ padding: "8px 12px", border: "1px solid #e3e3e3", borderRadius: "10px", minWidth: "96px" }}>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: "18px", fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function Results({ run, carriers }) {
  const s = run.summary;
  const [open, setOpen] = useState(null);
  const used = run.settings.carriers;
  return (
    <s-section heading={`Results · ${when(run.at)}${run.by ? ` · ${run.by}` : ""}`}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <Stat label="Requests" value={`${s.ok} ok${s.failed ? ` · ${s.failed} failed` : ""}`} color={s.failed ? "#b42318" : undefined} />
        <Stat label="Median" value={ms(s.time?.median)} color={speedColor(s.time?.median)} />
        <Stat label="Average" value={ms(s.time?.avg)} />
        <Stat label="95th percentile" value={ms(s.time?.p95)} color={speedColor(s.time?.p95)} />
        <Stat label="Slowest" value={ms(s.time?.max)} color={speedColor(s.time?.max)} />
        <Stat label="Whole test" value={ms(s.totalMs)} />
        <Stat label="Sign-in refresh" value={s.tokenMs ? ms(s.tokenMs) : "not needed"} />
      </div>
      <div style={{ ...muted, marginTop: "6px" }}>
        {s.shipments} shipment{s.shipments === 1 ? "" : "s"}
        {s.skipped ? ` (${s.skipped} skipped: no address)` : ""} · {s.rates} rates returned · {s.concurrency === 1 ? "one request at a time" : `${s.concurrency} requests at once`} ·{" "}
        {run.env === "production" ? "production" : "staging (practice rates)"}
      </div>

      <table style={{ borderCollapse: "collapse", marginTop: "10px", fontSize: "13px" }}>
        <thead>
          <tr>
            <th style={head}>Carrier</th>
            <th style={head}>OK</th>
            <th style={head}>Rates</th>
            <th style={head}>Median</th>
            <th style={head}>95th %</th>
            <th style={head}>Slowest</th>
          </tr>
        </thead>
        <tbody>
          {used.map((k) => {
            const c = s.perCarrier[k];
            return (
              <tr key={k}>
                <td style={cell}>{carriers[k] ?? k}</td>
                <td style={cell}>
                  {c.ok} / {c.requests}
                </td>
                <td style={cell}>{c.rates}</td>
                <td style={{ ...cell, color: speedColor(c.time?.median) }}>{ms(c.time?.median)}</td>
                <td style={{ ...cell, color: speedColor(c.time?.p95) }}>{ms(c.time?.p95)}</td>
                <td style={{ ...cell, color: speedColor(c.time?.max) }}>{ms(c.time?.max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ border: "1px solid #e3e3e3", borderRadius: "8px", overflow: "auto", marginTop: "12px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={head}>Shipment</th>
              <th style={head}>Package</th>
              {used.map((k) => (
                <th key={k} style={head}>
                  {carriers[k] ?? k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.results.map((r) => (
              <Fragment key={r.id}>
                <tr onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: "pointer", background: open === r.id ? "#f4f8ff" : undefined }}>
                  <td style={cell}>
                    {open === r.id ? "▾" : "▸"} {r.orderName}
                    <div style={muted}>{r.to ?? ""}</div>
                  </td>
                  <td style={cell}>
                    {r.package.weight} {r.package.weight_unit}
                    {r.package.length ? ` · ${r.package.length}×${r.package.width}×${r.package.height} ${r.package.dimension_unit}` : ""}
                    <div style={muted}>{r.package.source}</div>
                  </td>
                  {r.error ? (
                    <td colSpan={used.length} style={{ ...cell, color: "#b42318" }}>
                      {r.error}
                    </td>
                  ) : (
                    used.map((k) => {
                      const x = r.carriers[k];
                      if (!x) return <td key={k} style={cell} />;
                      return (
                        <td key={k} style={cell}>
                          <span style={{ fontWeight: 700, color: speedColor(x.ms) }}>{ms(x.ms)}</span>
                          {x.ok ? (
                            <div style={muted}>
                              {x.rates.length ? `${x.rates.length} rate${x.rates.length === 1 ? "" : "s"} · from ${money(x.rates[0].total, x.rates[0].currency)}` : "no rates"}
                            </div>
                          ) : (
                            <div style={{ fontSize: "12px", color: "#b42318" }}>
                              {x.status ? `${x.status}: ` : ""}
                              {x.error}
                            </div>
                          )}
                        </td>
                      );
                    })
                  )}
                </tr>
                {open === r.id && !r.error && (
                  <tr>
                    <td colSpan={2 + used.length} style={{ ...cell, background: "#fafafa" }}>
                      <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
                        {used.map((k) =>
                          r.carriers[k]?.ok ? (
                            <div key={k}>
                              <strong>{carriers[k] ?? k}</strong>
                              {r.carriers[k].rates.length === 0 && <div style={muted}>No rates</div>}
                              {r.carriers[k].rates.map((x, i) => (
                                <div key={i} style={{ display: "flex", gap: "10px", fontSize: "12px" }}>
                                  <span style={{ minWidth: "190px", textTransform: "capitalize" }}>
                                    {service(x.service)}
                                    {x.packaging && x.packaging !== "package" ? ` (${x.packaging.replace(/_/g, " ")})` : ""}
                                  </span>
                                  <strong>{money(x.total, x.currency)}</strong>
                                  <span style={muted}>{x.days ? `${x.days} day${x.days === "1" ? "" : "s"}` : ""}</span>
                                </div>
                              ))}
                            </div>
                          ) : null,
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </s-section>
  );
}

function History({ runs, carriers }) {
  const detail = useFetcher();
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (detail.data?.run) setShown(detail.data.run);
  }, [detail.data]);
  if (!runs.length) return null;
  return (
    <>
      <s-section heading="Earlier tests">
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={head}>When</th>
              <th style={head}>By</th>
              <th style={head}>System</th>
              <th style={head}>Shipments</th>
              <th style={head}>Carriers</th>
              <th style={head}>Requests</th>
              <th style={head}>Median</th>
              <th style={head}>95th %</th>
              <th style={head} />
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>{when(r.at)}</td>
                <td style={cell}>{r.by ?? ""}</td>
                <td style={cell}>{r.env}</td>
                <td style={cell}>{r.summary.shipments}</td>
                <td style={cell}>{r.settings.carriers.join(", ")}</td>
                <td style={cell}>
                  {r.summary.ok}/{r.summary.requests}
                  {r.summary.concurrency > 1 ? ` (${r.summary.concurrency} at once)` : ""}
                </td>
                <td style={{ ...cell, color: speedColor(r.summary.time?.median) }}>{ms(r.summary.time?.median)}</td>
                <td style={{ ...cell, color: speedColor(r.summary.time?.p95) }}>{ms(r.summary.time?.p95)}</td>
                <td style={cell}>
                  <button type="button" onClick={() => detail.submit({ intent: "runDetail", id: String(r.id) }, { method: "post" })} style={{ ...input, border: 0, color: "#005bd3", cursor: "pointer", padding: 0 }}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>
      {shown && <Results run={shown} carriers={carriers} />}
    </>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
