import { pairAgent } from "../print.server";

// The installer swaps its one-time code for this Mac's own key
export const action = async ({ request }) => {
  const form = await request.formData();
  return pairAgent(form.get("code"), form.get("host"));
};
