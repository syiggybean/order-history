import { can, getStaff } from "../permissions.server";
import { workingShop } from "../sandbox.server";
import { productBinsView } from "../bins-sync.server";
import { setBin } from "../batches.server";
import { errorMessage } from "../preorders.server";

// Bins for the product quick view, on any page. Anyone who can open the quick view sees
// them; changing one needs the Stock switch "Edit bin locations".
const SEES = [
  ["shipping", "view"],
  ["preorders", "view"],
  ["releaseReview", "view"],
  ["wishlist", "view"],
  ["inventory", "view"],
  ["purchaseOrders", "view"],
  ["receiving", "view"],
  ["analytics", "view"],
  ["stock", "view"],
];

export const action = async ({ request }) => {
  const { session, admin, user } = await getStaff(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const canEdit = can(user, "stock", "bins");
  if (!SEES.some(([f, l]) => can(user, f, l))) return { intent, error: "You don't have access to bins." };
  const workShop = await workingShop(session.shop, user);
  try {
    if (intent === "productBins") {
      const view = await productBinsView(session.shop, String(form.get("productId") ?? ""), { admin, workShop });
      if (!view) return { intent, error: "This product no longer exists." };
      return { intent, ...view, canEdit, sandbox: workShop !== session.shop };
    }
    if (intent === "setBin") {
      if (!canEdit) return { intent, error: "Changing bins needs the Stock permission “Edit bin locations”." };
      const item = JSON.parse(String(form.get("item") ?? "{}"));
      return { intent, ok: true, ...(await setBin(workShop, item, form.get("bin"), user)) };
    }
  } catch (e) {
    console.error(`[bins] ${intent}:`, errorMessage(e));
    return { intent, error: e?.message ?? "Something went wrong." };
  }
  return { intent, error: "Unknown action" };
};
