import { renderToStaticMarkup } from "react-dom/server";
import { SLIP_CSS, SlipDocument } from "./components/shipping/Slips";
import { htmlToPdf } from "./po-document.server";

// Packing slips as a PDF for the print agent: the same slips as the Print page,
// one per page, on Letter paper or 4 × 6 labels.
const PAGE_CSS = {
  letter: `@page { size: 8.5in 11in; margin: 0.45in; } body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; margin: 0; }`,
  "4x6": `@page { size: 4in 6in; margin: 0.12in; } body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; margin: 0; zoom: 0.55; } .sh-slip svg { zoom: 1.6; }`,
};

export function slipsHtml(data, size = "letter") {
  const body = renderToStaticMarkup(<SlipDocument data={data} />);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Packing slips</title><style>${SLIP_CSS}${PAGE_CSS[size] ?? PAGE_CSS.letter}</style></head><body>${body}</body></html>`;
}

export async function slipsPdf(data, size = "letter") {
  return htmlToPdf(slipsHtml(data, size));
}
