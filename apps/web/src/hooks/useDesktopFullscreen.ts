import { useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";

const isMacosDesktop = () => isElectron && isMacPlatform(navigator.platform);
const subscribe = (onChange: () => void) =>
  (isMacosDesktop()
    ? window.desktopBridge?.onWindowFullscreenStateChange?.(onChange)
    : undefined) ?? (() => {});
const getSnapshot = () =>
  isMacosDesktop() && (window.desktopBridge?.getWindowFullscreenState?.() ?? false);
const getServerSnapshot = () => false;

export function useDesktopFullscreen() {
  const macosDesktop = isMacosDesktop();
  const isWindowFullscreen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return { isMacosDesktop: macosDesktop, isWindowFullscreen } as const;
}
