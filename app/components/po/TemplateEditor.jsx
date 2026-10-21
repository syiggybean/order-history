import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { DEFAULT_TEMPLATE, DOC_CSS, FIELDS, sampleValues, sanitizeTemplate } from "../../po-template";
import { Err, input, muted } from "./ui";

// WYSIWYG editor for the whole PO document, plus the email wording and numbering

const fillSample = (html) => {
  const v = sampleValues();
  return html.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in v ? v[k] : m));
};

const toolBtn = (active) => ({
  appearance: "none",
  border: "1px solid #c9c9c9",
  background: active ? "#e3e3e3" : "#fff",
  borderRadius: "6px",
  padding: "3px 8px",
  minWidth: "30px",
  font: "inherit",
  fontSize: "13px",
  cursor: "pointer",
});

export function TemplateEditor() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const savedRange = useRef(null);
  const [html, setHtml] = useState(data.template);
  const [source, setSource] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [subject, setSubject] = useState(data.emailSubject);
  const [body, setBody] = useState(data.emailBody);
  const [prefix, setPrefix] = useState(data.prefix ?? "PO-");
  const [locationId, setLocationId] = useState(data.defaultLocationId ?? "");
  const [confirmReset, setConfirmReset] = useState(false);
  const [imgError, setImgError] = useState(null);

  // Load (and reload after save) into the editable area
  useEffect(() => {
    setHtml(data.template);
    setSubject(data.emailSubject);
    setBody(data.emailBody);
    setPrefix(data.prefix ?? "PO-");
    if (editorRef.current) editorRef.current.innerHTML = data.template;
  }, [data.template, data.emailSubject, data.emailBody, data.prefix]);

  useEffect(() => {
    if (!source && editorRef.current && editorRef.current.innerHTML !== html) editorRef.current.innerHTML = html;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setConfirmReset(false);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const sync = () => editorRef.current && setHtml(editorRef.current.innerHTML);

  const remember = () => {
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    editorRef.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };
  const exec = (cmd, value = null) => {
    restore();
    document.execCommand("styleWithCSS", false, cmd === "foreColor" || cmd === "hiliteColor");
    document.execCommand(cmd, false, value);
    remember();
    sync();
  };
  const insertHtml = (h) => exec("insertHTML", h);

  const insertField = (key) => {
    if (!key) return;
    if (source) {
      setHtml(`${html}{{${key}}}`);
      return;
    }
    insertHtml(key === "line_items" ? `<div>{{line_items}}</div>` : `{{${key}}}`);
  };

  const addLink = () => {
    const url = window.prompt?.("Link address (https://…)");
    if (url && /^(https?:|mailto:)/i.test(url.trim())) exec("createLink", url.trim());
  };

  const addImage = (file) => {
    setImgError(null);
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) return setImgError("Use a PNG, JPG, GIF or WebP image.");
    if (file.size > 600 * 1024) return setImgError("Keep images under 600 KB so the PO stays small. A logo works best around 400px wide.");
    const r = new FileReader();
    r.onload = () => insertHtml(`<img src="${r.result}" alt="" style="max-width:220px;height:auto" />`);
    r.readAsDataURL(file);
  };

  const clean = useMemo(() => sanitizeTemplate(html), [html]);
  const preview = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_CSS} body{padding:24px}</style></head><body>${fillSample(clean)}</body></html>`, [clean]);
  const dirty = clean !== data.template || subject !== data.emailSubject || body !== data.emailBody || prefix !== (data.prefix ?? "PO-") || (locationId || "") !== (data.defaultLocationId || "");
  const missingLines = !/\{\{\s*line_items\s*\}\}/.test(html);

  const save = (reset = false) =>
    fetcher.submit(
      { intent: "template", template: reset ? "" : clean, reset: reset ? "1" : "0", prefix, locationId: locationId || "", emailSubject: subject, emailBody: body },
      { method: "post" },
    );

  const B = ({ cmd, value, label, title, style }) => (
    <button type="button" title={title} style={{ ...toolBtn(false), ...style }} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(cmd, value)}>
      {label}
    </button>
  );

  return (
    <>
      <s-section heading="PO document">
        <div style={{ ...muted, marginBottom: "8px" }}>
          This is the whole purchase order, as it looks in the PDF and the email attachment. Fields in {"{{double braces}}"} are filled in for each PO.
          {data.isDefault && " You're looking at the built-in layout."}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center", padding: "6px", border: "1px solid #e3e3e3", borderBottom: 0, borderRadius: "8px 8px 0 0", background: "#f7f7f7" }}>
          {!source && (
            <>
              <select
                aria-label="Text style"
                defaultValue=""
                onMouseDown={remember}
                onChange={(e) => {
                  exec("formatBlock", e.target.value);
                  e.target.value = "";
                }}
                style={{ ...input, padding: "3px 6px" }}
              >
                <option value="" disabled>
                  Text style
                </option>
                <option value="P">Paragraph</option>
                <option value="H1">Heading 1</option>
                <option value="H2">Heading 2</option>
                <option value="H3">Heading 3</option>
              </select>
              <B cmd="bold" label={<b>B</b>} title="Bold" />
              <B cmd="italic" label={<i>I</i>} title="Italic" />
              <B cmd="underline" label={<u>U</u>} title="Underline" />
              <label title="Text colour" style={{ ...toolBtn(false), display: "inline-flex", alignItems: "center", gap: "4px" }} onMouseDown={remember}>
                A
                <input type="color" defaultValue="#1a1a1a" onChange={(e) => exec("foreColor", e.target.value)} style={{ width: "18px", height: "18px", border: 0, padding: 0, background: "none" }} />
              </label>
              <span style={{ width: "6px" }} />
              <B cmd="insertUnorderedList" label="• List" title="Bulleted list" />
              <B cmd="insertOrderedList" label="1. List" title="Numbered list" />
              <span style={{ width: "6px" }} />
              <B cmd="justifyLeft" label="⯇" title="Align left" />
              <B cmd="justifyCenter" label="≡" title="Centre" />
              <B cmd="justifyRight" label="⯈" title="Align right" />
              <span style={{ width: "6px" }} />
              <button type="button" style={toolBtn(false)} title="Link" onMouseDown={(e) => (e.preventDefault(), remember())} onClick={addLink}>
                Link
              </button>
              <button type="button" style={toolBtn(false)} title="Image or logo" onMouseDown={(e) => (e.preventDefault(), remember())} onClick={() => fileRef.current?.click()}>
                Image
              </button>
              <B cmd="insertHorizontalRule" label="―" title="Divider line" />
              <B cmd="removeFormat" label="Clear" title="Clear formatting" />
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: "none" }} onChange={(e) => (addImage(e.target.files?.[0]), (e.target.value = ""))} />
            </>
          )}
          <select
            aria-label="Insert field"
            value=""
            onMouseDown={remember}
            onChange={(e) => insertField(e.target.value)}
            style={{ ...input, padding: "3px 6px" }}
          >
            <option value="">Insert field…</option>
            {FIELDS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={toolBtn(source)}
            onClick={() => {
              if (!source) sync();
              setSource(!source);
            }}
          >
            {source ? "Back to editor" : "HTML"}
          </button>
          <button type="button" style={toolBtn(showPreview)} onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? "Hide preview" : "Preview with sample PO"}
          </button>
        </div>

        {source ? (
          <textarea
            aria-label="Template HTML"
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            spellCheck={false}
            style={{ ...input, width: "100%", minHeight: "480px", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: "12px", borderRadius: "0 0 8px 8px" }}
          />
        ) : (
          <div style={{ border: "1px solid #e3e3e3", borderRadius: "0 0 8px 8px", background: "#eceff1", padding: "16px", overflow: "auto" }}>
            <style>{scopedCss}</style>
            <div
              ref={editorRef}
              className="po-editor"
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="PO template"
              onInput={sync}
              onBlur={() => (remember(), sync())}
              onKeyUp={remember}
              onMouseUp={remember}
              style={{ background: "#fff", maxWidth: "816px", minHeight: "600px", margin: "0 auto", padding: "40px 44px", boxShadow: "0 1px 4px rgba(0,0,0,.15)", outline: "none" }}
            />
          </div>
        )}
        {imgError && <div style={{ color: "#b42318", marginTop: "6px" }}>{imgError}</div>}
        {missingLines && (
          <div style={{ marginTop: "8px" }}>
            <s-banner tone="warning" heading="The line items table isn't in the template">
              Suppliers won't see what's being ordered. Use Insert field → Line items table.
            </s-banner>
          </div>
        )}
        {showPreview && (
          <div style={{ marginTop: "12px" }}>
            <div style={{ ...muted, marginBottom: "4px" }}>Preview with made-up values</div>
            <iframe title="Template preview" srcDoc={preview} sandbox="" style={{ width: "100%", height: "760px", border: "1px solid #e3e3e3", borderRadius: "8px", background: "#fff" }} />
          </div>
        )}
      </s-section>

      <s-section heading="Email">
        <div style={{ ...muted, marginBottom: "8px" }}>
          The starting wording when emailing a PO. It can be changed before each send. The PO is attached as a PDF, and every email is bcc'd to {data.bcc}.
        </div>
        <label style={{ display: "block" }}>
          <div style={muted}>Subject</div>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ ...input, width: "100%" }} />
        </label>
        <label style={{ display: "block", marginTop: "10px" }}>
          <div style={muted}>Message</div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} style={{ ...input, width: "100%" }} />
        </label>
        <div style={{ ...muted, marginTop: "4px" }}>
          Fields you can use: {FIELDS.filter((f) => f.key !== "line_items").map((f) => `{{${f.key}}}`).join(" ")}
        </div>
      </s-section>

      <s-section heading="Numbering and receiving">
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          <label>
            <div style={muted}>PO number prefix</div>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={12} style={{ ...input, width: "100%" }} />
            <div style={muted}>Next one looks like {prefix}0001 (numbers keep counting up).</div>
          </label>
          <label>
            <div style={muted}>Default receiving location</div>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} style={{ ...input, width: "100%" }}>
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </s-section>

      <s-section>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <s-button variant="primary" onClick={() => save(false)} {...(fetcher.state !== "idle" ? { loading: true } : {})} {...(!dirty ? { disabled: true } : {})}>
            Save
          </s-button>
          {dirty && (
            <s-button
              variant="tertiary"
              onClick={() => {
                setHtml(data.template);
                if (editorRef.current) editorRef.current.innerHTML = data.template;
                setSubject(data.emailSubject);
                setBody(data.emailBody);
                setPrefix(data.prefix ?? "PO-");
                setLocationId(data.defaultLocationId ?? "");
              }}
            >
              Discard changes
            </s-button>
          )}
          <span style={{ flex: 1 }} />
          {!data.isDefault &&
            (confirmReset ? (
              <span style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}>
                Go back to the built-in layout and email wording?
                <s-button tone="critical" onClick={() => save(true)}>
                  Reset
                </s-button>
                <s-button variant="tertiary" onClick={() => setConfirmReset(false)}>
                  Cancel
                </s-button>
              </span>
            ) : (
              <s-button variant="tertiary" onClick={() => setConfirmReset(true)}>
                Reset to default
              </s-button>
            ))}
          {fetcher.state === "idle" && fetcher.data?.ok && !dirty && <span style={{ color: "#1a5e20" }}>Saved</span>}
        </div>
        <Err data={fetcher.data} />
      </s-section>
    </>
  );
}

// The editor shows the same styles as the PDF
const scopedCss = DOC_CSS.replace(/@page[^}]*}/, "")
  .replace(/(^|})\s*([^{}@]+)\{/g, (m, close, sel) => `${close}\n${sel.split(",").map((s) => (s.trim() === "body" ? ".po-editor" : `.po-editor ${s.trim()}`)).join(", ")} {`)
  .concat(`.po-editor:empty:before{content:"Start typing…";color:#999}`);

export { DEFAULT_TEMPLATE };
