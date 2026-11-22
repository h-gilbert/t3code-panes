import type { DesktopBridge } from "@t3tools/contracts";

// Changing the setting relaunches the app, so one synchronous read per bridge is enough.
const localEnvironmentEnabledByBridge = new WeakMap<
  Pick<DesktopBridge, "getLocalEnvironmentEnabled">,
  boolean
>();

export function isLocalEnvironmentDisabled(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.desktopBridge;
  if (bridge === undefined) return false;
  let enabled = localEnvironmentEnabledByBridge.get(bridge);
  if (enabled === undefined) {
    enabled = bridge.getLocalEnvironmentEnabled() !== false;
    localEnvironmentEnabledByBridge.set(bridge, enabled);
  }
  return !enabled;
}
