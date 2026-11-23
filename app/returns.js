// Returns: words shared by the server and the pages (no server code here)

// What the verifier found, item by item, and what Shopify records for it
export const CONDITIONS = {
  resellable: { label: "Resellable", disposition: "RESTOCKED", restock: true, hint: "Goes back into stock" },
  damaged: { label: "Damaged", disposition: "NOT_RESTOCKED", restock: false, hint: "Recorded, not restocked" },
  wrong_item: { label: "Wrong item came back", disposition: "MISSING", restock: false, hint: "Our item is recorded as missing" },
  missing: { label: "Missing", disposition: "MISSING", restock: false, hint: "Recorded as missing" },
};

export const RETURN_REASONS = ["Changed mind", "Damaged on arrival", "Defective", "Wrong item sent", "Didn't fit / not as expected", "Arrived too late", "Other"];

export const DECLINE_REASONS = { RETURN_PERIOD_ENDED: "Return window has ended", FINAL_SALE: "Final sale", OTHER: "Other" };

// Where a return is, as staff see it
export const STAGES = {
  requested: "Requested",
  awaiting: "Awaiting arrival",
  verified: "Verified",
  closed: "Closed",
  declined: "Declined",
  cancelled: "Cancelled",
};
