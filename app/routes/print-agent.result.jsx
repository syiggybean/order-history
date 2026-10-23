import { agentResult, agentStation, text } from "../print.server";

// Printed, stuck in the Mac's print queue, or failed
export const action = async ({ request }) => {
  const st = await agentStation(request);
  if (!st) return text("error=unknown computer\n", 401);
  return agentResult(st, await request.formData());
};
