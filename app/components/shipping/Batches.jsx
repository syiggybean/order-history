import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { PINK, box, cell, fmtDate, head, input, muted, pill, small, useParamSetter } from "./ui";

export const MAX_BATCH = 250;

const STATUS = {
  open: ["Open", "#eef3ff", "#1c4a9c"],
  picking: ["Picking", "#fff4d6", "#7a4f01"],
  picked: ["Picked", "#e3f1df", "#1a5e20"],
  packing: ["Packing", "#fff4d6", "#7a4f01"],
  packed: ["Packed", "#e3f1df", "#1a5e20"],
  shipping: ["Shipping", "#fff4d6", "#7a4f01"],
  done: ["Shipped", "#f1f1f1", "#4a4a4a"],
  cancelled: ["Cancelled", "#f1f1f1", "#6b6b6b"],
};
export const StatusPill = ({ status }) => {
  const [label, bg, fg] = STATUS[status] ?? [status, "#f1f1f1", "#4a4a4a"];
  return <span style={pill(bg, fg)}>{label}</span>;
};

export const batchTitle = (b) => (b.name ? `${b.tag} · ${b.name}` : b.tag);

// How full a batch is, out of 250
function Fill({ n }) {
  const pct = Math.min(100, Math.round((n / MAX_BATCH) * 100));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: "140px" }}>
      <div style={{ flex: 1, height: "6px", borderRadius: "3px", background: "#efefef", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: n >= MAX_BATCH ? "#9a9a9a" : PINK }} />
      </div>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>
        {n}
        <span style={muted}>/{MAX_BATCH}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ready tab: selection bar and "Add to batch"
// ---------------------------------------------------------------------------

// "Select the first [N] of M matching": how many to take from the top of the list
function FirstN({ total, sort, onSelect }) {
  const [n, setN] = useState("");
  const num = Math.floor(Number(n));
  const valid = Number.isFinite(num) && num >= 1;
  const go = (e) => {
    e?.preventDefault?.();
    if (valid) onSelect(Math.min(num, total));
  };
  return (
    <form onSubmit={go} style={{ display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
      <span>Select the first</span>
      <input
        type="number"
        min="1"
        max={total}
        value={n}
        onChange={(e) => setN(e.target.value)}
        placeholder={String(Math.min(total, MAX_BATCH))}
        aria-label="How many shipments"
        style={{ ...input, width: "80px" }}
      />
      <span>
        of {total.toLocaleString()} matching ({sort === "newest" ? "newest" : "oldest"} orders first)
      </span>
      <s-button variant="secondary" onClick={go} {...(!valid ? { disabled: true } : {})}>
        Select
      </s-button>
    </form>
  );
}

export function SelectionBar({ count, total, allMatching, limit, sort, onSelectAll, onSelectFirst, onClear, openBatches, filter, ids, onDone }) {
  const fetcher = useFetcher();
  const go = useParamSetter();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("new");
  const [name, setName] = useState("");
  const busy = fetcher.state !== "idle";
  const result = fetcher.data?.intent === "addToBatch" ? fetcher.data : null;

  useEffect(() => {
    if (result?.ok) {
      setOpen(false);
      setName("");
      setTarget("new");
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const chosen = openBatches.find((b) => String(b.id) === target);
  const tooMany = chosen && count > chosen.room;
  const parts = target === "new" ? Math.ceil(count / MAX_BATCH) : 1;

  const submit = () =>
    fetcher.submit(
      {
        intent: "addToBatch",
        target,
        name,
        ...(allMatching ? { filter: JSON.stringify(filter), ...(limit ? { limit: String(limit) } : {}) } : { ids: JSON.stringify(ids) }),
      },
      { method: "post" },
    );

  return (
    <>
      {result?.ok && (
        <div className="sh-rise" style={{ marginBottom: "10px" }}>
          <s-banner tone="success" heading={`Added ${result.added.toLocaleString()} shipment${result.added === 1 ? "" : "s"}`}>
            <s-paragraph>
              {result.batches.map((b, i) => (
                <span key={b.id}>
                  {i > 0 && ", "}
                  <button type="button" onClick={() => go({ tab: "batches", batch: b.id, view: null }, { replace: false })} style={linkBtn}>
                    {batchTitle(b)}
                  </button>{" "}
                  ({b.added})
                </span>
              ))}
              {result.skipped ? ` · ${result.skipped} skipped (no longer ready, or batched by someone else)` : ""}
            </s-paragraph>
          </s-banner>
        </div>
      )}
      {count === 0 && total > 0 && (
        <div style={{ ...small, display: "flex", alignItems: "center", marginBottom: "10px", color: "#303030" }}>
          <FirstN total={total} sort={sort} onSelect={onSelectFirst} />
        </div>
      )}
      {count > 0 && (
        <div
          className="sh-rise"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 3,
            display: "flex",
            flexWrap: "wrap",
            gap: "10px",
            alignItems: "center",
            padding: "10px 12px",
            marginBottom: "10px",
            borderRadius: "10px",
            background: "#fff5f7",
            border: `1px solid ${PINK}`,
          }}
        >
          <strong>{count.toLocaleString()} selected</strong>
          {allMatching && limit ? (
            <span style={small}>
              the first {limit.toLocaleString()} of {total.toLocaleString()} matching, {sort === "newest" ? "newest" : "oldest"} orders first
            </span>
          ) : null}
          {(!allMatching || limit) && total > count && (
            <button type="button" style={linkBtn} onClick={onSelectAll}>
              Select all {total.toLocaleString()} matching
            </button>
          )}
          <button type="button" style={{ ...linkBtn, color: "#616161" }} onClick={onClear}>
            Clear
          </button>
          <span style={{ flex: 1 }} />
          {!open && (
            <s-button variant="primary" onClick={() => setOpen(true)}>
              Add to batch
            </s-button>
          )}
        </div>
      )}
      {count > 0 && open && (
        <div className="sh-rise" style={{ ...box, padding: "14px", marginBottom: "12px", overflow: "visible" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <label style={radioRow}>
              <input type="radio" name="target" checked={target === "new"} onChange={() => setTarget("new")} />
              <span>
                <strong>New batch</strong>
                <span style={{ ...small, display: "block" }}>
                  {parts > 1 ? `${count} shipments make ${parts} batches (up to ${MAX_BATCH} each), oldest orders first.` : "Up to 250 shipments."}
                </span>
              </span>
            </label>
            {target === "new" && (
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (optional), e.g. Lore Vol. 1 release"
                aria-label="Batch name"
                style={{ ...input, maxWidth: "360px", marginLeft: "26px" }}
              />
            )}
            <label style={{ ...radioRow, opacity: openBatches.length ? 1 : 0.5 }}>
              <input
                type="radio"
                name="target"
                disabled={!openBatches.length}
                checked={target !== "new"}
                onChange={() => setTarget(String(openBatches[0]?.id ?? "new"))}
              />
              <span>
                <strong>Add to an open batch</strong>
                <span style={{ ...small, display: "block" }}>{openBatches.length ? "Batches that haven't finished picking." : "No open batches with room."}</span>
              </span>
            </label>
            {target !== "new" && (
              <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ ...input, maxWidth: "420px", marginLeft: "26px" }} aria-label="Batch">
                {openBatches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {batchTitle(b)} ({b.shipments}/{MAX_BATCH}, room for {b.room})
                  </option>
                ))}
              </select>
            )}
            {tooMany && (
              <div style={{ ...small, color: "#b42318", marginLeft: "26px" }}>
                {chosen.tag} only has room for {chosen.room}. Pick fewer shipments or make a new batch.
              </div>
            )}
            {result?.error && <div style={{ color: "#b42318" }}>{result.error}</div>}
            <div style={{ display: "flex", gap: "8px" }}>
              <s-button variant="primary" onClick={submit} {...(busy ? { loading: true } : {})} {...(tooMany ? { disabled: true } : {})}>
                Add {count.toLocaleString()} to {target === "new" ? (parts > 1 ? `${parts} new batches` : "a new batch") : chosen?.tag}
              </s-button>
              <s-button variant="tertiary" onClick={() => setOpen(false)}>
                Cancel
              </s-button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const linkBtn = { appearance: "none", border: 0, background: "none", padding: 0, font: "inherit", color: "#005bd3", fontWeight: 600, cursor: "pointer" };
const radioRow = { display: "flex", gap: "10px", alignItems: "flex-start", cursor: "pointer" };

// ---------------------------------------------------------------------------
// Batches tab: the list
// ---------------------------------------------------------------------------

const names = (list) => (list?.length ? list.map((a) => a.name).join(", ") : null);

// Who's working a batch; people with "Create and edit batches" can change it
export function AssignControl({ batch, staff, canAssign, me }) {
  const fetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(() => new Set((batch.assignees ?? []).map((a) => a.id)));
  useEffect(() => setPicked(new Set((batch.assignees ?? []).map((a) => a.id))), [batch.assignees]);
  useEffect(() => {
    if (fetcher.data?.intent === "assignBatch" && fetcher.data.ok) setOpen(false);
  }, [fetcher.data]);
  const current = fetcher.data?.intent === "assignBatch" && fetcher.data.ok ? fetcher.data.assignees : batch.assignees ?? [];
  const toggle = (id) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <div style={{ marginTop: "8px", fontSize: "13px" }}>
      <span style={{ fontWeight: 600 }}>Assigned to: </span>
      {current.length ? (
        current.map((a, i) => (
          <span key={a.id}>
            {i > 0 && ", "}
            <span style={a.id === me ? { fontWeight: 700 } : undefined}>{a.name}{a.id === me ? " (you)" : ""}</span>
          </span>
        ))
      ) : (
        <span style={muted}>nobody yet</span>
      )}
      {canAssign && !open && (
        <button type="button" onClick={() => setOpen(true)} style={{ ...linkBtn, fontWeight: 500, fontSize: "12px", marginLeft: "8px" }}>
          {current.length ? "Change" : "Assign"}
        </button>
      )}
      {open && (
        <div className="sh-rise" style={{ ...box, padding: "10px 12px", marginTop: "8px", overflow: "visible", maxWidth: "420px" }}>
          {!staff.length ? (
            <div style={muted}>Nobody has the Pick or Pack switch yet. Turn it on for your pickers and packers on the Permissions page.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {staff.map((m) => (
                <label key={m.id} style={{ display: "flex", gap: "8px", alignItems: "center", cursor: "pointer" }}>
                  <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
                  <span>{m.name}</span>
                  <span style={small}>{[m.pick && "picks", m.pack && "packs"].filter(Boolean).join(" · ")}</span>
                </label>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
            <s-button
              variant="primary"
              onClick={() => fetcher.submit({ intent: "assignBatch", id: String(batch.id), staff: JSON.stringify([...picked]) }, { method: "post" })}
              {...(fetcher.state !== "idle" ? { loading: true } : {})}
            >
              Save
            </s-button>
            <s-button variant="tertiary" onClick={() => setOpen(false)}>
              Cancel
            </s-button>
          </div>
          {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "6px" }}>{fetcher.data.error}</div>}
        </div>
      )}
    </div>
  );
}

export function BatchList({ batches, show, canBatches, autoBatch, restricted = false, mine = false }) {
  const go = useParamSetter();
  const auto = useFetcher();
  const ran = auto.data?.intent === "autoBatch" ? auto.data : null;
  return (
    <s-section heading="Batches">
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", alignItems: "center", marginBottom: "12px" }}>
        <div role="tablist" style={{ display: "inline-flex", border: "1px solid #d5d5d5", borderRadius: "8px", overflow: "hidden" }}>
          {[
            ["live", "To ship"],
            ["done", "Shipped"],
            ["cancelled", "Cancelled"],
          ].map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={show === v}
              onClick={() => go({ show: v === "live" ? null : v })}
              style={{ appearance: "none", border: 0, padding: "6px 12px", font: "inherit", cursor: "pointer", background: show === v ? "#1a1a1a" : "#fff", color: show === v ? "#fff" : "#303030" }}
            >
              {label}
            </button>
          ))}
        </div>
        {restricted ? (
          <span style={{ ...small, fontWeight: 600 }}>Showing the batches assigned to you</span>
        ) : (
          <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
            <input type="checkbox" checked={mine} onChange={(e) => go({ mine: e.target.checked ? "1" : null })} />
            Only mine
          </label>
        )}
        <span style={{ flex: 1 }} />
        {canBatches && (
          <>
            <span style={small}>
              {autoBatch.enabled ? `Auto-batching runs daily at ${autoBatch.time}` : "Daily auto-batching is off"}
              {autoBatch.singles ? ` · single items when more than ${autoBatch.min} are ready` : ""}
            </span>
            <s-button onClick={() => auto.submit({ intent: "autoBatch" }, { method: "post" })} {...(auto.state !== "idle" ? { loading: true } : {})}>
              Run auto-batching now
            </s-button>
          </>
        )}
      </div>
      {ran && (
        <div className="sh-rise" style={{ marginBottom: "12px" }}>
          {ran.error ? (
            <s-banner tone="critical">
              <s-paragraph>{ran.error}</s-paragraph>
            </s-banner>
          ) : ran.batches?.length ? (
            <s-banner tone="success" heading={`Auto-batching added ${ran.added} shipment${ran.added === 1 ? "" : "s"}`}>
              <s-paragraph>{ran.batches.map((b) => `${b.tag} "${b.name}" (${b.topUp ? "+" : ""}${b.added})`).join(", ")}</s-paragraph>
            </s-banner>
          ) : (
            <s-banner tone="info">
              <s-paragraph>Nothing to auto-batch: no item has more than {autoBatch.min} single-item shipments ready.</s-paragraph>
            </s-banner>
          )}
        </div>
      )}
      {!batches.length ? (
        <s-paragraph>
          {restricted
            ? "No batches are assigned to you right now."
            : mine
              ? "No batches are assigned to you."
              : show === "live"
                ? "No batches yet. On the Ready to ship tab, tick shipments and choose Add to batch."
                : "Nothing here."}
        </s-paragraph>
      ) : (
        <div style={{ ...box, maxHeight: "680px" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
            <thead>
              <tr>
                {["Batch", "Status", "Assigned", "Shipments", "Units", "Oldest order", "Created", ""].map((h, i) => (
                  <th key={i} style={head}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batches.map((b, i) => (
                <tr
                  key={b.id}
                  className="sh-rise"
                  style={{ animationDelay: `${(i % 12) * 25}ms`, cursor: "pointer" }}
                  onClick={() => go({ batch: b.id, view: null }, { replace: false })}
                >
                  <td style={cell}>
                    <span style={{ color: "#005bd3", fontWeight: 700 }}>{b.tag}</span>
                    {b.name && <div style={{ fontWeight: 500 }}>{b.name}</div>}
                    {b.source !== "manual" && <div style={small}>Auto-batched</div>}
                  </td>
                  <td style={cell}>
                    <StatusPill status={b.status} />
                  </td>
                  <td style={cell}>{names(b.assignees) ?? <span style={muted}>—</span>}</td>
                  <td style={cell}>
                    <Fill n={b.shipments} />
                  </td>
                  <td style={{ ...cell, fontVariantNumeric: "tabular-nums" }}>{b.units.toLocaleString()}</td>
                  <td style={cell}>{b.oldestOrderAt ? fmtDate(b.oldestOrderAt) : "—"}</td>
                  <td style={cell}>
                    {fmtDate(b.createdAt, true)}
                    <div style={small}>{b.createdBy ?? (b.source === "manual" ? "" : "Auto-batching")}</div>
                  </td>
                  <td style={cell}>{b.flagged > 0 && <span style={pill("#fde7e9", "#8e1f0b")}>{b.flagged} flagged</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </s-section>
  );
}

// ---------------------------------------------------------------------------
// One batch
// ---------------------------------------------------------------------------

export function BatchHeader({ batch, canBatches, canPick, staff = [], me = null }) {
  const go = useParamSetter();
  const fetcher = useFetcher();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(batch.name ?? "");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.ok && fetcher.data.intent === "renameBatch") setRenaming(false);
  }, [fetcher.data]);

  return (
    <div style={{ marginBottom: "14px" }}>
      <button type="button" style={{ ...linkBtn, fontWeight: 500, marginBottom: "8px" }} onClick={() => go({ batch: null, view: null, box: null, slips: null }, { replace: false })}>
        ← All batches
      </button>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
        <h2 style={{ margin: 0, fontSize: "20px" }}>{batch.tag}</h2>
        {!renaming ? (
          <>
            {batch.name && <span style={{ fontSize: "16px", fontWeight: 600 }}>{batch.name}</span>}
            {canBatches && batch.status !== "cancelled" && (
              <button type="button" style={{ ...linkBtn, fontWeight: 500, fontSize: "12px" }} onClick={() => setRenaming(true)}>
                {batch.name ? "Rename" : "Add a name"}
              </button>
            )}
          </>
        ) : (
          <span style={{ display: "inline-flex", gap: "6px" }}>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={input} aria-label="Batch name" autoFocus />
            <s-button onClick={() => fetcher.submit({ intent: "renameBatch", id: String(batch.id), name }, { method: "post" })} {...(busy ? { loading: true } : {})}>
              Save
            </s-button>
            <s-button variant="tertiary" onClick={() => setRenaming(false)}>
              Cancel
            </s-button>
          </span>
        )}
        <StatusPill status={batch.status} />
      </div>
      <div style={{ ...small, marginTop: "6px" }}>
        {batch.shipments} shipment{batch.shipments === 1 ? "" : "s"} · {batch.units} unit{batch.units === 1 ? "" : "s"} · created {fmtDate(batch.createdAt, true)}
        {batch.createdBy ? ` by ${batch.createdBy}` : batch.source !== "manual" ? " by auto-batching" : ""}
        {batch.pickedAt ? ` · picked ${fmtDate(batch.pickedAt, true)}${batch.pickedBy ? ` by ${batch.pickedBy}` : ""}` : ""}
      </div>
      {batch.status !== "cancelled" && <AssignControl batch={batch} staff={staff} canAssign={canBatches} me={me} />}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "12px" }}>
        {batch.status !== "cancelled" && (
          <s-button
            variant={["picked", "packing"].includes(batch.status) ? "primary" : "secondary"}
            onClick={() => go({ view: "pack" }, { replace: false })}
          >
            {batch.status === "packed" ? "Packing (all done)" : `Pack this batch${batch.packed ? ` · ${batch.packed}/${batch.shipments} packed` : ""}`}
          </s-button>
        )}
        {batch.status !== "cancelled" && (
          <s-button variant={["open", "picking"].includes(batch.status) ? "primary" : "secondary"} onClick={() => go({ view: "pick" }, { replace: false })}>
            {canPick && ["open", "picking"].includes(batch.status) ? "Pick this batch" : "Pick list"}
          </s-button>
        )}
        {batch.status !== "cancelled" && (
          <s-button variant="secondary" onClick={() => go({ view: "slips" }, { replace: false })}>
            Packing slips
          </s-button>
        )}
        <s-button href={`shopify:admin/orders?query=${encodeURIComponent(`tag:${batch.tag}`)}`} target="_top" variant="secondary">
          Orders in Shopify
        </s-button>
        {canBatches && batch.editable && !confirmCancel && (
          <s-button variant="tertiary" tone="critical" onClick={() => setConfirmCancel(true)}>
            Cancel batch
          </s-button>
        )}
        {confirmCancel && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "4px 10px", borderRadius: "8px", background: "#fde7e9" }}>
            <span>All {batch.shipments} shipments go back to Ready and the {batch.tag} tag comes off their orders.</span>
            <s-button tone="critical" onClick={() => fetcher.submit({ intent: "cancelBatch", id: String(batch.id) }, { method: "post" })} {...(busy ? { loading: true } : {})}>
              Cancel batch
            </s-button>
            <s-button variant="tertiary" onClick={() => setConfirmCancel(false)}>
              Keep it
            </s-button>
          </span>
        )}
      </div>
      {fetcher.data?.error && <div style={{ color: "#b42318", marginTop: "8px" }}>{fetcher.data.error}</div>}
      {batch.untagged > 0 && batch.status !== "cancelled" && (
        <div style={{ ...small, marginTop: "10px" }}>
          <span className="sh-spin" style={{ display: "inline-block", width: "10px", height: "10px", verticalAlign: "-1px", marginRight: "6px" }} />
          Adding the {batch.tag} tag to {batch.untagged} order{batch.untagged === 1 ? "" : "s"} in Shopify…
        </div>
      )}
      {batch.tagIssues > 0 && (
        <div style={{ ...small, color: "#b42318", marginTop: "6px" }}>
          {batch.tagIssues} order{batch.tagIssues === 1 ? "" : "s"} couldn't be tagged; the app keeps retrying. See the rows below.
        </div>
      )}
      {batch.flagged > 0 && (
        <div style={{ marginTop: "12px" }}>
          <s-banner tone="warning" heading={`${batch.flagged} shipment${batch.flagged === 1 ? " needs" : "s need"} a decision`}>
            <s-paragraph>
              Stock or release dates changed after these were batched. They're marked below; take them out of the batch, or leave them in if the stock is
              on the way.
            </s-paragraph>
          </s-banner>
        </div>
      )}
    </div>
  );
}

// Removing ticked shipments from a batch
export function RemoveBar({ batch, ids, onDone }) {
  const fetcher = useFetcher();
  useEffect(() => {
    if (fetcher.data?.intent === "removeFromBatch" && fetcher.data.ok) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);
  if (!ids.length) return null;
  return (
    <div
      className="sh-rise"
      style={{ position: "sticky", top: 0, zIndex: 3, display: "flex", gap: "10px", alignItems: "center", padding: "10px 12px", marginBottom: "10px", borderRadius: "10px", background: "#fff5f7", border: `1px solid ${PINK}` }}
    >
      <strong>{ids.length} selected</strong>
      <span style={{ flex: 1 }} />
      <s-button
        onClick={() => fetcher.submit({ intent: "removeFromBatch", id: String(batch.id), ids: JSON.stringify(ids) }, { method: "post" })}
        {...(fetcher.state !== "idle" ? { loading: true } : {})}
      >
        Take out of {batch.tag}
      </s-button>
      {fetcher.data?.error && <span style={{ color: "#b42318" }}>{fetcher.data.error}</span>}
    </div>
  );
}
