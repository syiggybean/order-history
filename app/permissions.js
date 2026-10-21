// Permission levels, shared by the server and the pages (no server-only code here).

export const FEATURES = {
  inventory: {
    label: "Inventory history",
    levels: ["hidden", "view", "undo"],
    levelLabels: { hidden: "Hidden", view: "View", undo: "View + undo" },
  },
  preorders: {
    label: "Pre-orders",
    levels: ["hidden", "view", "manage"],
    levelLabels: { hidden: "Hidden", view: "View", manage: "View + manage" },
  },
  releaseReview: {
    label: "Release date review",
    levels: ["hidden", "view", "manage"],
    levelLabels: { hidden: "Hidden", view: "View", manage: "View + approve" },
  },
  wishlist: {
    label: "Wishlists",
    levels: ["hidden", "view", "manage"],
    levelLabels: { hidden: "Hidden", view: "View report", manage: "View + settings" },
  },
  loyalty: {
    label: "Loyalty",
    levels: ["hidden", "view", "manage"],
    levelLabels: { hidden: "Hidden", view: "View", manage: "View + manage members and settings" },
  },
  blocklist: {
    label: "Blocked customers",
    levels: ["hidden", "view", "manage"],
    levelLabels: { hidden: "Hidden", view: "View", manage: "View + block and unblock" },
  },
  analytics: {
    label: "Analytics",
    levels: ["hidden", "view"],
    levelLabels: { hidden: "Hidden", view: "View" },
  },
  reconciliation: {
    label: "Ordoro reconciliation",
    levels: ["hidden", "view", "manage"],
    levelLabels: { hidden: "Hidden", view: "View", manage: "View + notes, statuses and runs" },
  },
  debug: {
    label: "Debug",
    levels: ["hidden", "view"],
    levelLabels: { hidden: "Hidden", view: "View" },
  },
};

// Features with separate on/off switches instead of one level. Access is a
// list of the switches that are on; any switch also allows viewing.
export const CAPABILITY_FEATURES = {
  shipping: {
    label: "Shipping",
    caps: {
      view: "View shipments and batches",
      batches: "Create and edit batches",
      pick: "Pick",
      pack: "Pack (scan items)",
      ship: "Ship (labels, final scan)",
      override: "Override scan mismatches",
      shipOutside: "Ship outside a batch",
      review: "Flag/Review orders",
      assignedOnly: "Only their assigned batches (limits what they see)",
      settings: "Manage bins and shipping settings",
    },
  },
  purchaseOrders: {
    label: "Purchase orders",
    caps: {
      view: "View purchase orders",
      generate: "Create, edit and receive POs (suppliers and template too)",
      email: "Email POs to suppliers",
      export: "Export POs as PDF",
    },
  },
};
export const isCapabilityFeature = (f) => Boolean(CAPABILITY_FEATURES[f]);

// Higher levels include everything below them
export const LEVEL_RANK = { hidden: 0, view: 1, undo: 2, manage: 2 };

export const emptyAccess = () => ({
  ...Object.fromEntries(Object.keys(FEATURES).map((f) => [f, "hidden"])),
  ...Object.fromEntries(Object.keys(CAPABILITY_FEATURES).map((f) => [f, []])),
});
export const fullAccess = () => ({
  ...Object.fromEntries(Object.entries(FEATURES).map(([f, d]) => [f, d.levels[d.levels.length - 1]])),
  ...Object.fromEntries(Object.entries(CAPABILITY_FEATURES).map(([f, d]) => [f, Object.keys(d.caps)])),
});

export const allows = (user, feature, level = "view") => {
  if (!user?.access) return false;
  if (isCapabilityFeature(feature)) {
    const caps = Array.isArray(user.access[feature]) ? user.access[feature] : [];
    return level === "view" ? caps.length > 0 : caps.includes(level);
  }
  return LEVEL_RANK[user.access[feature]] >= LEVEL_RANK[level];
};
