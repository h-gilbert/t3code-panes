import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
  it("keeps floating previews scoped to their thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().open(refB, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ tabId: "tab-a", maximized: false });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB),
    ).toMatchObject({ tabId: "tab-b" });
  });

  it("preserves position when switching the floating tab within one thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().move(refA, "tab-a", { x: 24, y: 48 });
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      tabId: "tab-b",
      position: { x: 24, y: 48 },
      size: null,
      maximized: false,
      expanded: false,
      windowPosition: null,
      windowSize: null,
    });
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");
    usePreviewMiniPlayerStore.getState().move(refA, "tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      tabId: "tab-b",
      position: null,
      size: null,
      maximized: false,
      expanded: false,
      windowPosition: null,
      windowSize: null,
    });
  });

  it("preserves a thread-bound size while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().resize(refA, "tab-a", { width: 480, height: 320 });
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ tabId: "tab-b", size: { width: 480, height: 320 } });
  });

  it("preserves fullscreen state while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().setMaximized(refA, "tab-a", true);
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ tabId: "tab-b", maximized: true });
  });
});

describe("browser window transitions", () => {
  it("restores separate mini and window geometry across fullscreen and minimization", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, "tab-a");
    store.move(refA, "tab-a", { x: 20, y: 30 });
    store.resize(refA, "tab-a", { width: 320, height: 200 });
    store.setExpanded(refA, "tab-a", true);
    store.move(refA, "tab-a", { x: 400, y: 100 });
    store.resize(refA, "tab-a", { width: 900, height: 600 });
    store.setMaximized(refA, "tab-a", true);
    store.setMaximized(refA, "tab-a", false);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      expanded: true,
      maximized: false,
      windowPosition: { x: 400, y: 100 },
      windowSize: { width: 900, height: 600 },
    });
    store.setExpanded(refA, "tab-a", false);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({
      expanded: false,
      position: { x: 20, y: 30 },
      size: { width: 320, height: 200 },
    });
    store.setExpanded(refA, "tab-a", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)
        ?.windowSize,
    ).toEqual({ width: 900, height: 600 });
  });
  it("ignores a stale window transition and leaves another thread's browser alone", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(refA, "tab-a");
    store.open(refB, "tab-b");
    store.setExpanded(refA, "old-tab", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)
        ?.expanded,
    ).toBe(false);
    store.setExpanded(refA, "tab-a", true);
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB)
        ?.expanded,
    ).toBe(false);
  });
});
