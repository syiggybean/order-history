import { agentFile, agentStation, text } from "../print.server";

// The file for a job the agent has taken
export const loader = async ({ request }) => {
  const st = await agentStation(request);
  if (!st) return text("error=unknown computer\n", 401);
  return agentFile(st, new URL(request.url).searchParams.get("job"));
};
