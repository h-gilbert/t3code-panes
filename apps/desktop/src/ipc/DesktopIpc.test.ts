import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { registerCaptureRenderer, registerWorkspaceWindow } from "../window/workspaceWindows.ts";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as DesktopIpc from "./DesktopIpc.ts";

vi.mock("electron", () => ({}));

const trustSender = () => Effect.succeed(true);

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("passes the sending renderer to sync handlers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
        const ipc = DesktopIpc.make(
          makeIpcMain({
            on: (_channel, registeredListener) => {
              listener = registeredListener;
            },
          }),
          trustSender,
        );
        const sender = {} as Electron.WebContents;
        let receivedSender: Electron.WebContents | undefined;

        yield* ipc.handleSync({
          channel: "desktop.test.sender",
          handler: (event) =>
            Effect.sync(() => {
              receivedSender = event.sender;
              return true;
            }),
        });
        assert.isDefined(listener);
        const event = { returnValue: undefined, sender };
        listener(event);

        assert.strictEqual(receivedSender, sender);
        assert.isTrue(event.returnValue);
      }),
    ),
  );

  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain, trustSender);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("forwards the invoke sender to the method", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
        trustSender,
      );
      const sender = { sender: { id: 7 } };
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          yield* Effect.promise(async () => listener!(sender, undefined));
        }),
      );

      assert.strictEqual(received, sender);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain, trustSender);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );
});
it.effect("accepts top frames of app renderers and rejects preview guests and subframes", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame },
              } as unknown as Electron.BrowserWindow),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const register = (
      id: number,
      mainFrame: object,
      registerWindow: typeof registerWorkspaceWindow,
    ) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const window = {
            webContents: { id, mainFrame },
            isDestroyed: () => false,
            once: (_event: string, listener: () => void) => listener,
          };
          const closed = vi.spyOn(window, "once");
          registerWindow(window as unknown as Electron.BrowserWindow);
          return () => closed.mock.calls[0]?.[1]();
        }),
        (close) => Effect.sync(close),
      );

    const workspaceFrame = {};
    const captureFrame = {};
    yield* register(3, workspaceFrame, registerWorkspaceWindow);
    yield* register(4, captureFrame, registerCaptureRenderer);

    const senders = {
      workspace: { sender: { id: 3 }, senderFrame: workspaceFrame },
      capture: { sender: { id: 4 }, senderFrame: captureFrame },
      captureSubframe: { sender: { id: 4 }, senderFrame: {} },
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = {
        ...sender,
        sender: sender.sender as Electron.WebContents,
        returnValue: "unset" as unknown,
      };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      workspace: ["secret", "secret"],
      capture: ["secret", "secret"],
      captureSubframe: ["rejected", undefined],
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }),
);
