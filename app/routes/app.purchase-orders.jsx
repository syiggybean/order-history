import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NoAccess } from "../components/NoAccess";
import { can, denied, getStaff, loadWithAccess } from "../permissions.server";
import { errorMessage } from "../preorders.server";
import {
  PoError,
  addNote,
  createPo,
  deleteNote,
  deletePo,
  getPoSettings,
  linesFromCsv,
  listLocations,
  listPos,
  listSuppliers,
  markSent,
  poDetail,
  receive,
  rematch,
  savePoSettings,
  saveSupplier,
  setStatus,
  updatePo,
} from "../po.server";
import { PO_BCC, emailDefaults, emailPo, poPdf, renderPoHtml } from "../po-document.server";
import { DEFAULT_EMAIL_BODY, DEFAULT_EMAIL_SUBJECT, DEFAULT_TEMPLATE, sanitizeTemplate } from "../po-template";
import db from "../db.server";
import { PoList } from "../components/po/PoList";
import { NewPo } from "../components/po/NewPo";
import { PoDetail } from "../components/po/PoDetail";
import { Suppliers } from "../components/po/Suppliers";
import { TemplateEditor } from "../components/po/TemplateEditor";

// Purchase orders: build from a CSV, send to the supplier (email or PDF),
// receive into stock, close. Switches: view, generate, email, export.

const capsOf = (user) => ({
  view: can(user, "purchaseOrders", "view"),
  generate: can(user, "purchaseOrders", "generate"),
  email: can(user, "purchaseOrders", "email"),
  export: can(user, "purchaseOrders", "export"),
});

export const loader = async ({ request }) => {
  const { admin, session, user, noAccess } = await loadWithAccess(request, "purchaseOrders", "view");
  if (noAccess) return { noAccess: true };
  const shop = session.shop;
  const p = new URL(request.url).searchParams;
  const view = ["new", "suppliers", "template"].includes(p.get("view")) ? p.get("view") : p.get("po") ? "po" : "list";
  const caps = capsOf(user);
  const settings = await getPoSettings(shop);
  let locations = [];
  if (view !== "list") {
    try {
      locations = await listLocations(admin);
    } catch (e) {
      console.error("[po] locations:", errorMessage(e));
    }
  }
  const base = { view, caps, bcc: PO_BCC, locations, defaultLocationId: settings.locationId ?? locations[0]?.id ?? null };
  if (view === "list") return { ...base, ...(await listPos(shop, { status: p.get("status") ?? "active", q: p.get("q") ?? "" })), status: p.get("status") ?? "active" };
  if (view === "new") return { ...base, suppliers: (await listSuppliers(shop)).map(supplierView) };
  if (view === "suppliers") return { ...base, suppliers: (await listSuppliers(shop, { archived: true })).map(supplierView) };
  if (view === "template")
    return {
      ...base,
      template: sanitizeTemplate(settings.template || DEFAULT_TEMPLATE),
      isDefault: !settings.template,
      emailSubject: settings.emailSubject || DEFAULT_EMAIL_SUBJECT,
      emailBody: settings.emailBody || DEFAULT_EMAIL_BODY,
      prefix: settings.prefix,
    };
  try {
    const detail = await poDetail(shop, p.get("po"));
    return { ...base, ...detail, suppliers: (await listSuppliers(shop)).map(supplierView) };
  } catch (e) {
    return { ...base, view: "missing", error: e instanceof PoError ? e.message : errorMessage(e) };
  }
};

const supplierView = (s) => ({ id: s.id, name: s.name, emails: s.emails, contact: s.contact, phone: s.phone, address: s.address, taxRate: s.taxRate, notes: s.notes, archived: s.archived });

const NEEDS = {
  parse: "generate",
  create: "generate",
  update: "generate",
  rematch: "generate",
  status: "generate",
  delete: "generate",
  receive: "generate",
  addNote: "generate",
  deleteNote: "generate",
  supplier: "generate",
  template: "generate",
  settings: "generate",
  preview: "view",
  emailDefaults: "email",
  email: "email",
  pdf: "export",
};

export const action = async ({ request }) => {
  const { admin, session, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const need = NEEDS[intent];
  if (!need) return { intent, error: "Unknown action" };
  if (!can(user, "purchaseOrders", need)) return { intent, ...denied("purchaseOrders", need) };
  const shop = session.shop;
  const id = form.get("id");
  const json = (k, fb) => {
    try {
      return JSON.parse(String(form.get(k) ?? ""));
    } catch {
      return fb;
    }
  };
  try {
    switch (intent) {
      case "parse":
        return { intent, ...linesFromCsv(String(form.get("csv") ?? "")) };
      case "create": {
        const po = await createPo(
          shop,
          admin,
          {
            lines: json("lines", []),
            supplierId: form.get("supplierId") || null,
            locationId: form.get("locationId") || null,
            expectedAt: form.get("expectedAt") || null,
            supplierNote: form.get("supplierNote"),
            sourceFile: form.get("sourceFile"),
            currency: await shopCurrency(admin),
          },
          user,
        );
        return { intent, ok: true, id: po.id, poNumber: po.poNumber };
      }
      case "update": {
        const input = {};
        for (const k of ["supplierId", "expectedAt", "supplierNote", "locationId"]) if (form.has(k)) input[k] = form.get(k);
        if (form.has("lines")) input.lines = json("lines", []);
        await updatePo(shop, admin, id, input, user);
        return { intent, ok: true };
      }
      case "rematch":
        return { intent, ok: true, ...(await rematch(shop, admin, id, user)) };
      case "status":
        await setStatus(shop, id, String(form.get("to")), user);
        return { intent, ok: true };
      case "delete":
        await deletePo(shop, id, user);
        return { intent, ok: true, deleted: true };
      case "receive":
        return { intent, ok: true, ...(await receive(shop, admin, id, json("counts", {}), user)) };
      case "addNote":
        await addNote(shop, id, form.get("body"), user);
        return { intent, ok: true };
      case "deleteNote":
        await deleteNote(shop, form.get("noteId"), user);
        return { intent, ok: true };
      case "supplier": {
        const s = await saveSupplier(shop, json("supplier", {}));
        return { intent, ok: true, supplier: supplierView(s) };
      }
      case "template": {
        const html = String(form.get("template") ?? "");
        if (html.length > 3_000_000) throw new PoError("The template is too big (pictures make it large). Use smaller images.");
        const reset = form.get("reset") === "1";
        await getPoSettings(shop);
        await db.poSettings.update({ where: { shop }, data: { template: reset ? null : sanitizeTemplate(html) } });
        await savePoSettings(shop, {
          prefix: form.get("prefix") ?? undefined,
          locationId: form.get("locationId") || null,
          emailSubject: reset ? "" : form.get("emailSubject") ?? undefined,
          emailBody: reset ? "" : form.get("emailBody") ?? undefined,
        });
        return { intent, ok: true };
      }
      case "settings":
        await savePoSettings(shop, { prefix: form.get("prefix"), locationId: form.get("locationId") || null });
        return { intent, ok: true };
      case "preview": {
        const { html } = await renderPoHtml(shop, admin, id);
        return { intent, html };
      }
      case "emailDefaults":
        return { intent, ...(await emailDefaults(shop, admin, id)) };
      case "email":
        return { intent, ok: true, ...(await emailPo(shop, admin, id, { to: form.get("to"), cc: form.get("cc"), subject: form.get("subject"), body: form.get("body") }, user)) };
      case "pdf": {
        const { po, pdf, filename } = await poPdf(shop, admin, id);
        await markSent(shop, po.id, { how: "export" }, user);
        return { intent, ok: true, filename, data: pdf.toString("base64") };
      }
    }
  } catch (e) {
    if (e instanceof PoError) return { intent, error: e.message };
    console.error(`[po] ${intent}:`, errorMessage(e));
    return { intent, error: errorMessage(e) };
  }
  return { intent, error: "Unknown action" };
};

let currencyCache = null;
async function shopCurrency(admin) {
  if (currencyCache) return currencyCache;
  try {
    const r = await admin.graphql(`#graphql
      query PoCurrency { shop { currencyCode } }`);
    currencyCache = (await r.json())?.data?.shop?.currencyCode ?? "USD";
  } catch {
    return "USD";
  }
  return currencyCache;
}

// ---------------------------------------------------------------------------

export default function PurchaseOrders() {
  const data = useLoaderData();
  if (data.noAccess) return <NoAccess feature="Purchase orders" />;
  return <Page />;
}

function Page() {
  const data = useLoaderData();
  const [, setParams] = useSearchParams();
  const go = (p) => setParams(p);
  const tabs = [
    ["list", "Purchase orders"],
    ...(data.caps.generate ? [["suppliers", "Suppliers"], ["template", "PO template"]] : []),
  ];
  const active = data.view === "po" || data.view === "new" || data.view === "missing" ? "list" : data.view;
  return (
    <s-page heading="Purchase orders">
      <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid #e3e3e3", marginBottom: "12px", flexWrap: "wrap" }}>
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => go(k === "list" ? {} : { view: k })}
            style={{ appearance: "none", border: 0, background: "none", padding: "8px 14px", font: "inherit", fontWeight: active === k ? 700 : 500, borderBottom: `3px solid ${active === k ? "#303030" : "transparent"}`, cursor: "pointer" }}
          >
            {label}
          </button>
        ))}
      </div>
      {data.view === "list" && <PoList />}
      {data.view === "new" && <NewPo />}
      {data.view === "po" && <PoDetail />}
      {data.view === "suppliers" && <Suppliers />}
      {data.view === "template" && <TemplateEditor />}
      {data.view === "missing" && (
        <s-section>
          <s-banner tone="critical" heading={data.error} />
          <div style={{ marginTop: "10px" }}>
            <s-button onClick={() => go({})}>Back to purchase orders</s-button>
          </div>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
