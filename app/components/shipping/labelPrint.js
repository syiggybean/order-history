// Printing, viewing and downloading label files ({ filename, contentType, format, data: base64 }).
//
// Quick print loads the label into a hidden frame and prints it. With Chrome's
// kiosk printing switched on for the packing computer it goes straight to the
// last-used printer; otherwise Chrome shows its print dialog with that printer
// already chosen. ZPL can't be printed from a browser, so it downloads instead.

export function fileToBlob(file) {
  const bin = atob(file.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: file.contentType || "application/pdf" });
}

export function downloadFile(file) {
  const url = URL.createObjectURL(fileToBlob(file));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename || "label.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Returns "printed" | "downloaded" (ZPL)
export function quickPrint(file) {
  if (file.format === "ZPL") {
    downloadFile(file);
    return "downloaded";
  }
  const url = URL.createObjectURL(fileToBlob(file));
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch {
      // Some browsers won't print a PDF inside a frame: open it instead
      window.open(url, "_blank");
    }
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 120_000);
  };
  document.body.appendChild(frame);
  return "printed";
}

// Opens a tab right away (so the browser allows it), then fills it with the label
export function openViewer() {
  const w = window.open("", "_blank");
  if (w) {
    try {
      w.document.write("<title>Label</title><p style='font:14px sans-serif;padding:20px'>Loading the label…</p>");
    } catch {
      /* fine */
    }
  }
  return w;
}

export function showInViewer(w, file) {
  const url = URL.createObjectURL(fileToBlob(file));
  if (w && !w.closed) w.location.href = url;
  else window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}
