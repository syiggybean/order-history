// Shipping method badges: which checkout shipping option a shipment uses.
// Green = cheapest, blue = fastest, pink = buyer-selected. The words that
// decide are editable in Shipping settings. Shared by server and pages.

export const METHOD_KINDS = {
  cheapest: { label: "Cheapest", bg: "#e3f1df", fg: "#1a5e20", border: "#9fd09a" },
  fastest: { label: "Fastest", bg: "#e0ecff", fg: "#1c4a9c", border: "#9dbcf0" },
  buyer: { label: "Buyer-selected", bg: "#fde4ef", fg: "#9c1f5c", border: "#f2a9c9" },
};

// Starting words; checked in order fastest → cheapest → buyer, first match wins
export const DEFAULT_METHOD_RULES = {
  fastest: ["express", "priority", "overnight", "next day", "2-day", "2 day", "fastest", "expedited", "rush"],
  cheapest: ["economy", "cheapest", "ground advantage", "media mail", "budget", "saver", "free shipping"],
  buyer: [],
  // A method matching none of the words
  otherwise: "buyer",
};

export function methodRulesOf(raw) {
  let r = raw;
  if (typeof raw === "string") {
    try {
      r = JSON.parse(raw);
    } catch {
      r = null;
    }
  }
  if (!r || typeof r !== "object") return DEFAULT_METHOD_RULES;
  const words = (v, d) => (Array.isArray(v) ? v.map((w) => String(w).trim().toLowerCase()).filter(Boolean).slice(0, 50) : d);
  return {
    fastest: words(r.fastest, DEFAULT_METHOD_RULES.fastest),
    cheapest: words(r.cheapest, DEFAULT_METHOD_RULES.cheapest),
    buyer: words(r.buyer, DEFAULT_METHOD_RULES.buyer),
    otherwise: ["cheapest", "fastest", "buyer", "none"].includes(r.otherwise) ? r.otherwise : DEFAULT_METHOD_RULES.otherwise,
  };
}

// "USPS Priority Mail" → "fastest" (or null when nothing applies)
export function methodKind(method, rules = DEFAULT_METHOD_RULES) {
  const m = String(method ?? "").toLowerCase();
  if (!m) return null;
  for (const kind of ["buyer", "fastest", "cheapest"]) if ((rules[kind] ?? []).some((w) => w && m.includes(w))) return kind;
  return rules.otherwise && rules.otherwise !== "none" ? rules.otherwise : null;
}
