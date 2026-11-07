import { DEFAULT_SERVER_SETTINGS, type ServerConfig, type EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createScratchProjectActions } from "./useScratchProject";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;
const other = "other" as EnvironmentId;

function scratchEnvironment(environmentId: EnvironmentId, scratchWorkspaceRoot: string | null) {
  return {
    environmentId,
    connection: { phase: "connected" },
    serverConfig: { scratchWorkspaceRoot },
  } as never;
}

function actions(
  primary: EnvironmentId | null,
  localRoot: string | null,
  remoteRoot: string | null = "/remote/scratch",
) {
  const environments = [
    scratchEnvironment(local, localRoot),
    scratchEnvironment(remote, remoteRoot),
    scratchEnvironment(other, "/other/scratch"),
  ];
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primary,
    registry: AtomRegistry.make(),
    handleNewThread: async () => null,
  });
}

describe("scratchEnvironmentId", () => {
  it("prefers the primary environment over the one on screen", () => {
    expect(actions(local, "/local/scratch").scratchEnvironmentId(remote)).toBe(local);
    expect(actions(local, "/local/scratch").scratchEnvironmentId(null)).toBe(local);
  });

  it("falls back when the primary environment offers no scratch root", () => {
    expect(actions(local, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null).scratchEnvironmentId(remote)).toBe(remote);
    expect(actions(null, null, null).scratchEnvironmentId(remote)).toBe(other);
    expect(actions(local, null).scratchEnvironmentId(null)).toBeNull();
  });
});

describe("preferred scratch environment", () => {
  it("uses the shared preference and falls back when it is unavailable", () => {
    const config = {
      settings: { ...DEFAULT_SERVER_SETTINGS, preferredThreadEnvironmentId: remote },
      scratchWorkspaceRoot: "/scratch",
      providers: [
        {
          instanceId: "codex",
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [],
        },
      ],
    } as unknown as ServerConfig;
    let connected = true;
    const input = {
      environments: () => [
        {
          environmentId: local,
          connection: { phase: "connected" as const, error: null, traceId: null },
          serverConfig: config,
        },
        {
          environmentId: remote,
          connection: {
            phase: connected ? ("connected" as const) : ("offline" as const),
            error: null,
            traceId: null,
          },
          serverConfig: config,
        },
      ],
      serverConfigs: () =>
        new Map([
          [local, config],
          [remote, config],
        ]),
      primaryEnvironmentId: () => local,
      registry: AtomRegistry.make(),
      handleNewThread: async () => null,
    };
    const scratch = createScratchProjectActions(input);
    expect(scratch.scratchEnvironmentId(local)).toBe(remote);
    connected = false;
    expect(scratch.scratchEnvironmentId(local)).toBe(local);
  });
});
