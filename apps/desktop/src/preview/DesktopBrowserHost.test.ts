// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";

import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserEvent));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCdpReply = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
);
const key = { threadId: "thread-1", tabId: "tab-1" };

/** A tab's webContents and debugger, with the debugger's commands left pending until released. */
const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        pending.push(() => resolve({ method }));
      }),
  });
  const webContents = {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  };
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
      send: (method: string) => debuggee.sendCommand(method),
      operation: async () => undefined,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
  };
};

/** Reads `count` events from one backend's subscription. */
const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

describe("DesktopBrowserHost", () => {
  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);
      // A restarted backend subscribes after the attach and still hears it.
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
      expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    }),
  );

  it.effect("drops replies from a relay the server released", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      // Wait until the reader has received the announcement.
      yield* Effect.yieldNow;
      const command = (id: number, method: string) =>
        host.handleCommandLine(
          encodeJson({
            type: "cdp",
            ...key,
            message: encodeJson({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(1, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(2, "DOM.enable");
      debuggee.release();
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
      const [, reply] = yield* Fiber.join(reader);
      // Only the new connection's reply arrives; the old one's id could collide.
      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a server tab's download under its CDP guid where the server asked", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const paths: Array<string> = [];
      const item = {
        setSavePath: (path: string) => void paths.push(path),
      } as unknown as Electron.DownloadItem;
      // Before the server sets a directory, Electron keeps its own handling.
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(false);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "Browser.setDownloadBehavior",
            params: { behavior: "allowAndName", downloadPath: "/srv/downloads" },
          }),
        }),
      );
      debuggee.emit("Browser.downloadWillBegin", { guid: "guid-1", suggestedFilename: "r.csv" });
      expect(host.placeDownload(debuggee.tab.webContents, item)).toBe(true);
      expect(paths).toEqual(["/srv/downloads/guid-1"]);
    }),
  );

  it.effect("tells a download the person clicked from one the agent's input started", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      // Reading the page is not acting on it.
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({ id: 1, method: "DOM.getDocument", params: {} }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(true);
      yield* host.handleCommandLine(
        encodeJson({
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 2,
            method: "Input.dispatchMouseEvent",
            params: { type: "mousePressed", x: 1, y: 1 },
          }),
        }),
      );
      expect(host.humanStartedDownload(debuggee.tab.webContents)).toBe(false);
    }),
  );
});

it.effect.each([false, true])(
  "routes private browser operations to their tab, rejected=%s",
  (rejected) =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      const requests: unknown[] = [];
      host.attach(key, {
        ...debuggee.tab,
        operation: async (request) => {
          requests.push(request);
          if (rejected) throw new Error("Saved login belongs to another origin.");
          return { filled: true };
        },
      });
      const reader = yield* takeEvents(host, 2).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const request = { operation: "evaluate", input: { expression: "document.title" } };
      yield* host.handleCommandLine(
        encodeJson({ type: "operation", ...key, requestId: "request-1", request }),
      );
      const [, reply] = yield* Fiber.join(reader);
      expect(requests).toEqual([request]);
      expect(reply).toEqual({
        type: "operationResult",
        ...key,
        requestId: "request-1",
        ...(rejected
          ? { error: "Saved login belongs to another origin." }
          : { result: { filled: true } }),
      });
    }).pipe(Effect.scoped),
);

it.effect("keeps identical tab IDs in different environments separate from the local backend", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make;
    const local = makeDebuggee();
    const remote = makeDebuggee();
    const other = makeDebuggee();
    host.attach(key, local.tab);
    host.attach({ ...key, environmentId: "fred" }, remote.tab);
    host.attach({ ...key, environmentId: "other" }, other.tab);
    expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
    const reader = yield* host.remoteEvents.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* host.connectRemote("fred");
    yield* host.remoteCommand("fred", {
      type: "cdp",
      ...key,
      message: encodeJson({ id: 1, method: "Browser.getVersion" }),
    });
    const events = yield* Fiber.join(reader);
    expect(events.map((event) => event.environmentId)).toEqual(["fred", "fred"]);
    expect(events[0]?.event.type).toBe("attached");
    expect(events[1]?.event.type).toBe("cdp");
    host.detach({ ...key, environmentId: "fred" });
    expect(yield* takeEvents(host, 1)).toEqual([{ type: "attached", ...key }]);
  }).pipe(Effect.scoped),
);

it.effect("stores remote downloads locally and only transfers registered files", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make;
    const debuggee = makeDebuggee();
    const remoteKey = { ...key, environmentId: "fred" };
    host.attach(remoteKey, debuggee.tab);
    yield* host.remoteCommand("fred", {
      type: "cdp",
      ...key,
      message: encodeJson({
        id: 1,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/does-not-exist-on-mac" },
      }),
    });
    debuggee.emit("Browser.downloadWillBegin", { guid: "download-1" });
    let savedPath = "";
    expect(
      host.placeDownload(debuggee.tab.webContents, {
        setSavePath: (path: string) => {
          savedPath = path;
        },
      } as Electron.DownloadItem),
    ).toBe(true);
    expect(savedPath).not.toContain("does-not-exist-on-mac");
    yield* Effect.promise(() => NodeFSP.writeFile(savedPath, "download content"));
    const transfer = (guid: string) =>
      Effect.gen(function* () {
        const reply = yield* host.remoteEvents.pipe(
          Stream.filter((event) => event.event.type === "operationResult"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* host.remoteCommand("fred", {
          type: "operation",
          ...key,
          requestId: "read",
          request: { operation: "readDownload", guid, offset: 0 },
        });
        return (yield* Fiber.join(reply))[0]!.event;
      });
    const denied = yield* transfer("../../secrets");
    expect(denied).toMatchObject({
      type: "operationResult",
      error: "Unknown browser download or invalid offset.",
    });
    const result = yield* transfer("download-1");
    expect(result).toMatchObject({
      type: "operationResult",
      result: { data: Buffer.from("download content").toString("base64"), done: true },
    });
    expect(
      yield* Effect.promise(() =>
        NodeFSP.stat(savedPath).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    host.detach(remoteKey);
  }).pipe(Effect.scoped),
);
