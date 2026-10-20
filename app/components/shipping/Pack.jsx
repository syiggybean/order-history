import { useContext, useEffect, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { StatusPill, batchTitle } from "./Batches";
import { NOTICE_BG, NOTICE_EDGE, NoticeModal, NoticeTag, ShopAdminContext } from "./Notice";
import { BulkLabelsButton, PackageForShopify, PackagePanel } from "./Packages";
import { PINK, ProductName, box, cell, head, input, muted, pill, small, ProductThumb, useParamSetter } from "./ui";

// Short beeps so packers can scan without looking at the screen
let audio;
function beep(ok) {
  try {
    audio = audio ?? new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    o.type = ok ? "sine" : "square";
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.08 : 0.3));
  } catch {
    /* no sound */
  }
}
const label = (l) => `${l.title}${l.variantTitle ? ` – ${l.variantTitle}` : ""}`;

function Override({ boxId, batchId }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <s-button variant="tertiary" onClick={() => setOpen(true)}>
        Pack without a full scan…
      </s-button>
    );
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? e.g. barcode damaged, checked by eye"
        aria-label="Override reason"
        style={{ ...input, minWidth: "260px" }}
        autoFocus
      />
      <s-button
        tone="critical"
        onClick={() => fetcher.submit({ intent: "overridePack", id: String(batchId), shipmentId: String(boxId), reason }, { method: "post" })}
        {...(!reason.trim() ? { disabled: true } : {})}
        {...(fetcher.state !== "idle" ? { loading: true } : {})}
      >
        Mark packed
      </s-button>
      <s-button variant="tertiary" onClick={() => setOpen(false)}>
        Cancel
      </s-button>
      {fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
    </div>
  );
}

// Packing starts once the batch is picked; offer the way there
function NotPickedYet({ batch, canPick }) {
  const go = useParamSetter();
  const finish = useFetcher();
  const short = finish.data?.intent === "finishPicking" ? finish.data.short : null;
  return (
    <div style={{ marginTop: "12px" }}>
      <s-banner tone="warning" heading={`${batch.tag} hasn't been picked yet`}>
        <s-paragraph>
          Packing starts once everything in the batch is picked. Pick it with the pick list (scan or tick each item), then choose Finish picking. If
          it's already been picked by hand, finish it here.
        </s-paragraph>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "8px" }}>
          <s-button onClick={() => go({ view: "pick", box: null }, { replace: false })}>Open the pick list</s-button>
          {canPick && (
            <s-button
              variant="primary"
              onClick={() => finish.submit({ intent: "finishPicking", id: String(batch.id), force: short ? "1" : "" }, { method: "post" })}
              {...(finish.state !== "idle" ? { loading: true } : {})}
            >
              {short ? "Everything's picked: finish anyway" : "Finish picking now"}
            </s-button>
          )}
        </div>
        {short && (
          <div style={{ marginTop: "8px", fontSize: "13px" }}>
            The pick list hasn't recorded {short.reduce((n, s) => n + s.missing, 0)} unit(s): {short.map((s) => `${s.missing} × ${s.title}`).join(", ")}. If
            they're in the tote, finish anyway.
          </div>
        )}
        {finish.data?.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{finish.data.error}</div>}
      </s-banner>
    </div>
  );
}

// After a box is packed: buy and print its label on the order's Shopify page
function LabelPanel({ box: b, label, sandbox, onOpen, onCheck, checking, needsPackage }) {
  const shipped = b.state === "shipped" || label?.status === "done";
  const wrap = (bg, border, children) => (
    <div className="sh-rise" style={{ marginTop: "12px", padding: "12px", borderRadius: "10px", background: bg, border: `2px solid ${border}` }}>
      {children}
    </div>
  );
  if (shipped)
    return wrap(
      "#f0faf2",
      "#36a15a",
      <>
        <strong style={{ color: "#1a5e20" }}>✓ Label bought. {b.orderName} is shipped.</strong>
        {(label?.tracking ?? []).map((t, i) => (
          <div key={i} style={{ fontSize: "13px", marginTop: "4px" }}>
            {t.company ? `${t.company} ` : ""}
            {t.url ? (
              <a href={t.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
                {t.number}
              </a>
            ) : (
              t.number
            )}
          </div>
        ))}
        <div style={{ fontSize: "13px", marginTop: "4px", color: "#303030" }}>Scan the next packing slip.</div>
      </>,
    );
  if (sandbox)
    return wrap(
      "#fff7d6",
      "#e8c95a",
      <span style={{ fontSize: "13px" }}>
        <strong>Label step skipped in sandbox.</strong> For real orders, the order's Shopify page opens here so you can buy and print the label.
      </span>,
    );
  const st = label?.status;
  return wrap(
    "#eef3ff",
    "#7aa2e3",
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <strong>Label for {b.orderName}</strong>
        <span style={{ flex: 1 }} />
        {st === "open" ? (
          <>
            <span className="sh-spin" style={{ display: "inline-block", width: "12px", height: "12px" }} />
            <span style={{ fontSize: "13px" }}>In Shopify: Create shipping label → buy → print. Close that window when done.</span>
            <s-button variant="tertiary" onClick={onCheck}>
              I'm done
            </s-button>
          </>
        ) : (
          <>
            {needsPackage && <span style={{ fontSize: "13px", color: "#7a4f01" }}>Enter the weight first</span>}
            <s-button variant="primary" onClick={onOpen} {...(needsPackage ? { disabled: true } : {})}>
              {st === "none" ? "Open Shopify again ↗" : "Print label in Shopify ↗"}
            </s-button>
            {st && st !== "ready" && (
              <s-button variant="tertiary" onClick={onCheck} {...(checking ? { loading: true } : {})}>
                Check again
              </s-button>
            )}
          </>
        )}
      </div>
      <PackageForShopify pkg={b.pkg} />
      {st === "none" && <div style={{ fontSize: "13px", marginTop: "6px", color: "#7a4f01" }}>No label on this order yet. Open Shopify again, or carry on and label it later.</div>}
      {st === "blocked" && (
        <div style={{ fontSize: "13px", marginTop: "6px" }}>
          The browser blocked the pop-up.{" "}
          {label?.url && (
            <a href={label.url} target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>
              Open the order in a new tab
            </a>
          )}{" "}
          then choose Check again. (Allowing pop-ups for this site makes it automatic.)
        </div>
      )}
      {st === "checking" && <div style={{ fontSize: "13px", marginTop: "6px" }}>Checking Shopify for the label…</div>}
      {st === "error" && <div style={{ fontSize: "13px", marginTop: "6px", color: "#b42318" }}>{label.error}</div>}
    </>,
  );
}


export function PackStation({ data, boxData, can, sandbox = false }) {
  const go = useParamSetter();
  const revalidator = useRevalidator();
  const { batch, boxes, totals } = data;
  const pkgCfg = data.pkg ?? { step: "off", boxes: [], weightUnit: "lb", dimUnit: "in" };
  const [pkgFocus, setPkgFocus] = useState(false); // weight box takes the focus right after packing
  const [current, setCurrent] = useState(boxData);
  const [code, setCode] = useState("");
  const [last, setLast] = useState(null);
  const [askAck, setAskAck] = useState(false);
  const queue = useRef([]);
  const scanner = useFetcher();
  const admin = useContext(ShopAdminContext);
  const labelCheck = useFetcher();
  const [lab, setLabel] = useState(null); // { boxId, orderName, orderNumber, status, tracking }
  const labelWin = useRef(null);
  const [autoLabel, setAutoLabel] = useState(() => {
    try {
      return localStorage.getItem("sh-auto-label") !== "off";
    } catch {
      return true;
    }
  });
  const toggleAuto = (on) => {
    setAutoLabel(on);
    try {
      localStorage.setItem("sh-auto-label", on ? "on" : "off");
    } catch {
      /* not saved */
    }
  };
  // The order's Shopify page, where "Create shipping label" is
  const openLabel = (bx) => {
    if (sandbox) {
      setLabel({ boxId: bx.id, orderName: bx.orderName, orderNumber: bx.orderNumber, status: "sandbox" });
      return;
    }
    const url = admin ? `${admin}/orders/${bx.orderNumber}` : null;
    const w = url ? window.open(url, "shopify-label", "popup=yes,width=1200,height=900") : null;
    labelWin.current = w;
    setLabel({ boxId: bx.id, orderName: bx.orderName, orderNumber: bx.orderNumber, url, status: w ? "open" : "blocked" });
  };
  const checkLabel = (boxId) => {
    setLabel((l) => (l ? { ...l, status: "checking" } : l));
    labelCheck.submit({ intent: "labelCheck", id: String(batch.id), shipmentId: String(boxId) }, { method: "post" });
  };
  // When the Shopify window closes, see whether a label was bought
  useEffect(() => {
    if (lab?.status !== "open") return undefined;
    const t = setInterval(() => {
      if (!labelWin.current || labelWin.current.closed) {
        clearInterval(t);
        checkLabel(lab.boxId);
      }
    }, 700);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab?.status, lab?.boxId]);
  useEffect(() => {
    const r = labelCheck.data;
    if (r?.intent !== "labelCheck") return;
    if (r.error) {
      setLabel((l) => (l ? { ...l, status: "error", error: r.error } : l));
      return;
    }
    setLabel((l) => (l ? { ...l, status: r.shipped ? "done" : "none", tracking: r.tracking ?? [] } : l));
    if (r.shipped) {
      beep(true);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labelCheck.data]);
  const ackF = useFetcher();
  const unpackF = useFetcher();
  const inputRef = useRef(null);

  useEffect(() => {
    setCurrent(boxData);
  }, [boxData]);
  // A note or address warning pops up every time a box is opened for packing
  useEffect(() => {
    setAskAck(Boolean(boxData && boxData.state === "batched" && boxData.notice && can.pack));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxData?.id, can.pack]);
  useEffect(() => {
    if (!askAck && !pkgFocus) inputRef.current?.focus?.();
  }, [askAck, current?.id, pkgFocus]);
  // Packing done but the "Packed" tags are still going on in Shopify: check back
  const waitingForTags = Boolean(data.bulk?.complete && data.bulk.identical && data.bulk.pending > 0);
  useEffect(() => {
    if (!waitingForTags) return undefined;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForTags]);
  // Saved box and weight: on to the label
  const packageSaved = (pkg) => {
    setPkgFocus(false);
    const bx = current ? { ...current, pkg } : null;
    setCurrent(bx);
    revalidator.revalidate();
    if (bx && autoLabel && !sandbox && lab?.boxId === bx.id && lab.status === "ready") openLabel(bx);
    inputRef.current?.focus?.();
  };
  const scanFromPackage = (c) => {
    setPkgFocus(false);
    queue.current.push(c);
    pump();
  };

  const openBox = (id) => {
    setLast(null);
    setPkgFocus(false);
    go({ box: id }, { replace: false });
  };
  const nextBox = boxes.find((b) => b.state === "batched" && b.id !== current?.id);

  const pump = () => {
    if (scanner.state !== "idle" || !queue.current.length) return;
    const c = queue.current.shift();
    if (current && current.state === "batched") scanner.submit({ intent: "packScan", id: String(batch.id), shipmentId: String(current.id), code: c }, { method: "post" });
    else scanner.submit({ intent: "findBox", id: String(batch.id), code: c }, { method: "post" });
  };
  useEffect(pump, [scanner.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const r = scanner.data;
    if (!r) return;
    if (r.intent === "findBox") {
      if (r.ok) openBox(r.id);
      else {
        setLast({ ok: false, text: r.error });
        beep(false);
      }
    }
    if (r.intent === "packScan") {
      if (r.switchTo) {
        openBox(r.switchTo);
        return;
      }
      if (r.needsAck) {
        setAskAck(true);
        beep(false);
        return;
      }
      if (r.ok) {
        beep(true);
        setCurrent((b) => (b ? { ...b, lines: b.lines.map((l) => (l.key === r.key ? { ...l, scanned: r.scanned } : l)), scanned: b.scanned + 1, state: r.complete ? "packed" : b.state } : b));
        setLast({ ok: true, key: r.key, text: r.complete ? "Packed ✓ Every item scanned. Scan the next packing slip." : `${r.title}: ${r.scanned} of ${r.qty}` });
        if (r.complete) {
          revalidator.revalidate();
          if (pkgCfg.step !== "off" && current && !current.pkg) {
            // Box and weight first; the label opens when they're saved
            setPkgFocus(true);
            setLabel({ boxId: current.id, orderName: current.orderName, orderNumber: current.orderNumber, status: "ready" });
          } else if (autoLabel && current) openLabel(current);
          // Straight on to the label for this box
          else if (current) setLabel({ boxId: current.id, orderName: current.orderName, orderNumber: current.orderNumber, status: "ready" });
        }
      } else {
        beep(false);
        setLast({ ok: false, key: r.key, text: r.error });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanner.data]);
  useEffect(() => {
    if (ackF.data?.intent === "ackNotice" && ackF.data.ok) {
      setAskAck(false);
      setCurrent((b) => (b ? { ...b, packAcked: true } : b));
    }
  }, [ackF.data]);
  useEffect(() => {
    if (unpackF.data?.ok) setLast(null);
  }, [unpackF.data]);

  const onScan = (e) => {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setCode("");
    if (askAck) return;
    queue.current.push(c);
    pump();
  };

  const pct = totals.shipments ? Math.round((totals.packed / totals.shipments) * 100) : 0;
  const b = current;

  return (
    <s-section>
      <div style={{ marginBottom: "10px" }}>
        <button
          type="button"
          onClick={() => go({ view: null, box: null }, { replace: false })}
          style={{ appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", cursor: "pointer" }}
        >
          ← Back to {batch.tag}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
        <h2 style={{ margin: 0, fontSize: "20px" }}>Pack · {batchTitle(batch)}</h2>
        {batch.assignees?.length > 0 && <span style={small}>Assigned to {batch.assignees.map((a) => a.name).join(", ")}</span>}
        <StatusPill status={batch.status} />
        <span style={{ flex: 1 }} />
        {!sandbox && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }} title="Opens the order's Shopify page as soon as the last item is scanned">
            <input type="checkbox" checked={autoLabel} onChange={(e) => toggleAuto(e.target.checked)} />
            Open the label page after each box
          </label>
        )}
        <s-button onClick={() => go({ view: "slips", slips: null }, { replace: false })}>Print all packing slips</s-button>
      </div>

      {!data.canPack ? (
        <NotPickedYet batch={batch} canPick={can.pick} />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "12px 0" }}>
            <div style={{ flex: 1, height: "10px", borderRadius: "5px", background: "#efefef", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#36a15a" : PINK, transition: "width .25s" }} />
            </div>
            <strong style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
              {totals.packed} / {totals.shipments} packed
            </strong>
          </div>

          {can.pack && (
            <form onSubmit={onScan} style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "12px" }}>
              <input
                ref={inputRef}
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={b && b.state === "batched" ? `Scan items for ${b.orderName}` : "Scan a packing slip barcode"}
                aria-label="Scan"
                autoComplete="off"
                style={{ font: "inherit", fontSize: "16px", padding: "10px 12px", borderRadius: "10px", border: `2px solid ${PINK}`, flex: "1 1 280px", maxWidth: "420px" }}
              />
              <div
                role="status"
                style={{
                  flex: "2 1 260px",
                  padding: "8px 12px",
                  borderRadius: "10px",
                  background: !last ? "#f7f7f7" : last.ok ? "#e3f1df" : "#fde7e9",
                  color: !last ? "#616161" : last.ok ? "#1a5e20" : "#8e1f0b",
                  fontWeight: last ? 600 : 400,
                }}
              >
                {last ? last.text : b ? "Scan each item as it goes in the box." : "Scan a packing slip, or pick an order from the list."}
              </div>
            </form>
          )}

          <div style={{ display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* Queue */}
            <div style={{ ...box, flex: "1 1 260px", maxWidth: "360px", maxHeight: "70vh" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
                <thead>
                  <tr>
                    <th style={head}>Order</th>
                    <th style={head}>Units</th>
                    <th style={head} />
                  </tr>
                </thead>
                <tbody>
                  {boxes.map((x) => {
                    const sel = b?.id === x.id;
                    return (
                      <tr
                        key={x.id}
                        onClick={() => openBox(x.id)}
                        style={{ cursor: "pointer", background: sel ? "#fff5f7" : x.notice ? NOTICE_BG : undefined }}
                      >
                        <td style={{ ...cell, ...(x.notice ? { boxShadow: `inset 4px 0 0 ${NOTICE_EDGE}` } : {}), fontWeight: sel ? 700 : 500 }}>
                          {x.orderName}
                          {x.part ? <span style={small}> · {x.part}</span> : null}
                          {x.notice && <div style={{ ...small, color: "#7a3d00", fontWeight: 700 }}>! Read first</div>}
                          {x.flags.length > 0 && <div style={{ ...small, color: "#8e1f0b", fontWeight: 700 }}>⚑ {x.flags[0].reason}</div>}
                        </td>
                        <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{x.units}</td>
                        <td style={cell}>
                          {x.state !== "batched" ? (
                            x.state === "shipped" ? <span style={pill("#f1f1f1", "#1a5e20")}>Shipped ✓</span> : <span style={pill("#e3f1df", "#1a5e20")}>Packed</span>
                          ) : x.scanned ? (
                            <span style={small}>
                              {x.scanned}/{x.units}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {/* Every box packed, all with the same items: buy all the labels at once */}
              {!sandbox && data.bulk?.complete && data.bulk.identical && (
                <div style={{ padding: "12px", borderTop: "1px solid #e3e3e3", background: "#f6fbf7" }}>
                  <BulkLabelsButton bulk={data.bulk} />
                  <div style={{ ...small, marginTop: "6px" }}>Every box has the same items. In Shopify, select all, then Create shipping labels.</div>
                </div>
              )}
            </div>

            {/* The box */}
            <div style={{ flex: "3 1 420px", minWidth: 0 }}>
              {!b ? (
                <div style={{ ...box, padding: "24px", textAlign: "center", color: "#616161" }}>
                  {nextBox ? (
                    <>
                      <div style={{ marginBottom: "10px" }}>Scan a packing slip or choose an order.</div>
                      <s-button variant="primary" onClick={() => openBox(nextBox.id)}>
                        Start with the oldest: {nextBox.orderName}
                      </s-button>
                    </>
                  ) : (
                    <div style={{ fontWeight: 600, color: "#1a5e20" }}>Every shipment in {batch.tag} is packed. ✓</div>
                  )}
                </div>
              ) : (
                <div style={{ ...box, padding: "14px", overflow: "visible", ...(b.notice ? { borderColor: NOTICE_EDGE, borderWidth: "2px" } : {}) }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
                    <h3 style={{ margin: 0, fontSize: "20px" }}>
                      {b.orderName}
                      {b.part ? <span style={{ ...muted, fontSize: "14px" }}> · part {b.part}</span> : null}
                    </h3>
                    {b.state === "shipped" ? (
                      <span style={pill("#f1f1f1", "#1a5e20")}>Shipped ✓</span>
                    ) : b.state !== "batched" ? (
                      <span style={pill("#e3f1df", "#1a5e20")}>Packed</span>
                    ) : (
                      <span style={pill("#eef3ff", "#1c4a9c")}>To pack</span>
                    )}
                    <NoticeTag notice={b.notice} />
                    <span style={{ flex: 1 }} />
                    <s-button variant="tertiary" onClick={() => go({ view: "slips", slips: String(b.id) }, { replace: false })}>
                      Print slip
                    </s-button>
                  </div>
                  <div style={{ ...small, marginTop: "4px" }}>
                    {[b.customerName, b.shippingMethod, [b.province, b.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                  </div>

                  {b.notice && b.packAcked && (
                    <div style={{ marginTop: "10px", padding: "8px 10px", borderRadius: "8px", background: NOTICE_BG, borderLeft: `4px solid ${NOTICE_EDGE}`, fontSize: "13px" }}>
                      {b.notice.address && <div style={{ fontWeight: 700 }}>⚠ {b.notice.address.text}</div>}
                      {b.notice.note && (
                        <div style={{ whiteSpace: "pre-wrap", marginTop: b.notice.address ? "4px" : 0 }}>
                          <strong>Note:</strong> {b.notice.note}
                        </div>
                      )}
                    </div>
                  )}
                  {b.flags.length > 0 && (
                    <div style={{ marginTop: "10px" }}>
                      <s-banner tone="critical" heading={`Flagged for review: ${b.flags.map((f) => f.reason).join(", ")}`}>
                        <s-paragraph>
                          {b.flags.map((f) => f.note).filter(Boolean).join(" · ") || "Check with the team before sending this one."}
                        </s-paragraph>
                      </s-banner>
                    </div>
                  )}
                  {b.packOverride && <div style={{ ...small, marginTop: "8px", color: "#7a4f01" }}>Packed without a full scan by {b.packOverride}</div>}
                  {b.state !== "batched" && (
                    <PackagePanel
                      key={`pkg-${b.id}`}
                      box={b}
                      batchId={batch.id}
                      cfg={pkgCfg}
                      autoFocus={pkgFocus}
                      canPack={can.pack}
                      onSaved={packageSaved}
                      onScan={scanFromPackage}
                    />
                  )}
                  {b.state !== "batched" && (
                    <LabelPanel
                      needsPackage={pkgCfg.step === "required" && b.pkg?.weight == null && b.state !== "shipped"}
                      box={b}
                      label={lab?.boxId === b.id ? lab : null}
                      sandbox={sandbox}
                      onOpen={() => openLabel(b)}
                      onCheck={() => checkLabel(b.id)}
                      checking={labelCheck.state !== "idle"}
                    />
                  )}

                  <div style={{ marginTop: "12px" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "14px" }}>
                      <thead>
                        <tr>
                          {["Item", "Bin", "Qty", "Scanned"].map((h) => (
                            <th key={h} style={head}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {b.lines.map((l) => {
                          const done = l.scanned >= l.qty || b.state !== "batched";
                          return (
                            <tr key={l.key} className={last?.key === l.key ? "sh-rise" : undefined} style={{ background: done ? "#f3faf1" : undefined }}>
                              <td style={cell}>
                                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                                  <ProductThumb src={l.imageUrl} size={40} />
                                  <div>
                                    <div style={{ fontWeight: 600 }}>
                                      <ProductName id={l.productId}>{label(l)}</ProductName>
                                    </div>
                                    <div style={small}>{[l.sku && `SKU ${l.sku}`, l.barcode && l.barcode !== l.sku && l.barcode].filter(Boolean).join(" · ")}</div>
                                  </div>
                                </div>
                              </td>
                              <td style={{ ...cell, fontWeight: 700 }}>{l.bin ?? "—"}</td>
                              <td style={{ ...cell, fontWeight: 700, fontSize: "18px" }}>{l.qty}</td>
                              <td style={{ ...cell, fontWeight: 700, color: done ? "#1a7f37" : "#303030", fontVariantNumeric: "tabular-nums" }}>
                                {done ? "✓ " : ""}
                                {b.state !== "batched" ? l.qty : l.scanned}/{l.qty}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", marginTop: "12px" }}>
                    {b.state !== "batched" && nextBox && (
                      <s-button variant="primary" onClick={() => openBox(nextBox.id)}>
                        Next: {nextBox.orderName}
                      </s-button>
                    )}
                    {b.state === "batched" && b.notice && can.pack && (
                      <s-button variant={b.packAcked ? "tertiary" : "primary"} onClick={() => setAskAck(true)}>
                        {b.packAcked ? "Show the note / address again" : "Read the note / address first"}
                      </s-button>
                    )}
                    {b.state === "batched" && can.override && (!b.notice || b.packAcked) && <Override boxId={b.id} batchId={batch.id} />}
                    {b.state !== "batched" && can.pack && (
                      <s-button
                        variant="tertiary"
                        onClick={() => unpackF.submit({ intent: "unpack", id: String(batch.id), shipmentId: String(b.id) }, { method: "post" })}
                        {...(unpackF.state !== "idle" ? { loading: true } : {})}
                      >
                        Unpack (start this box again)
                      </s-button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {askAck && b?.notice && (
        <NoticeModal
          notice={b.notice}
          shipmentId={b.id}
          orderName={b.orderName}
          orderNumber={b.orderNumber}
          context="pack"
          busy={ackF.state !== "idle"}
          error={ackF.data?.error}
          onCancel={() => setAskAck(false)}
          onContinue={() => ackF.submit({ intent: "ackNotice", id: String(b.id), context: "pack" }, { method: "post" })}
          onNoticeChange={(n) => setCurrent((x) => (x ? { ...x, notice: n } : x))}
        />
      )}
    </s-section>
  );
}
