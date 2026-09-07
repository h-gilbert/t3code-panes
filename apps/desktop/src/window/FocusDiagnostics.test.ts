import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeEvents from "node:events";
import type { BrowserWindow } from "electron";
import * as Schema from "effect/Schema";
import {
  makeFocusDiagnostics,
  observeWindowFocus,
  RendererFocusEvidence,
} from "./FocusDiagnostics.ts";

describe("focus diagnostics", () => {
  it("accepts DOM focus evidence while stripping content and rejecting invalid payloads", () => {
    const target = { kind: "composer", pane: 0, tabId: null, text: "PRIVATE" };
    const payload = {
      event: "focusout",
      observedAt: 100,
      documentFocused: false,
      target,
      relatedTarget: { kind: "browser", pane: 1, tabId: "tab_1" },
      activeElement: target,
      lastInput: { kind: "key", at: 90, key: "PRIVATE" },
    };
    const decode = Schema.decodeUnknownSync(RendererFocusEvidence);
    expect(JSON.stringify(decode(payload))).not.toContain("PRIVATE");
    expect(() => decode({ ...payload, event: "keydown" })).toThrow();
    expect(() => decode({ ...payload, target: { ...target, tabId: "x".repeat(1025) } })).toThrow();
  });

  it("observes renderer and window focus loss after typing, then detaches on close", () => {
    const window = Object.assign(new NodeEvents.EventEmitter(), {
      webContents: new NodeEvents.EventEmitter(),
    });
    let now = 10;
    let focusedId: number | null = 7;
    const emit = vi.fn();
    const preventDefault = vi.fn();
    observeWindowFocus(
      window as unknown as BrowserWindow,
      makeFocusDiagnostics(() => now, emit),
      () => focusedId,
    );
    window.webContents.emit(
      "before-input-event",
      { preventDefault },
      { type: "keyDown", key: "PRIVATE" },
    );
    now = 20;
    focusedId = 42;
    window.webContents.emit("blur");
    expect(emit.mock.lastCall?.[0]).toMatchObject({
      event: "renderer-blur",
      focusedWebContentsId: 42,
      lastHumanInput: { kind: "key", ageMs: 10 },
    });
    focusedId = null;
    window.emit("blur");
    expect(emit.mock.lastCall?.[0]).toMatchObject({
      event: "window-blur",
      focusedWebContentsId: null,
    });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE");
    expect(preventDefault).not.toHaveBeenCalled();
    window.emit("closed");
    expect(window.eventNames()).toEqual([]);
    expect(window.webContents.eventNames()).toEqual([]);
  });

  it("retains completed automation for a delayed focus event and snapshots event-time evidence", () => {
    let now = 100;
    const emit = vi.fn();
    const diagnostics = makeFocusDiagnostics(() => now, emit);
    const finish = diagnostics.startAction({ id: "action-1", name: "type", webContentsId: 42 });
    now = 110;
    finish();
    now = 140;
    diagnostics.record("guest-focus", { focusedWebContentsId: 42 });
    expect(emit.mock.lastCall?.[0]).toMatchObject({
      event: "guest-focus",
      observedAt: 140,
      focusedWebContentsId: 42,
      lastAction: {
        id: "action-1",
        name: "type",
        webContentsId: 42,
        startedAt: 100,
        completedAt: 110,
        ageMs: 30,
      },
    });
    expect(emit.mock.calls[0]?.[0].lastAction.completedAt).toBeNull();
  });

  it("records typing before window blur without logging individual keystrokes", () => {
    let now = 100;
    const emit = vi.fn();
    const diagnostics = makeFocusDiagnostics(() => now, emit);
    for (let i = 0; i < 100; i++) diagnostics.humanInput("key");
    expect(emit).not.toHaveBeenCalled();
    now = 150;
    diagnostics.record("window-blur");
    expect(emit.mock.lastCall?.[0]).toEqual({
      event: "window-blur",
      observedAt: 150,
      lastHumanInput: { kind: "key", at: 100, ageMs: 50 },
      lastAction: null,
    });
    now = 160;
    diagnostics.humanInput("pointer");
    diagnostics.record("renderer-blur");
    expect(emit.mock.lastCall?.[0].lastHumanInput).toEqual({ kind: "pointer", at: 160, ageMs: 0 });
  });

  it("does not attribute an older completion to a newer action or another tab", () => {
    const emit = vi.fn();
    const diagnostics = makeFocusDiagnostics(() => 100, emit);
    const otherTab = makeFocusDiagnostics(() => 100, emit);
    const finishOlder = diagnostics.startAction({ id: "old", name: "click", webContentsId: 42 });
    diagnostics.startAction({ id: "new", name: "type", webContentsId: 42 });
    finishOlder();
    diagnostics.record("guest-focus");
    expect(emit.mock.lastCall?.[0].lastAction).toMatchObject({ id: "new", completedAt: null });
    otherTab.record("guest-focus");
    expect(emit.mock.lastCall?.[0].lastAction).toBeNull();
  });
});
