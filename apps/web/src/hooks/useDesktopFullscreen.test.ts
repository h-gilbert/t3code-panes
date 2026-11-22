import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopFullscreenStore } from "./useDesktopFullscreen";

function makeBridge(initial: boolean) {
  let emit: ((fullscreen: boolean) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    emit = undefined;
  });
  const bridge = {
    getWindowFullscreenState: vi.fn(() => initial),
    onWindowFullscreenStateChange: vi.fn((listener: (fullscreen: boolean) => void) => {
      emit = listener;
      return unsubscribe;
    }),
  };
  return { bridge, unsubscribe, emit: (fullscreen: boolean) => emit?.(fullscreen) };
}

describe("createDesktopFullscreenStore", () => {
  it("reads the bridge once per subscription and follows change events", () => {
    const { bridge, emit } = makeBridge(false);
    const store = createDesktopFullscreenStore(() => bridge);
    const onChange = vi.fn();
    const stop = store.subscribe(onChange);

    for (let render = 0; render < 50; render += 1) expect(store.getSnapshot()).toBe(false);
    expect(bridge.getWindowFullscreenState).toHaveBeenCalledTimes(1);

    emit(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(true);
    expect(bridge.getWindowFullscreenState).toHaveBeenCalledTimes(1);
    stop();
  });

  it("shares one bridge subscription and releases it with the last listener", () => {
    const { bridge, unsubscribe, emit } = makeBridge(false);
    const store = createDesktopFullscreenStore(() => bridge);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = store.subscribe(first);
    const stopSecond = store.subscribe(second);
    expect(bridge.onWindowFullscreenStateChange).toHaveBeenCalledTimes(1);

    emit(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    expect(unsubscribe).not.toHaveBeenCalled();
    stopSecond();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    // Unsubscribed, the cached value could go stale, so the bridge is read again.
    bridge.getWindowFullscreenState.mockReturnValue(false);
    expect(store.getSnapshot()).toBe(false);
  });

  it("does not reuse state across replaced bridges", () => {
    const original = makeBridge(true);
    const replacement = makeBridge(false);
    let current: ReturnType<typeof makeBridge>["bridge"] | undefined = original.bridge;
    const store = createDesktopFullscreenStore(() => current);
    const stop = store.subscribe(() => {});
    expect(store.getSnapshot()).toBe(true);

    current = replacement.bridge;
    expect(store.getSnapshot()).toBe(false);
    current = undefined;
    expect(store.getSnapshot()).toBe(false);
    stop();
    expect(original.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
