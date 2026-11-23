import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Internal notes card on product pages in Shopify admin (staff only, never shown
// to customers). Data comes from the app's /api/product-notes endpoint: any
// staff member can read; anyone with Stock access can write; authors and admins
// can edit or delete a note.

export default async () => {
  render(<Extension />, document.body);
};

const fmtTime = (iso) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

async function api(body) {
  const res = await fetch("/api/product-notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`The app returned ${res.status}`);
  if (data.error) throw new Error(data.error);
  return data;
}

function Extension() {
  const productId = shopify.data.selected?.[0]?.id;
  const [state, setState] = useState({ loading: true });
  const [notes, setNotes] = useState([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(null); // { id, body }
  const [deleting, setDeleting] = useState(null); // note id awaiting confirmation
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!productId) return setState({ error: "No product selected." });
    fetch(`/api/product-notes?${new URLSearchParams({ productId })}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.hidden) return setState({ hidden: true });
        if (d.error) return setState({ error: d.error });
        setNotes(d.notes);
        setState({ ready: true, canWrite: d.canWrite });
      })
      .catch((e) => setState({ error: e.message }));
  }, [productId]);

  const run = async (fn) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    }
    setWorking(false);
  };

  const add = () =>
    run(async () => {
      const { note } = await api({ intent: "add", productId, body: draft });
      setNotes([note, ...notes]);
      setDraft("");
    });
  const save = () =>
    run(async () => {
      const { note } = await api({ intent: "edit", id: editing.id, body: editing.body });
      setNotes(notes.map((n) => (n.id === note.id ? note : n)));
      setEditing(null);
    });
  const remove = (id) =>
    run(async () => {
      await api({ intent: "delete", id });
      setNotes(notes.filter((n) => n.id !== id));
      setDeleting(null);
    });

  if (state.hidden) return <s-admin-block heading="Internal notes" collapsedSummary="Not available">{null}</s-admin-block>;

  return (
    <s-admin-block heading="Internal notes" collapsedSummary={notes.length ? `${notes.length} note${notes.length === 1 ? "" : "s"}` : "No notes"}>
      <s-stack direction="block" gap="base">
        {state.loading && <s-spinner accessibilityLabel="Loading notes" />}
        {state.error && (
          <s-banner tone="critical">
            <s-text>Couldn't load notes: {state.error}</s-text>
          </s-banner>
        )}
        {error && (
          <s-banner tone="critical" dismissible onDismiss={() => setError(null)}>
            <s-text>{error}</s-text>
          </s-banner>
        )}

        {state.ready && state.canWrite && (
          <s-stack direction="block" gap="small">
            <s-text-area label="Add a note" labelAccessibilityVisibility="exclusive" placeholder="Something staff should know about this product…" value={draft} rows={2} maxLength={2000} onChange={(e) => setDraft(e.currentTarget.value ?? "")} />
            <s-stack direction="inline">
              <s-button variant="primary" disabled={!draft.trim() || undefined} loading={(working && !editing && !deleting) || undefined} onClick={add}>
                Add note
              </s-button>
            </s-stack>
          </s-stack>
        )}

        {state.ready && notes.length === 0 && <s-text color="subdued">No internal notes on this product yet.</s-text>}

        {notes.map((n, i) => (
          <s-stack key={n.id} direction="block" gap="small-300">
            {(i > 0 || state.canWrite) && <s-divider />}
            {editing?.id === n.id ? (
              <s-stack direction="block" gap="small">
                <s-text-area label="Edit note" labelAccessibilityVisibility="exclusive" value={editing.body} rows={3} maxLength={2000} onChange={(e) => setEditing({ ...editing, body: e.currentTarget.value ?? "" })} />
                <s-stack direction="inline" gap="small">
                  <s-button variant="primary" disabled={!editing.body.trim() || undefined} loading={working || undefined} onClick={save}>
                    Save
                  </s-button>
                  <s-button onClick={() => setEditing(null)}>Cancel</s-button>
                </s-stack>
              </s-stack>
            ) : (
              <s-text>{n.body}</s-text>
            )}
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text color="subdued">
                {n.by ?? "Staff"} · {fmtTime(n.at)}
                {n.editedAt ? ` · edited${n.editedBy && n.editedBy !== n.by ? ` by ${n.editedBy}` : ""} ${fmtTime(n.editedAt)}` : ""}
              </s-text>
              {n.canChange && state.canWrite && editing?.id !== n.id && deleting !== n.id && (
                <>
                  <s-button variant="tertiary" onClick={() => setEditing({ id: n.id, body: n.body })}>
                    Edit
                  </s-button>
                  <s-button variant="tertiary" tone="critical" onClick={() => setDeleting(n.id)}>
                    Delete
                  </s-button>
                </>
              )}
            </s-stack>
            {deleting === n.id && (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-text>Delete this note?</s-text>
                <s-button tone="critical" variant="primary" loading={working || undefined} onClick={() => remove(n.id)}>
                  Delete
                </s-button>
                <s-button onClick={() => setDeleting(null)}>Keep</s-button>
              </s-stack>
            )}
          </s-stack>
        ))}
      </s-stack>
    </s-admin-block>
  );
}
