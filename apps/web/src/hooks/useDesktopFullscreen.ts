import type { DesktopBridge } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";

type FullscreenBridge = Pick<
  DesktopBridge,
  "getWindowFullscreenState" | "onWindowFullscreenStateChange"
>;

interface BridgeFullscreenState {
  readonly listeners: Set<() => void>;
  fullscreen: boolean | undefined;
  unsubscribe: (() => void) | undefined;
}

/**
 * The bridge getter is a synchronous IPC round trip, so the value is cached and kept current
 * by the change event. A cached value is trusted only while that bridge's event is subscribed.
 */
export function createDesktopFullscreenStore(resolveBridge: () => FullscreenBridge | undefined) {
  const states = new WeakMap<FullscreenBridge, BridgeFullscreenState>();

  const subscribe = (onChange: () => void) => {
    const bridge = resolveBridge();
    if (bridge?.onWindowFullscreenStateChange === undefined) return () => {};
    let state = states.get(bridge);
    if (state === undefined) {
      state = { listeners: new Set(), fullscreen: undefined, unsubscribe: undefined };
      states.set(bridge, state);
    }
    const current = state;
    current.listeners.add(onChange);
    if (current.unsubscribe === undefined) {
      // Re-read after subscribing so a change between render and subscribe is not missed.
      current.fullscreen = undefined;
      current.unsubscribe = bridge.onWindowFullscreenStateChange((fullscreen) => {
        current.fullscreen = fullscreen;
        for (const listener of current.listeners) listener();
      });
    }
    return () => {
      current.listeners.delete(onChange);
      if (current.listeners.size > 0) return;
      current.unsubscribe?.();
      current.unsubscribe = undefined;
      current.fullscreen = undefined;
    };
  };

  const getSnapshot = () => {
    const bridge = resolveBridge();
    if (bridge === undefined) return false;
    const state = states.get(bridge);
    if (state?.unsubscribe === undefined) return bridge.getWindowFullscreenState?.() ?? false;
    state.fullscreen ??= bridge.getWindowFullscreenState?.() ?? false;
    return state.fullscreen;
  };

  return { subscribe, getSnapshot };
}

const isMacosDesktop = () => isElectron && isMacPlatform(navigator.platform);
const store = createDesktopFullscreenStore(() =>
  isMacosDesktop() ? window.desktopBridge : undefined,
);
const getServerSnapshot = () => false;

export function useDesktopFullscreen() {
  const macosDesktop = isMacosDesktop();
  const isWindowFullscreen = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    getServerSnapshot,
  );

  return { isMacosDesktop: macosDesktop, isWindowFullscreen } as const;
}
