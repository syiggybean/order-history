import { agentHello, agentStation, text } from "../print.server";

// The agent reports its printers (at start, every few minutes, and when asked)
export const action = async ({ request }) => {
  const st = await agentStation(request);
  if (!st) return text("error=unknown computer\n", 401);
  return agentHello(st, await request.formData());
};
