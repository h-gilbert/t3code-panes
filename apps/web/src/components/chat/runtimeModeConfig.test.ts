import { describe, expect, it } from "vite-plus/test";

import { draftSupportedRuntimeModes, resolveCompatibleRuntimeMode } from "./runtimeModeConfig";

describe("draftSupportedRuntimeModes", () => {
  const supervisedOnly = {
    instanceId: "fx",
    supportedRuntimeModes: ["approval-required"],
  } as const;
  const noAuto = {
    instanceId: "muse",
    supportedRuntimeModes: ["approval-required", "full-access"],
  } as const;
  const everyMode = { instanceId: "codex" };
  const providers = [supervisedOnly, noAuto, everyMode];

  it.each([
    { label: "one provider that supports it", selections: [supervisedOnly, noAuto] },
    { label: "a provider that reports no modes", selections: [supervisedOnly, everyMode] },
  ])("shows Full access when a multi-model draft includes $label", ({ selections }) => {
    const modes = draftSupportedRuntimeModes(
      supervisedOnly.supportedRuntimeModes,
      selections,
      providers,
    );
    expect(resolveCompatibleRuntimeMode("full-access", modes).mode).toBe("full-access");
  });

  // The fork keeps the chosen mode and reports the incompatibility instead of substituting one.
  it("keeps a mode no selected provider can run, and offers only the supported ones", () => {
    const modes = draftSupportedRuntimeModes(undefined, [supervisedOnly, noAuto], providers);
    const resolved = resolveCompatibleRuntimeMode("auto", modes);
    expect(resolved.mode).toBe("auto");
    expect(resolved.modes).toEqual(["approval-required", "full-access"]);
  });
});
