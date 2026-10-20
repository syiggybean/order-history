import db from "../db.server";
import { recordClick } from "../preorder-notify.server";

// Links in notification emails: counts the click, then goes to the product
export const loader = async ({ params }) => {
  const target = await recordClick(String(params.token ?? "")).catch(() => null);
  if (target) return Response.redirect(target, 302);
  const any = await db.preorderSettings.findFirst({ where: { storeUrl: { not: null } } });
  return Response.redirect(any?.storeUrl ?? "https://yiggybean.com", 302);
};
