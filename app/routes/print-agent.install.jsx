import { appUrl, scripts, text } from "../print.server";

// curl -fsSL <app>/print-agent/install | bash -s -- CODE
export const loader = async ({ request }) => text(scripts.install(appUrl(request)));
