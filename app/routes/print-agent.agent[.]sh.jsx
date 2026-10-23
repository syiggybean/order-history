import { scripts, text } from "../print.server";

// The agent itself (downloaded by the installer, and by the agent to update itself)
export const loader = async () => text(scripts.agent());
