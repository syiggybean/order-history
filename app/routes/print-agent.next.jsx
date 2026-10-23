import { agentNext, agentStation, text } from "../print.server";

// The agent waits here for the next print job
export const loader = async ({ request }) => {
  const st = await agentStation(request);
  if (!st) return text("error=unknown computer\n", 401);
  return agentNext(st, request);
};
