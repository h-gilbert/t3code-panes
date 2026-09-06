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
    ).toMatchObject({ tabId: "tab-a", maximized: false, floating: false });
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
      tabId: "tab-b",
      position: null,
      size: null,
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
