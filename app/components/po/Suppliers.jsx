import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { Err, box, cell, head, input, muted, pill } from "./ui";

const EMPTY = { name: "", emails: "", contact: "", phone: "", address: "", taxRate: "", notes: "", archived: false };

// Saved suppliers: who POs go to, their emails and default tax rate
export function Suppliers() {
  const { suppliers } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [editing, setEditing] = useState(null); // supplier form state, or null
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setEditing(null);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const save = (s) => fetcher.submit({ intent: "supplier", supplier: JSON.stringify(s) }, { method: "post" });
  const list = suppliers.filter((s) => showArchived || !s.archived);
  const archivedCount = suppliers.filter((s) => s.archived).length;

  return (
    <>
      <s-section heading="Suppliers">
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "10px", flexWrap: "wrap" }}>
          <s-button variant="primary" onClick={() => setEditing({ ...EMPTY })}>
            Add supplier
          </s-button>
          {archivedCount > 0 && (
            <label style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived ({archivedCount})
            </label>
          )}
        </div>
        {list.length === 0 ? (
          <span style={muted}>No suppliers yet. Add one to start making purchase orders.</span>
        ) : (
          <div style={box}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "13px" }}>
              <thead>
                <tr>
                  <th style={head}>Name</th>
                  <th style={head}>Email</th>
                  <th style={head}>Contact</th>
                  <th style={{ ...head, textAlign: "right" }}>Tax rate</th>
                  <th style={head} />
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} style={{ opacity: s.archived ? 0.6 : 1 }}>
                    <td style={cell}>
                      <strong>{s.name}</strong> {s.archived && <span style={pill("#ececec", "#4a4a4a")}>Archived</span>}
                    </td>
                    <td style={cell}>{s.emails ?? <span style={muted}>—</span>}</td>
                    <td style={cell}>{[s.contact, s.phone].filter(Boolean).join(" · ") || <span style={muted}>—</span>}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{s.taxRate == null ? "—" : `${s.taxRate}%`}</td>
                    <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                      <s-button variant="tertiary" onClick={() => setEditing({ ...EMPTY, ...s, taxRate: s.taxRate == null ? "" : String(s.taxRate) })}>
                        Edit
                      </s-button>
                      <s-button variant="tertiary" onClick={() => save({ ...s, archived: !s.archived })}>
                        {s.archived ? "Restore" : "Archive"}
                      </s-button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!editing && <Err data={fetcher.data} />}
      </s-section>

      {editing && (
        <s-section heading={editing.id ? `Edit ${editing.name || "supplier"}` : "New supplier"}>
          <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <Field label="Name *" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
            <Field label="Email(s), separated by commas" value={editing.emails ?? ""} onChange={(v) => setEditing({ ...editing, emails: v })} placeholder="orders@supplier.com" />
            <Field label="Contact person" value={editing.contact ?? ""} onChange={(v) => setEditing({ ...editing, contact: v })} />
            <Field label="Phone" value={editing.phone ?? ""} onChange={(v) => setEditing({ ...editing, phone: v })} />
            <Field label="Default tax rate (%)" value={editing.taxRate ?? ""} onChange={(v) => setEditing({ ...editing, taxRate: v })} placeholder="e.g. 8.25" hint="Used for CSV rows with no tax rate." />
          </div>
          <label style={{ display: "block", marginTop: "12px" }}>
            <div style={muted}>Address (printed on the PO)</div>
            <textarea value={editing.address ?? ""} onChange={(e) => setEditing({ ...editing, address: e.target.value })} rows={3} style={{ ...input, width: "100%" }} />
          </label>
          <label style={{ display: "block", marginTop: "12px" }}>
            <div style={muted}>Internal notes (staff only)</div>
            <textarea value={editing.notes ?? ""} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} rows={2} style={{ ...input, width: "100%" }} />
          </label>
          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <s-button variant="primary" onClick={() => save(editing)} {...(fetcher.state !== "idle" ? { loading: true } : {})} {...(!editing.name.trim() ? { disabled: true } : {})}>
              Save supplier
            </s-button>
            <s-button variant="tertiary" onClick={() => setEditing(null)}>
              Cancel
            </s-button>
          </div>
          <Err data={fetcher.data} />
        </s-section>
      )}
    </>
  );
}

function Field({ label, value, onChange, placeholder, hint }) {
  return (
    <label>
      <div style={muted}>{label}</div>
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{ ...input, width: "100%" }} />
      {hint && <div style={muted}>{hint}</div>}
    </label>
  );
}
