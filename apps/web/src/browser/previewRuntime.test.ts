import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  desktop: false,
  delegates: false,
  host: null as string | null,
  primary: null as string | null,
  serverBrowser: new Set<string>(),
}));

vi.mock("~/env", () => ({
  get isElectron() {
    return state.desktop;
  },
  get delegatesStreamedTabs() {
    return state.delegates;
  },
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { settingsValueAtom: () => "settings" } }));
vi.mock("~/previewStateStore", () => ({ isPreviewSupportedInRuntime: () => state.desktop }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "settings" ? { browserHostEnvironmentId: state.host } : state.primary,
  },
}));
vi.mock("~/state/primaryEnvironment", () => ({ primaryEnvironmentIdAtom: {} }));
vi.mock("~/state/entities", () => ({
  readEnvironmentSupportsServerBrowser: (id: string) => state.serverBrowser.has(id),
  useEnvironmentSupportsServerBrowser: () => false,
}));

import {
  alternatePreviewRuntime,
  previewRuntimeFor,
  rendersServerTabNatively,
} from "./previewRuntime";

const local = "local" as EnvironmentId;
const remote = "remote" as EnvironmentId;

afterEach(() => {
  state.desktop = false;
  state.delegates = false;
  state.host = null;
  state.primary = null;
  state.serverBrowser = new Set();
});

describe("previewRuntimeFor", () => {
  it("opens a remote environment's tabs on this computer in the desktop app", () => {
    state.desktop = true;
    state.primary = local;
    state.serverBrowser = new Set([local, remote]);

    expect(previewRuntimeFor(remote)).toBeUndefined();
    expect(previewRuntimeFor(local)).toBe("server");
  });

  it("uses the environment's browser where the client has none of its own", () => {
    state.serverBrowser = new Set([remote]);

    expect(previewRuntimeFor(remote)).toBe("server");
  });
});

describe("alternatePreviewRuntime", () => {
  it("moves a remote environment's tab between this computer and the environment", () => {
    state.desktop = true;

    expect(alternatePreviewRuntime(remote, local, true, {})).toBe("server");
    expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBe("desktop");
    expect(alternatePreviewRuntime(local, local, true, {})).toBeNull();
    expect(alternatePreviewRuntime(remote, local, false, {})).toBeNull();
  });

  it("offers no move outside the desktop app", () => {
    expect(alternatePreviewRuntime(remote, null, true, { runtime: "server" })).toBeNull();
  });
});

it("hosts selected remote tabs on the primary desktop and keeps them on that host", () => {
  state.desktop = true;
  state.primary = local;
  state.host = local;
  state.serverBrowser = new Set([local, remote]);
  expect(previewRuntimeFor(remote)).toBe("server");
  expect(rendersServerTabNatively(remote, local, { runtime: "server" }, local)).toBe(true);
  expect(rendersServerTabNatively(remote, local, { runtime: "server" }, "other")).toBe(false);
  expect(alternatePreviewRuntime(remote, local, true, { runtime: "server" })).toBeNull();
  // A window whose desktop has a hidden capture host streams the tab instead.
  state.delegates = true;
  expect(rendersServerTabNatively(remote, local, { runtime: "server" }, local)).toBe(false);
});

it("streams the primary environment when it selects a different desktop host", () => {
  state.desktop = true;
  state.primary = local;
  state.host = remote;
  state.serverBrowser = new Set([local, remote]);
  expect(previewRuntimeFor(local)).toBe("server");
  expect(rendersServerTabNatively(local, local, { runtime: "server" }, remote)).toBe(false);
  expect(rendersServerTabNatively(local, remote, { runtime: "server" }, remote)).toBe(true);
  expect(rendersServerTabNatively(local, local, { runtime: "server" }, null)).toBe(true);
  expect(alternatePreviewRuntime(local, local, true, { runtime: "server" })).toBeNull();
});
