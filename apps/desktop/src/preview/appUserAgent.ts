import * as Electron from "electron";

import { chromeUserAgent } from "./browserIdentity.ts";

let appUserAgent: string | null = null;

/**
 * Service workers ignore a session's user agent and report the app fallback, so a browser tab's
 * worker would read as Electron. The fallback becomes Chrome; app windows keep T3's own agent.
 */
export const presentWorkersAsChrome = () => {
  const fallback = Electron.app?.userAgentFallback;
  if (typeof fallback !== "string") return;
  appUserAgent ??= fallback;
  Electron.app.userAgentFallback = chromeUserAgent(appUserAgent);
};

export const keepAppUserAgent = (contents: Electron.WebContents) => {
  if (appUserAgent !== null) contents.setUserAgent(appUserAgent);
};
