import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadPreviewMiniPlayerTabId,
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
  it("returns to a fixed preview without losing the floating window's layout", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, "tab-a");
    store.setFloating(refA, "tab-a", true);
    store.resize(refA, "tab-a", { width: 800, height: 560 });
    store.move(refA, "tab-a", { x: 100, y: 80 });
    store.setMaximized(refA, "tab-a", true);
    store.setMaximized(refA, "tab-a", false);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ floating: true, maximized: false });
    store.setFloating(refA, "tab-a", false);
    store.open(refA, "tab-b");
    store.setFloating(refA, "tab-a", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      floating: false,
      size: { width: 800, height: 560 },
      position: { x: 100, y: 80 },
    });
  });

  it("opens floating browsers scoped to their thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().open(refB, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      source: { kind: "browser", tabId: "tab-a" },
      maximized: false,
      floating: false,
    });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB),
    ).toMatchObject({ source: { kind: "browser", tabId: "tab-b" } });
  });

  it("preserves position when switching the floating tab within one thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().move(refA, "tab-a", { x: 24, y: 48 });
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: { kind: "browser", tabId: "tab-b" },
      position: { x: 24, y: 48 },
      size: null,
      width: null,
      maximized: false,
      floating: false,
    });
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");
    usePreviewMiniPlayerStore.getState().move(refA, "tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: { kind: "browser", tabId: "tab-b" },
      position: null,
      size: null,
      width: null,
      maximized: false,
      floating: false,
    });
  });

  it("preserves a thread-bound size while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().resize(refA, "tab-a", { width: 480, height: 320 });
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      source: { kind: "browser", tabId: "tab-b" },
      size: { width: 480, height: 320 },
    });
  });

  it("preserves fullscreen state while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().setMaximized(refA, "tab-a", true);
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ source: { kind: "browser", tabId: "tab-b" }, maximized: true });
  });
});

describe("browser window transitions", () => {
  it("restores floating geometry across fullscreen and the fixed compact preview", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, "tab-a");
    store.move(refA, "tab-a", { x: 20, y: 30 });
    store.resize(refA, "tab-a", { width: 320, height: 200 });
    store.setFloating(refA, "tab-a", true);
    store.move(refA, "tab-a", { x: 400, y: 100 });
    store.resize(refA, "tab-a", { width: 900, height: 600 });
    store.setMaximized(refA, "tab-a", true);
    store.setMaximized(refA, "tab-a", false);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      floating: true,
      maximized: false,
      position: { x: 400, y: 100 },
      size: { width: 900, height: 600 },
    });
    store.setFloating(refA, "tab-a", false);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      floating: false,
      position: { x: 400, y: 100 },
      size: { width: 900, height: 600 },
    });
    store.setFloating(refA, "tab-a", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.size,
    ).toEqual({ width: 900, height: 600 });
  });
  it("ignores a stale window transition and leaves another thread's browser alone", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, "tab-a");
    store.open(refB, "tab-b");
    store.setFloating(refA, "old-tab", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)
        ?.floating,
    ).toBe(false);
    store.setFloating(refA, "tab-a", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB)
        ?.floating,
    ).toBe(false);
  });
});

describe("device mini players", () => {
  it("replaces the browser without borrowing its fullscreen geometry", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, "tab-a");
    store.setMaximized(refA, "tab-a", true);
    store.resize(refA, "tab-a", { width: 900, height: 600 });
    const source = {
      kind: "device",
      platform: "ios",
      hostId: "local",
      deviceId: "phone",
      name: "iPhone",
    } as const;
    store.open(refA, source);
    const state = selectThreadPreviewMiniPlayer(
      usePreviewMiniPlayerStore.getState().byThreadKey,
      refA,
    );
    expect(state).toMatchObject({
      source,
      maximized: false,
      position: null,
      size: null,
      width: null,
    });
    expect(
      selectThreadPreviewMiniPlayerTabId(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBeNull();
    store.move(refA, "tab-a", { x: 999, y: 999 });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toBe(state);
    store.resize(refA, "device:local:phone", 240);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.width,
    ).toBe(240);
    store.open(refA, { ...source, name: "Renamed" });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.width,
    ).toBe(240);
  });
});
