// @effect-diagnostics nodeBuiltinImport:off - Stands in for an Electron debugger.
import { describe, expect, it } from "@effect/vitest";
import { DesktopBrowserEvent, type DesktopBrowserPrivateOperation } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
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
/** Sends a page command whose id the fake debugger records as it receives it. */
const command = (
  host: DesktopBrowserHost.DesktopBrowserHost["Service"],
  id: number,
  method: string,
) =>
  host.handleCommandLine(
    encodeJson({
      type: "cdp",
      ...key,
      message: encodeJson({ id, method, params: { id }, sessionId: "t3-preview-page" }),
    }),
  );

const makeDebuggee = () => {
  const emitter = new NodeEvents.EventEmitter();
  const pending: Array<() => void> = [];
  const sent: Array<unknown> = [];
  const sendWaiters: Array<() => void> = [];
  const debuggee = Object.assign(emitter, {
    sendCommand: (method: string, params?: Record<string, unknown>) =>
      new Promise((resolve) => {
        if (method === "Target.getTargetInfo") {
          resolve({ targetInfo: { targetId: "GUEST" } });
          return;
        }
        sent.push(params?.id);
        pending.push(() => resolve({ method }));
        sendWaiters.shift()?.();
      }),
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    getURL: () => "http://localhost/",
    getTitle: () => "Page",
    getUserAgent: () => "Electron",
  });
  return {
    tab: {
      webContents: webContents as unknown as Electron.WebContents,
      debugger: debuggee as unknown as Electron.Debugger,
      send: (method: string, params: Record<string, unknown>) =>
        debuggee.sendCommand(method, params),
      operation: async () => undefined,
    },
    emit: (method: string, params: unknown) => emitter.emit("message", {}, method, params, ""),
    navigate: () => webContents.emit("did-navigate"),
    /** Ids of the commands the debugger received, in order. */
    sent,
    nextSend: () => new Promise<void>((resolve) => sendWaiters.push(resolve)),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    releaseFirst: () => pending.shift()?.(),
  };
};

const takeEvents = (host: DesktopBrowserHost.DesktopBrowserHost["Service"], count: number) =>
  host.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => decodeEvent(new TextDecoder().decode(line)))),
  );

/**
 * Ids of the replies the host sends, in order. A screenshot's reply leaves after its turn
 * has passed on, so by then the next waiting screenshot, if any, has been sent. Subscribe
 * before sending commands: a new subscriber releases the tab's relay.
 */
const watchReplies = (host: DesktopBrowserHost.DesktopBrowserHost["Service"]) =>
  Effect.gen(function* () {
    const replies = yield* Queue.unbounded<number>();
    yield* host.events.pipe(
      Stream.map((line) => decodeEvent(new TextDecoder().decode(line))),
      Stream.runForEach((event) =>
        event.type === "cdp" ? Queue.offer(replies, decodeCdpReply(event.message).id) : Effect.void,
      ),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    return replies;
  });

describe("DesktopBrowserHost", () => {
  it.effect("releases viewer painting on local release and remote disconnect", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const remoteKey = { ...key, environmentId: "remote-environment" };
      host.attach(key, makeDebuggee().tab);
      host.attach(remoteKey, makeDebuggee().tab);
      const requests = yield* host.frameRequests.pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const message = encodeJson({
        id: 1,
        method: "Page.startScreencast",
        sessionId: "t3-preview-page",
      });
      yield* host.handleCommandLine(encodeJson({ type: "cdp", ...key, message }));
      yield* host.remoteCommand(remoteKey.environmentId, { type: "cdp", ...key, message });
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* host.disconnectRemote(remoteKey.environmentId);
      expect(yield* Fiber.join(requests)).toEqual([
        { ...key, active: true },
        { ...remoteKey, active: true },
        { ...key, active: false },
        { ...remoteKey, active: false },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("requests frames for hidden captures on local and remote hosts", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const remoteKey = { ...key, environmentId: "remote-environment" };
      host.attach(key, makeDebuggee().tab);
      host.attach(remoteKey, makeDebuggee().tab);
      const requests = yield* host.frameRequests.pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const message = (method: string) =>
        encodeJson({ id: 1, method, sessionId: "t3-preview-page" });
      yield* host.handleCommandLine(
        encodeJson({ type: "cdp", ...key, message: message("DOM.getDocument") }),
      );
      yield* host.handleCommandLine(
        encodeJson({ type: "cdp", ...key, message: message("Page.captureScreenshot") }),
      );
      yield* host.remoteCommand(remoteKey.environmentId, {
        type: "cdp",
        ...key,
        message: message("Page.captureScreenshot"),
      });
      expect(yield* Fiber.join(requests)).toEqual([
        key,
        { ...key, active: true },
        remoteKey,
        { ...remoteKey, active: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("announces tabs already attached to a backend that starts later", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      host.attach(key, makeDebuggee().tab);

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
      const [, reply] = yield* Fiber.join(reader);

      expect(reply).toMatchObject({ type: "cdp" });
      expect(decodeCdpReply((reply as { message: string }).message).id).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect("sends a page one screenshot at a time", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "DOM.enable");
      expect(debuggee.sent).toEqual([1, 3]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 3, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("stops waiting on a screenshot the page navigated away from", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);
      const replies = yield* watchReplies(host);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* command(host, 3, "Page.captureScreenshot");
      debuggee.navigate();
      expect(debuggee.sent).toEqual([1, 2]);

      // The superseded screenshot answering late must not start a third beside the second.
      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(1);
      expect(debuggee.sent).toEqual([1, 2]);

      debuggee.releaseFirst();
      expect(yield* Queue.take(replies)).toBe(2);
      expect(debuggee.sent).toEqual([1, 2, 3]);
    }).pipe(Effect.scoped),
  );

  it.effect("drops screenshots a released relay left waiting", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.make;
      const debuggee = makeDebuggee();
      host.attach(key, debuggee.tab);

      yield* command(host, 1, "Page.captureScreenshot");
      yield* command(host, 2, "Page.captureScreenshot");
      yield* host.handleCommandLine(encodeJson({ type: "release", ...key }));
      yield* command(host, 3, "Page.captureScreenshot");
      expect(debuggee.sent).toEqual([1]);

      const sent = debuggee.nextSend();
      debuggee.release();
      yield* Effect.promise(() => sent);
      expect(debuggee.sent).toEqual([1, 3]);
    }),
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

it.effect("selects transferred remote files through CDP and isolates uploads by environment", () =>
  Effect.gen(function* () {
    const host = yield* DesktopBrowserHost.make;
    const received: Array<Record<string, unknown>> = [];
    const remoteKey = { ...key, environmentId: "remote-upload-host" };
    const debuggee = makeDebuggee();
    host.attach(remoteKey, {
      ...debuggee.tab,
      send: async (_method, params) => {
        received.push(params);
        return {};
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => host.detach(remoteKey)));
    const operation = (request: DesktopBrowserPrivateOperation) =>
      Effect.gen(function* () {
        const reader = yield* host.remoteEvents.pipe(
          Stream.filter((entry) => entry.event.type === "operationResult"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* host.remoteCommand(remoteKey.environmentId, {
          type: "operation",
          ...key,
          requestId: "upload",
          request,
        });
        return (yield* Fiber.join(reader))[0]!.event;
      });
    const select = (environmentId: string, files: string[]) =>
      Effect.gen(function* () {
        const reader = yield* host.remoteEvents.pipe(
          Stream.filter((entry) => entry.event.type === "cdp"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* host.remoteCommand(environmentId, {
          type: "cdp",
          ...key,
          message: encodeJson({
            id: 1,
            method: "DOM.setFileInputFiles",
            params: { files, backendNodeId: 7 },
            sessionId: "t3-preview-page",
          }),
        });
        const event = (yield* Fiber.join(reader))[0]!.event;
        if (event.type !== "cdp") throw new Error("Expected CDP reply");
        return JSON.parse(event.message);
      });
    const sourcePath = "/remote/TRAIND.aab";
    expect(
      yield* operation({
        operation: "stageUpload",
        id: "bundle",
        sourcePath,
        name: "TRAIND.aab",
        sizeBytes: 6,
        offset: 0,
        data: "YWJj",
        done: false,
      }),
    ).toMatchObject({ result: { writtenBytes: 3 } });
    expect(yield* select(remoteKey.environmentId, [sourcePath])).toHaveProperty("error");
    expect(received).toEqual([]);
    expect(
      yield* operation({
        operation: "stageUpload",
        id: "bundle",
        sourcePath,
        name: "TRAIND.aab",
        sizeBytes: 6,
        offset: 3,
        data: "ZGVm",
        done: true,
      }),
    ).toMatchObject({ result: { writtenBytes: 6 } });
    expect(yield* select(remoteKey.environmentId, [sourcePath])).not.toHaveProperty("error");
    const [localPath] = received[0]!.files as string[];
    expect(localPath).not.toBe(sourcePath);
    expect(yield* Effect.promise(() => NodeFSP.readFile(localPath!, "utf8"))).toBe("abcdef");
    expect(received[0]!.backendNodeId).toBe(7);
    const otherKey = { ...key, environmentId: "other-upload-host" };
    host.attach(otherKey, debuggee.tab);
    yield* Effect.addFinalizer(() => Effect.sync(() => host.detach(otherKey)));
    expect(yield* select(otherKey.environmentId, [sourcePath])).toHaveProperty("error");
    expect(yield* select(remoteKey.environmentId, [localPath!])).toHaveProperty("error");
    expect(yield* select(remoteKey.environmentId, [])).not.toHaveProperty("error");
    expect(yield* operation({ operation: "discardUpload", id: "bundle" })).not.toHaveProperty(
      "error",
    );
    expect(yield* select(remoteKey.environmentId, [sourcePath])).toHaveProperty("error");
    yield* host.disconnectRemote(remoteKey.environmentId);
  }).pipe(Effect.scoped),
);
