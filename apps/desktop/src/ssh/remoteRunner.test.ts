import { assert, describe, it } from "@effect/vitest";

import { resolveDesktopSshCliRunner } from "./remoteRunner.ts";

const baseInput = {
  isDevelopment: false,
  appVersion: "0.0.40",
  serverVersion: "0.0.40",
  nodeEngineRange: ">=22.0.0",
  updateChannel: "latest",
} as const;

describe("desktop SSH runner", () => {
  it("uses the package runner for development even when Electron reports a release-shaped version", () => {
    assert.deepEqual(
      resolveDesktopSshCliRunner({ ...baseInput, isDevelopment: true, appVersion: "44.4.2" }),
      { packageSpec: "t3@0.0.40", nodeEngineRange: ">=22.0.0" },
    );
  });

  it("uses a configured remote checkout in development", () => {
    assert.deepEqual(
      resolveDesktopSshCliRunner({
        ...baseInput,
        isDevelopment: true,
        appVersion: "44.4.2",
        devRemoteEntryPath: "/remote/t3/dist/bin.mjs",
      }),
      { nodeScriptPath: "/remote/t3/dist/bin.mjs", nodeEngineRange: ">=22.0.0" },
    );
  });

  it("uses a release archive for published builds and a package for local fork builds", () => {
    assert.deepEqual(resolveDesktopSshCliRunner(baseInput), { archiveVersion: "0.0.40" });
    assert.deepEqual(resolveDesktopSshCliRunner({ ...baseInput, appVersion: "0.0.40-panes.123" }), {
      packageSpec: "t3@latest",
      nodeEngineRange: ">=22.0.0",
    });
  });
});
