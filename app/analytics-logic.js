// Sell-through analytics: the maths, grouping, sorting and suggestions.
// Shared by the page and the server (no server-only code here).

// When to suggest carrying more or less. Plain numbers so they're easy to tune.
export const RULES = {
  newDays: 30, // products younger than this are "too new to tell"
  minUnits: 3, // fewer units than this (sold + on hand + received) is too little to judge
  moreSellThrough: 0.7, // sold at least 70% of the stock it had…
  moreWeeksLeft: 4, // …and under 4 weeks of stock left
  moreMinMargin: 0.1, // …and at least 10% margin (when cost is known)
  lessSellThrough: 0.25, // sold under 25% of the stock it had…
  lessMinOnHand: 5, // …with at least 5 still on hand
  lessWeeksLeft: 26, // or over 6 months of stock at the current pace
  lessMaxMargin: 0.05, // or under 5% margin
};

export const GROUPS = {
  type: { label: "Category", empty: "No product type" },
  vendor: { label: "Publisher / vendor", empty: "No vendor" },
  supplier: { label: "Supplier", empty: "No purchase orders" },
  item: { label: "Item", empty: "" },
};

export const SORTS = {
  best: { label: "Best selling", key: "sold", dir: -1 },
  worst: { label: "Worst selling", key: "sold", dir: 1 },
  profitMost: { label: "Most profitable", key: "profit", dir: -1 },
  profitLeast: { label: "Least profitable", key: "profit", dir: 1 },
  stHigh: { label: "Highest sell-through", key: "sellThrough", dir: -1 },
  stLow: { label: "Lowest sell-through", key: "sellThrough", dir: 1 },
  gap: { label: "Most received but unsold", key: "gap", dir: -1 },
  marginHigh: { label: "Highest margin", key: "margin", dir: -1 },
  marginLow: { label: "Lowest margin", key: "margin", dir: 1 },
  sales: { label: "Most net sales", key: "netSales", dir: -1 },
  cover: { label: "Most weeks of stock", key: "weeksLeft", dir: -1 },
};

const sumKeys = ["sold", "received", "netSales", "cost", "profit", "costedSales"];

// Derived numbers for one product or group
export function measure(r, days) {
  const weeks = Math.max(1, days) / 7;
  const onHand = r.onHand ?? null;
  const perWeek = r.sold / weeks;
  const sellThrough = r.received > 0 ? r.sold / r.received : null;
  // Of the stock it had during the period (sold + what's left), how much sold
  const stockBase = r.sold + Math.max(0, onHand ?? 0);
  const stockSellThrough = stockBase > 0 ? r.sold / stockBase : null;
  const weeksLeft = onHand === null ? null : perWeek > 0 ? Math.max(0, onHand) / perWeek : onHand > 0 ? Infinity : 0;
  const margin = r.costedSales > 0 ? r.profit / r.costedSales : null;
  return { ...r, perWeek, sellThrough, stockSellThrough, weeksLeft, margin, gap: r.received - r.sold };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const weeksText = (w) => (w === Infinity ? "no sales to measure against" : w < 1 ? "under a week of stock left" : `${Math.round(w)} week${Math.round(w) === 1 ? "" : "s"} of stock left`);

// Carry more / keep / carry less, with the reason in words
export function recommend(m, { endDay, rules = RULES } = {}) {
  if (m.status === "deleted") return { action: "none", reason: "Deleted from Shopify" };
  if (m.status === "archived") return { action: "none", reason: "Archived" };
  const ageDays = m.createdAt && endDay ? (Date.parse(`${endDay}T23:59:59Z`) - Date.parse(m.createdAt)) / 86400000 : null;
  if (ageDays !== null && ageDays < rules.newDays) return { action: "new", reason: `Added ${Math.max(0, Math.round(ageDays))} days ago` };
  const units = m.sold + Math.max(0, m.onHand ?? 0) + m.received;
  if (units < rules.minUnits) return { action: "new", reason: "Too few units to judge" };

  const st = m.stockSellThrough;
  const marginOk = m.margin === null || m.margin >= rules.moreMinMargin;
  if (st !== null && st >= rules.moreSellThrough && (m.onHand !== null && (m.onHand <= 0 || m.weeksLeft < rules.moreWeeksLeft)) && marginOk) {
    return { action: "more", reason: `Sold ${pct(st)} of its stock; ${m.onHand <= 0 ? "sold out" : weeksText(m.weeksLeft)}` };
  }
  if (m.margin !== null && m.sold >= rules.minUnits && m.margin < rules.lessMaxMargin) {
    return { action: "less", reason: `Only ${pct(m.margin)} margin` };
  }
  if (st !== null && st < rules.lessSellThrough && (m.onHand ?? 0) >= rules.lessMinOnHand) {
    return { action: "less", reason: `Sold ${pct(st)} of its stock; ${m.onHand} still on hand` };
  }
  if (m.weeksLeft !== null && m.weeksLeft > rules.lessWeeksLeft && (m.onHand ?? 0) >= rules.lessMinOnHand) {
    return { action: "less", reason: m.weeksLeft === Infinity ? `No sales; ${m.onHand} on hand` : `${weeksText(m.weeksLeft)} at this pace` };
  }
  if (st !== null && st >= rules.moreSellThrough && !marginOk) return { action: "keep", reason: `Sells well (${pct(st)}) but margin is ${pct(m.margin)}` };
  return { action: "keep", reason: st !== null ? `Sold ${pct(st)} of its stock` : "Steady" };
}

// Rows → groups (or items), each measured and with a suggestion
export function buildGroups(rows, { by = "type", days, endDay, rules = RULES } = {}) {
  const items = rows.map((r) => {
    const m = measure(r, days);
    return { ...m, name: r.title, key: r.id, rec: recommend(m, { endDay, rules }) };
  });
  if (by === "item") return items.map((m) => ({ ...m, items: [m], count: 1 }));
  const empty = GROUPS[by]?.empty ?? "None";
  const groups = new Map();
  for (const m of items) {
    const name = (m[by] && String(m[by]).trim()) || empty;
    const g = groups.get(name) ?? { key: name, name, items: [], onHand: 0, hasStock: false, ...Object.fromEntries(sumKeys.map((k) => [k, 0])) };
    for (const k of sumKeys) g[k] += m[k] ?? 0;
    if (m.onHand !== null) {
      g.onHand += Math.max(0, m.onHand);
      g.hasStock = true;
    }
    g.items.push(m);
    groups.set(name, g);
  }
  return [...groups.values()].map((g) => {
    const m = measure({ ...g, onHand: g.hasStock ? g.onHand : null }, days);
    const more = g.items.filter((i) => i.rec.action === "more").length;
    const less = g.items.filter((i) => i.rec.action === "less").length;
    const rec = recommend({ ...m, status: null, createdAt: null }, { endDay, rules });
    return {
      ...m,
      count: g.items.length,
      more,
      less,
      rec: {
        ...rec,
        reason: [
          rec.reason,
          g.items.length > 1
            ? [more ? `${more} item${more === 1 ? "" : "s"} to carry more` : null, less ? `${less} to carry less` : null].filter(Boolean).join(", ") || null
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    };
  });
}

// Sort with nulls (unknown) always last
export function sortGroups(list, sortKey, dir) {
  const key = SORTS[sortKey]?.key ?? sortKey;
  const d = SORTS[sortKey]?.dir ?? dir ?? -1;
  const val = (x) => {
    const v = x[key];
    if (typeof v === "string") return v.toLowerCase();
    return v;
  };
  return [...list].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    const na = va === null || va === undefined || Number.isNaN(va);
    const nb = vb === null || vb === undefined || Number.isNaN(vb);
    if (na && nb) return String(a.name).localeCompare(String(b.name));
    if (na) return 1;
    if (nb) return -1;
    if (va < vb) return -d;
    if (va > vb) return d;
    return String(a.name).localeCompare(String(b.name));
  });
}

// "Worst selling" means the worst of things you actually stock or bought,
// not the thousands of old products with nothing at all
export function relevant(list, sortKey) {
  if (sortKey === "worst" || sortKey === "stLow") return list.filter((g) => g.received > 0 || (g.onHand ?? 0) > 0);
  if (sortKey === "marginLow" || sortKey === "marginHigh") return list.filter((g) => g.margin !== null);
  return list;
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : v === Infinity ? "∞" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fixed = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? (n === Infinity ? "∞" : "") : n.toFixed(d));

export function toCsv(list, by) {
  const head = [GROUPS[by]?.label ?? "Name", ...(by === "item" ? ["Category", "Publisher / vendor", "Supplier", "SKU", "Status"] : ["Items"]), "Received", "Sold", "Sell-through %", "Sold of stock %", "Net sales", "Cost", "Gross profit", "Margin %", "On hand", "Weeks of stock", "Suggestion", "Why"];
  const lines = [head.map(csvCell).join(",")];
  for (const g of list) {
    lines.push(
      [
        g.name,
        ...(by === "item" ? [g.type, g.vendor, g.supplier, g.sku, g.status] : [g.count]),
        g.received,
        g.sold,
        g.sellThrough === null ? "" : fixed(g.sellThrough * 100, 1),
        g.stockSellThrough === null ? "" : fixed(g.stockSellThrough * 100, 1),
        fixed(g.netSales),
        fixed(g.cost),
        fixed(g.profit),
        g.margin === null ? "" : fixed(g.margin * 100, 1),
        g.onHand ?? "",
        fixed(g.weeksLeft, 1),
        { more: "Carry more", less: "Carry less", keep: "Keep", new: "Too new", none: "—" }[g.rec.action],
        g.rec.reason,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}
