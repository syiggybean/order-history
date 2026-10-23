import { scripts, text } from "../print.server";

// curl -fsSL <app>/print-agent/uninstall | bash
export const loader = async () => text(scripts.uninstall());
