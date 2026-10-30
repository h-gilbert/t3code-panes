import * as NodeVM from "node:vm";
import { it as effectIt } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type {
  DesktopPreviewRecordingInputEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import * as Cause from "effect/Cause";
import * as BrowserCredentials from "./BrowserCredentials.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as DesktopBrowserHost from "./DesktopBrowserHost.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewPasskeys from "./Passkeys.ts";

describe("fitPictureInPictureContentSize", () => {
  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

describe("isPreviewEditingShortcut", () => {
  const input = (platform: NodeJS.Platform, key: string, overrides: Partial<Electron.Input> = {}) =>
    ({
      type: "keyDown",
      key,
      meta: platform === "darwin",
      control: platform !== "darwin",
      shift: false,
      alt: false,
      ...overrides,
    }) as Electron.Input;

  it("recognizes macOS Paste and Match Style when Option changes the key to a symbol", () => {
    const pasteAndMatchStyle = input("darwin", "◊", { code: "KeyV", alt: true, shift: true });
    expect(PreviewManager.isPreviewEditingShortcut(pasteAndMatchStyle, "darwin")).toBe(true);
    for (const modifiers of [
      { code: "KeyC" },
      { alt: false },
      { shift: false },
      { control: true },
    ]) {
      expect(
        PreviewManager.isPreviewEditingShortcut({ ...pasteAndMatchStyle, ...modifiers }, "darwin"),
      ).toBe(false);
    }
  });
});

describe("previewWindowOpenAction", () => {
  const details = (overrides: {
    readonly url?: string;
    readonly disposition?: Electron.HandlerDetails["disposition"];
  }) => ({
    url: "https://accounts.google.com/o/oauth2/auth",
    disposition: "new-window" as Electron.HandlerDetails["disposition"],
    ...overrides,
  });

  it("opens a real window for scripted popups so the opener survives", () => {
    expect(PreviewManager.previewWindowOpenAction(details({}))).toBe("popup");
    expect(
      PreviewManager.previewWindowOpenAction(details({ url: "http://localhost:5173/auth" })),
    ).toBe("popup");
  });

  it("keeps a form POST with a body on the in-place path", () => {
    const postBody = { data: [], contentType: "application/x-www-form-urlencoded" };
    expect(
      PreviewManager.previewWindowOpenAction({
        ...details({ disposition: "foreground-tab" }),
        postBody,
      }),
    ).toBe("navigate");
  });

  it("does not hand a window to schemes that cannot be hardened", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "vscode://vscode-remote/ssh-remote+box/tmp",
      "not a url",
    ]) {
      expect(PreviewManager.previewWindowOpenAction(details({ url }))).toBe("navigate");
    }
  });

  it("denies a blank window instead of blanking the opener", () => {
    for (const url of ["about:blank", ""]) {
      for (const disposition of ["new-window", "foreground-tab"] as const) {
        expect(PreviewManager.previewWindowOpenAction(details({ url, disposition }))).toBe("deny");
      }
    }
  });
});

const {
  browserWindowConstructor,
  browserWindowFromWebContents,
  clipboardItemConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  menuBuildFromTemplate,
  menuPopup,
  readFile,
  previewSession,
  showItemInFolder,
  showOpenDialog,
  webviewSend,
  writeFile,
  writeClipboard,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  browserWindowFromWebContents: vi.fn(() => null),
  clipboardItemConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean; readonly toPNG: () => Buffer } => ({
    isEmpty: () => false,
    toPNG: () => Buffer.from("png"),
  })),
  fromId: vi.fn<(_id?: number) => Electron.WebContents | null>((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  menuBuildFromTemplate: vi.fn(),
  menuPopup: vi.fn(),
  readFile: vi.fn((_path: string) => new Uint8Array()),
  previewSession: { on: vi.fn() },
  showItemInFolder: vi.fn(),
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as Array<string> })),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeClipboard: vi.fn(async () => undefined),
}));

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: menuBuildFromTemplate },
  BrowserWindow: Object.assign(browserWindowConstructor, {
    fromWebContents: browserWindowFromWebContents,
  }),
  // oxlint-disable-next-line typescript/no-extraneous-class -- This constructor-only mock implements the browser ClipboardItem API.
  ClipboardItem: class {
    constructor(data: Record<string, unknown>) {
      clipboardItemConstructor(data);
    }
  },
  clipboard: {
    write: writeClipboard,
  },
  dialog: { showOpenDialog },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const layerBrowserSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.succeed(previewSession as unknown as Electron.Session),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const layerEnvironment = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
    dirname: "/tmp/t3/desktop",
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
    },
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const layerFileSystem = FileSystem.layerNoop({
  remove: () => Effect.void,
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
  readFile: (path) => Effect.sync(() => readFile(path)),
});

// Manager only forwards to the credential store; its own behaviour is
// covered in BrowserCredentials.test.ts.
const browserCredentialsLayer = Layer.mock(BrowserCredentials.BrowserCredentials)({
  list: Effect.succeed([]),
  save: () => Effect.die("unused in Manager tests"),
  delete: () => Effect.void,
  resolveForFill: () => Effect.succeed({ reason: "no-credential" as const }),
});

const makeLayer = (
  credentialsLayer: Layer.Layer<BrowserCredentials.BrowserCredentials> = browserCredentialsLayer,
  platform: NodeJS.Platform = "darwin",
) =>
  PreviewManager.layer.pipe(
    Layer.provideMerge(credentialsLayer),
    Layer.provideMerge(
      Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
        register: () => Effect.void,
        recordMetrics: () => Effect.void,
        shutdown: Effect.void,
      }),
    ),
    Layer.provideMerge(DesktopBrowserHost.layer),
    Layer.provideMerge(layerBrowserSession),
    Layer.provideMerge(
      Layer.mock(PreviewPasskeys.PreviewPasskeys)({
        bridgeEnabled: false,
        installSessionHandlers: () => {},
        attachGuest: () => () => {},
      }),
    ),
    Layer.provideMerge(layerEnvironment),
    Layer.provideMerge(layerFileSystem),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, platform)),
  );

const layer = makeLayer();
const managerLayer = (platform: NodeJS.Platform = "darwin") =>
  makeLayer(browserCredentialsLayer, platform);
const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
  layerOrPlatform: typeof layer | NodeJS.Platform = layer,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(
    Effect.provide(
      typeof layerOrPlatform === "string" ? managerLayer(layerOrPlatform) : layerOrPlatform,
    ),
    Effect.scoped,
  );

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly toBitmap?: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

type TestDisplayMediaHandler = (
  request: { readonly frame: { readonly frameTreeNodeId: number } | null },
  callback: (streams: { video?: unknown }) => void,
) => void;

interface TestHostWebContents {
  readonly id: number;
  readonly mainFrame: { readonly frameTreeNodeId: number };
  readonly executeJavaScript: ReturnType<typeof vi.fn>;
  readonly isDestroyed: () => boolean;
  readonly session: {
    readonly setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly displayMediaHandler: () => TestDisplayMediaHandler | undefined;
}

type TestPreviewWebContents = Electron.WebContents & {
  readonly setBackgroundThrottling: ReturnType<typeof vi.fn<(enabled: boolean) => void>>;
};

const makeTestHostWebContents = (): TestHostWebContents => {
  let handler: TestDisplayMediaHandler | undefined;
  return {
    id: 7,
    mainFrame: { frameTreeNodeId: 7 },
    executeJavaScript: vi.fn(async () => true),
    isDestroyed: () => false,
    session: {
      setDisplayMediaRequestHandler: vi.fn((next: TestDisplayMediaHandler) => {
        handler = next;
      }),
    },
    displayMediaHandler: () => handler,
  };
};

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id = 42,
  hostWebContents: TestHostWebContents = makeTestHostWebContents(),
) => {
  const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
  return {
    id,
    mainFrame: { routingId: id },
    hostWebContents,
    executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoadingMainFrame: () => false,
    isLoading: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    setBackgroundThrottling,
    isCurrentlyAudible: () => false,
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    session: { on: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  } as unknown as TestPreviewWebContents;
};

const setupServerStream = Effect.fn("test.setupServerStream")(function* () {
  const manager = yield* PreviewManager.PreviewManager;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const frames = yield* Queue.unbounded<boolean | undefined>();
  yield* manager.subscribeFrameRequests((_tabId, active) =>
    Queue.offer(frames, active).pipe(Effect.asVoid),
  );
  const replies = yield* Queue.unbounded<string>();
  const attached = yield* Deferred.make<void>();
  yield* browserHost.remoteEvents.pipe(
    Stream.runForEach(({ event }) =>
      event.type === "cdp"
        ? Queue.offer(replies, event.message)
        : event.type === "attached"
          ? Deferred.succeed(attached, undefined)
          : Effect.void,
    ),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  const capturePage = vi.fn(async () => ({
    toJPEG: () => Buffer.from("recording-frame"),
    getSize: () => ({ width: 1280, height: 720 }),
  }));
  const host = makeTestHostWebContents();
  const guest = Object.assign(makeTestPreviewWebContents(capturePage, 42, host), {
    isDevToolsOpened: () => false,
    getUserAgent: () => "Electron",
  });
  fromId.mockReturnValue(guest);
  const key = { environmentId: "remote", threadId: "thread", tabId: "server-tab" };
  yield* manager.createTab("stream-tab", { serverTab: key });
  yield* manager.registerWebview("stream-tab", 42);
  yield* Deferred.await(attached);
  const windowThrottling = vi.fn();
  yield* manager.addHostWindow({
    isDestroyed: () => false,
    once: vi.fn(),
    webContents: { id: host.id, setBackgroundThrottling: windowThrottling },
  } as never);
  yield* Effect.yieldNow;
  let sequence = 0;
  const command = Effect.fn("test.serverStreamCommand")(function* (
    method: string,
    sessionId = "t3-preview-page",
  ) {
    yield* browserHost.remoteCommand(key.environmentId, {
      type: "cdp",
      ...key,
      message: JSON.stringify({ id: ++sequence, method, sessionId }),
    });
    yield* Queue.take(replies);
  });
  return { manager, browserHost, key, guest, host, windowThrottling, capturePage, command, frames };
});

const setupRecordingRaceTabs = (manager: PreviewManager.PreviewManager["Service"]) =>
  Effect.gen(function* () {
    const capturePage = vi.fn(async () => ({
      toJPEG: () => Buffer.from("unused-recording-frame"),
      getSize: () => ({ width: 1280, height: 720 }),
    }));
    const host = makeTestHostWebContents();
    const destroyedIds = new Set<number>();
    const makeWebContents = (id: number) =>
      Object.assign(makeTestPreviewWebContents(capturePage, id, host), {
        executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        isDestroyed: () => destroyedIds.has(id),
      });
    const webContentsById = new Map([
      [41, makeWebContents(41)],
      [42, makeWebContents(42)],
    ]);
    fromId.mockImplementation((id) =>
      id === undefined ? null : (webContentsById.get(id) ?? null),
    );
    yield* manager.createTab("tab_race_a");
    yield* manager.createTab("tab_race_b");
    yield* manager.registerWebview("tab_race_a", 41);
    yield* manager.registerWebview("tab_race_b", 42);
    const grants: Array<{ video?: unknown }> = [];
    return {
      host,
      grants,
      destroy: (id: number) => destroyedIds.add(id),
      takeGrant: (frame = host.mainFrame) =>
        host.displayMediaHandler()?.({ frame }, (value) => {
          grants.push(value);
        }),
    };
  });

const TEST_FAVICON = "data:image/png;base64,cG5n";

const makeSourcePng = (width = 1, height = 1): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const makeFaviconWebContents = (options?: {
  readonly changes?: ChangeSignal;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly id?: number;
  readonly rasterize?: (code: string) => Promise<unknown>;
  readonly url?: string;
}) => {
  const sourcePng = makeSourcePng();
  const listeners = new Map<string, (...args: never[]) => void>();
  let currentUrl = options?.url ?? "http://localhost:3200/";
  let destroyed = false;
  let loading = false;
  const fetchImpl =
    options?.fetch ??
    (async () =>
      new Response(new Uint8Array(sourcePng), {
        headers: { "content-type": "image/png" },
      }));
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    const response = fetchImpl(url, init);
    options?.changes?.notify();
    return response;
  });
  const executeJavaScriptInIsolatedWorld = vi.fn(
    (_worldId: number, scripts: ReadonlyArray<{ readonly code: string }>) => {
      const result = options?.rasterize
        ? options.rasterize(scripts[0]?.code ?? "")
        : Promise.resolve(TEST_FAVICON);
      options?.changes?.notify();
      return result;
    },
  );
  const reload = vi.fn();
  const loadURL = vi.fn(async (url: string) => {
    currentUrl = url;
  });
  const off = vi.fn();
  const debuggerOff = vi.fn();
  const webContents = {
    id: options?.id ?? 42,
    isDestroyed: () => destroyed,
    getType: () => "webview",
    getURL: () => currentUrl,
    getTitle: () => "Preview",
    isLoadingMainFrame: () => loading,
    isDevToolsOpened: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    setAudioMuted: vi.fn(),
    isCurrentlyAudible: () => false,
    reload,
    reloadIgnoringCache: vi.fn(),
    loadURL,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    }),
    off,
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    session: { fetch, on: vi.fn() },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    isFocused: vi.fn(() => true),
    focusedFrame: {} as object | null,
    setIgnoreMenuShortcuts: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    executeJavaScriptInIsolatedWorld,
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: debuggerOff,
    },
  };
  return {
    executeJavaScriptInIsolatedWorld,
    fetch,
    debuggerOff,
    listeners,
    loadURL,
    off,
    reload,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
    setLoading: (value: boolean) => {
      loading = value;
    },
    setUrl: (url: string) => {
      currentUrl = url;
    },
    webContents: webContents as never,
  };
};

// Electron mocks and state subscribers call `notify`, so a wait re-checks its
// predicate exactly when the state it reads changes.
const makeChangeSignal = () => {
  const waiters = new Set<() => void>();
  return {
    notify: () => {
      for (const wake of waiters) wake();
    },
    until: (predicate: () => boolean) =>
      Effect.callback<void>((resume) => {
        if (predicate()) return resume(Effect.void);
        const wake = () => {
          if (!predicate()) return;
          waiters.delete(wake);
          resume(Effect.void);
        };
        waiters.add(wake);
        return Effect.sync(() => void waiters.delete(wake));
      }),
  };
};
type ChangeSignal = ReturnType<typeof makeChangeSignal>;

// Favicon captures run detached from the Electron listener, so asserting that
// one published nothing can only give its promise chain a fixed number of turns.
const flushMicrotasks = function* () {
  for (let turn = 0; turn < 30; turn++) yield* Effect.promise(() => Promise.resolve());
};

const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
  const listeners = new Map<string, () => void>();
  const webContentsListeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const webContents = {
    on: vi.fn((event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    }),
    off: vi.fn((event: string) => {
      webContentsListeners.delete(event);
    }),
    send,
  };
  const pictureInPictureWindow = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    loadURL: vi.fn(loadURL),
    showInactive: vi.fn(() => {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
    }),
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
    }),
    get webContents() {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
      return webContents;
    },
  };
  return { pictureInPictureWindow, send, webContentsListeners };
};

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    browserWindowFromWebContents.mockReset();
    browserWindowFromWebContents.mockReturnValue(null);
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    previewSession.on.mockClear();
    writeFile.mockClear();
    readFile.mockClear();
    showOpenDialog.mockClear();
    showItemInFolder.mockClear();
    clipboardItemConstructor.mockClear();
    writeClipboard.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
    menuPopup.mockReset();
    menuBuildFromTemplate.mockReset();
    menuBuildFromTemplate.mockReturnValue({ popup: menuPopup });
  });

  effectIt.effect("opens a target=_blank link as a new tab without navigating the opener", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const opened: Array<{ tabId: string; url: string; background: boolean }> = [];
        const linksOpened = yield* Deferred.make<void>();
        yield* manager.subscribeOpenLinks((event) =>
          Effect.gen(function* () {
            opened.push(event);
            if (opened.length === 2) yield* Deferred.succeed(linksOpened, undefined);
          }),
        );
        yield* manager.createTab("tab_links");
        yield* manager.registerWebview("tab_links", 42);
        const openHandler = (preview.webContents as Electron.WebContents).setWindowOpenHandler as
          | ReturnType<typeof vi.fn>
          | undefined;
        const handler = openHandler?.mock.lastCall?.[0] as (
          details: Partial<Electron.HandlerDetails>,
        ) => { action: string };

        expect(
          handler({ url: "https://github.com/issues/1", disposition: "foreground-tab" }),
        ).toEqual({ action: "deny" });
        expect(handler({ url: "about:blank", disposition: "new-window" })).toEqual({
          action: "deny",
        });
        handler({ url: "https://github.com/issues/2", disposition: "background-tab" });
        yield* Deferred.await(linksOpened);

        expect(preview.loadURL).not.toHaveBeenCalled();
        expect(opened).toEqual([
          { tabId: "tab_links", url: "https://github.com/issues/1", background: false },
          { tabId: "tab_links", url: "https://github.com/issues/2", background: true },
        ]);
      }),
    ),
  );

  effectIt.effect("keeps preview shortcuts out of the host window", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        const sendInputEvent = vi.fn();
        const hostWebContents = { sendInputEvent, isDestroyed: () => false };
        Object.assign(preview.webContents, { hostWebContents });
        fromId.mockReturnValue(preview.webContents);
        getFocusedWebContents.mockReturnValue(preview.webContents as never);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: hostWebContents,
        } as never);
        yield* manager.createTab("tab_keys");
        yield* manager.registerWebview("tab_keys", 42);

        expect(
          (preview.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenCalledWith(true);
        const beforeInput = preview.listeners.get("before-input-event")!;
        for (const control of [false, true]) {
          for (const key of ["k", ",", "w", "j", "q", "+"]) {
            for (const type of ["keyDown", "keyUp"]) {
              const preventDefault = vi.fn();
              beforeInput(
                { preventDefault } as never,
                { type, key, meta: !control, control, shift: key === "j", alt: false } as never,
              );
              yield* Effect.yieldNow;
              expect(preventDefault).not.toHaveBeenCalled();
              expect(
                (preview.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
              ).toHaveBeenLastCalledWith(true);
            }
          }
        }
        expect(sendInputEvent).not.toHaveBeenCalled();

        const preventDefault = vi.fn();
        beforeInput(
          { preventDefault } as never,
          {
            type: "keyDown",
            key: "r",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          } as never,
        );
        yield* Effect.yieldNow;
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(preview.reload).toHaveBeenCalledOnce();
        expect(sendInputEvent).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect.each([
    ["mod+shift+t", "view.reopenClosed"],
    ["ctrl+alt+u", "sidebar.toggle"],
  ] as const)(
    "forwards only the configured command from the focused guest: %s",
    ([chord, command]) =>
      withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents();
          const send = vi.fn();
          Object.assign(preview.webContents, {
            hostWebContents: { isDestroyed: () => false, send },
          });
          fromId.mockReturnValue(preview.webContents);
          yield* manager.createTab("tab_reopen");
          yield* manager.registerWebview("tab_reopen", 42);
          const shortcut = parseKeybindingShortcut(chord)!;
          yield* manager.setForwardedShortcuts([{ command, shortcut }]);
          const beforeInput = preview.listeners.get("before-input-event")!;
          const input = {
            type: "keyDown",
            key: shortcut.key.toUpperCase(),
            meta: shortcut.metaKey || shortcut.modKey,
            control: shortcut.ctrlKey,
            shift: shortcut.shiftKey,
            alt: shortcut.altKey,
          };
          const preventDefault = vi.fn();
          beforeInput({ preventDefault } as never, input as never);
          expect(preventDefault).toHaveBeenCalledOnce();
          expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", command);
          for (const overrides of [
            { isAutoRepeat: true },
            { type: "keyUp" },
            { shift: !input.shift },
            { key: "x" },
          ]) {
            preventDefault.mockClear();
            beforeInput({ preventDefault } as never, { ...input, ...overrides } as never);
            expect(preventDefault).toHaveBeenCalledTimes("isAutoRepeat" in overrides ? 1 : 0);
            expect(send).toHaveBeenCalledOnce();
          }
          vi.mocked((preview.webContents as Electron.WebContents).isFocused).mockReturnValue(false);
          preventDefault.mockClear();
          beforeInput({ preventDefault } as never, input as never);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(send).toHaveBeenCalledOnce();
          vi.mocked((preview.webContents as Electron.WebContents).isFocused).mockReturnValue(true);
          yield* manager.setForwardedShortcuts([]);
          beforeInput({ preventDefault } as never, input as never);
          expect(preventDefault).not.toHaveBeenCalled();
          expect(send).toHaveBeenCalledOnce();
        }),
      ),
  );

  effectIt.effect.each([
    ["linux", "ctrl+alt+[", "[", "BracketLeft", false],
    ["win32", "ctrl+alt+8", "[", "Digit8", false],
    ["win32", "ctrl+alt+k", "K", "KeyK", false],
    ["linux", "ctrl+alt+`", "Dead", "Backquote", false],
    ["darwin", "ctrl+alt+[", "[", "BracketLeft", true],
    ["linux", "ctrl+alt+f7", "F7", "F7", true],
  ] as const)(
    "handles ambiguous preview chords on %s: %s",
    ([platform, chord, key, code, expected]) =>
      withManager(
        (manager) =>
          Effect.gen(function* () {
            const preview = makeFaviconWebContents();
            const send = vi.fn();
            Object.assign(preview.webContents, {
              hostWebContents: { isDestroyed: () => false, send },
            });
            fromId.mockReturnValue(preview.webContents);
            yield* manager.createTab("tab_alt_graph");
            yield* manager.registerWebview("tab_alt_graph", 42);
            yield* manager.setForwardedShortcuts([
              { command: "view.reopenClosed", shortcut: parseKeybindingShortcut(chord)! },
            ]);
            const preventDefault = vi.fn();
            preview.listeners.get("before-input-event")!(
              { preventDefault } as never,
              {
                type: "keyDown",
                key,
                code,
                meta: false,
                control: true,
                shift: false,
                alt: true,
              } as never,
            );
            expect(preventDefault).toHaveBeenCalledTimes(expected ? 1 : 0);
            expect(send).toHaveBeenCalledTimes(expected ? 1 : 0);
          }),
        platform,
      ),
  );

  effectIt.effect("preserves focused browser editing in tabs and sign-in popups", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("tab_editing");
        yield* manager.registerWebview("tab_editing", 42);

        const popup = makeFaviconWebContents({ id: 43 });
        preview.listeners.get("did-create-window")!({ webContents: popup.webContents } as never);
        expect(
          (popup.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenCalledWith(true);

        for (const browser of [preview, popup]) {
          const contents = browser.webContents as Electron.WebContents;
          const beforeInput = browser.listeners.get("before-input-event")!;
          const preventDefault = vi.fn();
          const input = {
            type: "keyDown",
            key: "c",
            meta: true,
            control: false,
            shift: false,
            alt: false,
          };
          beforeInput({ preventDefault } as never, input as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
          // Releasing Command must not disable native fallback for the pending copy.
          beforeInput(
            { preventDefault } as never,
            { ...input, type: "keyUp", key: "Meta", meta: false } as never,
          );
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);

          beforeInput({ preventDefault } as never, { ...input, key: "w" } as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);

          // An injected copy in an unfocused guest cannot edit the active renderer.
          getFocusedWebContents.mockReturnValue(null);
          vi.mocked(contents.isFocused).mockReturnValue(false);
          beforeInput({ preventDefault } as never, input as never);
          expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
          expect(preventDefault).not.toHaveBeenCalled();
        }
      }),
    ),
  );

  for (const platform of ["darwin", "win32", "linux"] as const) {
    effectIt.effect(
      `pastes once into the guest and consumes the ${platform} shortcut before native menu routing`,
      () =>
        withManager(
          (manager) =>
            Effect.gen(function* () {
              const preview = makeFaviconWebContents();
              const pasted = yield* Deferred.make<void>();
              const paste = vi.fn(() => Deferred.doneUnsafe(pasted, Effect.void));
              fromId.mockReturnValue({
                ...(preview.webContents as Electron.WebContents),
                paste,
              } as never);
              yield* manager.createTab("tab_paste");
              yield* manager.registerWebview("tab_paste", 42);
              const beforeInput = preview.listeners.get("before-input-event")!;
              const event = { preventDefault: vi.fn() };
              beforeInput(
                event as never,
                {
                  type: "keyDown",
                  key: "v",
                  code: "KeyV",
                  meta: platform === "darwin",
                  control: platform !== "darwin",
                  alt: false,
                  shift: false,
                } as never,
              );
              expect(event.preventDefault).toHaveBeenCalledOnce();
              yield* Deferred.await(pasted);
              expect(paste).toHaveBeenCalledOnce();

              for (const overrides of [
                { type: "keyUp" },
                { meta: false, control: false },
                { meta: true, control: true },
                { shift: true },
                { alt: true },
                { isComposing: true },
                { key: "c" },
              ]) {
                const ignored = { preventDefault: vi.fn() };
                beforeInput(
                  ignored as never,
                  {
                    type: "keyDown",
                    key: "v",
                    code: "KeyV",
                    meta: platform === "darwin",
                    control: platform !== "darwin",
                    alt: false,
                    shift: false,
                    ...overrides,
                  } as never,
                );
                expect(ignored.preventDefault).not.toHaveBeenCalled();
              }
              expect(paste).toHaveBeenCalledOnce();
            }),
          makeLayer(browserCredentialsLayer, platform),
        ),
    );
  }

  effectIt.effect(
    "binds the context menu to its guest, respects edit flags and detaches on close",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents();
          const owner = { isDestroyed: () => false };
          browserWindowFromWebContents.mockReturnValue(owner as never);
          const opened = yield* Deferred.make<void>();
          menuPopup.mockImplementation(() => Deferred.doneUnsafe(opened, Effect.void));
          const pasted = yield* Deferred.make<void>();
          const paste = vi.fn(() => Deferred.doneUnsafe(pasted, Effect.void));
          fromId.mockReturnValue({
            ...(preview.webContents as Electron.WebContents),
            paste,
          } as never);
          yield* manager.createTab("tab_edit_menu");
          yield* manager.registerWebview("tab_edit_menu", 42);
          const contextMenu = preview.listeners.get("context-menu")!;
          const event = { preventDefault: vi.fn() };
          contextMenu(
            event as never,
            {
              editFlags: {
                canUndo: false,
                canRedo: false,
                canCut: false,
                canCopy: false,
                canPaste: true,
                canSelectAll: true,
              },
            } as never,
          );
          yield* Deferred.await(opened);
          expect(event.preventDefault).toHaveBeenCalledOnce();
          expect(menuPopup).toHaveBeenCalledWith({ window: owner });
          const template = menuBuildFromTemplate.mock
            .calls[0]![0] as Electron.MenuItemConstructorOptions[];
          expect(template.find((item) => item.label === "Copy")?.enabled).toBe(false);
          expect(template.find((item) => item.label === "Cut")?.enabled).toBe(false);
          const pasteItem = template.find((item) => item.label === "Paste")!;
          expect(pasteItem.enabled).toBe(true);
          expect(pasteItem.role).toBeUndefined();
          const otherPaste = vi.fn();
          getFocusedWebContents.mockReturnValue({ paste: otherPaste } as never);
          pasteItem.click!({} as never, undefined, {} as never);
          yield* Deferred.await(pasted);
          expect(paste).toHaveBeenCalledOnce();
          expect(otherPaste).not.toHaveBeenCalled();
          preview.setDestroyed(true);
          pasteItem.click!({} as never, undefined, {} as never);
          expect(paste).toHaveBeenCalledOnce();
          yield* manager.closeTab("tab_edit_menu");
          expect(preview.off).toHaveBeenCalledWith("context-menu", contextMenu);
          expect(preview.off).toHaveBeenCalledWith("before-input-event", expect.any(Function));
        }),
      ),
  );

  effectIt.effect(
    "logs delayed guest focus with its completed action and removes focus listeners",
    () => {
      let onFocusRecord: ((record: Record<string, unknown>) => void) | undefined;
      const logger = Logger.make(({ fiber }) => {
        const annotations = fiber.getRef(References.CurrentLogAnnotations);
        if (annotations.event === "guest-focus") onFocusRecord?.(annotations);
      });
      return withManager((manager) =>
        Effect.gen(function* () {
          const preview = makeFaviconWebContents();
          const keyboardTarget = Object.assign(preview.webContents, {
            mainFrame: { framesInSubtree: [{ executeJavaScript: vi.fn(async () => true) }] },
            sendInputEvent: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand: vi.fn(async () => ({ result: { subtype: "null" } })),
              on: vi.fn(),
              off: preview.debuggerOff,
            },
          });
          fromId.mockReturnValue(keyboardTarget);
          getFocusedWebContents.mockReturnValue(preview.webContents);
          const tabId = '["env","thread","epoch","tab_1"]';
          yield* manager.createTab(tabId);
          yield* manager.registerWebview(tabId, 42);
          yield* manager.automationPress(tabId, { key: "Escape" });
          const record = yield* Effect.callback<Record<string, unknown>>((resume) => {
            onFocusRecord = (value) => resume(Effect.succeed(value));
            preview.listeners.get("focus")!();
          });
          expect(record).toMatchObject({
            component: "focus-diagnostics",
            tabId,
            webContentsId: 42,
            focusedWebContentsId: 42,
            lastAction: { name: "press", webContentsId: 42, completedAt: expect.any(Number) },
          });
          yield* manager.closeTab(tabId);
          expect(preview.off).toHaveBeenCalledWith("focus", expect.any(Function));
          expect(preview.off).toHaveBeenCalledWith("blur", expect.any(Function));
        }),
      ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    },
  );

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps editing and forwarded shortcuts in whichever tab holds focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const send = vi.fn();
        const host = { isDestroyed: () => false, send };
        const older = makeFaviconWebContents({ id: 42 });
        const newer = makeFaviconWebContents({ id: 43 });
        for (const tab of [older, newer]) Object.assign(tab.webContents, { hostWebContents: host });
        getFocusedWebContents.mockReturnValue(newer.webContents as never);
        fromId.mockReturnValue(older.webContents);
        yield* manager.createTab("tab_older");
        yield* manager.registerWebview("tab_older", 42);
        fromId.mockReturnValue(newer.webContents);
        yield* manager.createTab("tab_newer");
        yield* manager.registerWebview("tab_newer", 43);
        const shortcut = parseKeybindingShortcut("mod+shift+t")!;
        yield* manager.setForwardedShortcuts([{ command: "view.reopenClosed", shortcut }]);

        const beforeInput = older.listeners.get("before-input-event")!;
        const key = { type: "keyDown", meta: true, control: false, alt: false };
        beforeInput(
          { preventDefault: vi.fn() } as never,
          { ...key, key: "c", shift: false } as never,
        );
        expect(
          (older.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(false);

        const preventDefault = vi.fn();
        beforeInput({ preventDefault } as never, { ...key, key: "T", shift: true } as never);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledExactlyOnceWith("desktop:menu-action", "view.reopenClosed");

        Object.assign(newer.webContents, { focusedFrame: null });
        const agentInput = newer.listeners.get("before-input-event")!;
        const agentPreventDefault = vi.fn();
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "c", shift: false } as never,
        );
        expect(
          (newer.webContents as Electron.WebContents).setIgnoreMenuShortcuts,
        ).toHaveBeenLastCalledWith(true);
        agentInput(
          { preventDefault: agentPreventDefault } as never,
          { ...key, key: "T", shift: true } as never,
        );
        expect(agentPreventDefault).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("rejects a destroyed webview during registration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const getType = vi.fn(() => "webview" as const);
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => true,
          getType,
        } as never);
        yield* manager.createTab("tab_destroyed_registration");

        const exit = yield* Effect.exit(manager.registerWebview("tab_destroyed_registration", 42));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewWebContentsNotFoundError",
            tabId: "tab_destroyed_registration",
            webContentsId: 42,
          });
        }
        expect(getType).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps automation available across navigation and webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstListeners = new Map<string, (...args: never[]) => void>();
        let firstUrl = "https://example.com/start";
        const first = Object.assign(makeTestPreviewWebContents(capturePage, 42), {
          getURL: () => firstUrl,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            firstListeners.set(event, listener);
          }),
        });
        const replacement = Object.assign(makeTestPreviewWebContents(capturePage, 43), {
          getURL: () => "https://example.com/after-submit",
        });
        fromId.mockImplementation((id) => (id === 42 ? first : id === 43 ? replacement : null));

        yield* manager.createTab("tab_navigation_replacement");
        yield* manager.registerWebview("tab_navigation_replacement", 42);
        firstUrl = "https://example.com/after-link";
        firstListeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_navigation_replacement")).toMatchObject({
          available: true,
          url: firstUrl,
        });

        yield* manager.registerWebview("tab_navigation_replacement", 43);
        expect(yield* manager.automationStatus("tab_navigation_replacement")).toMatchObject({
          available: true,
          url: "https://example.com/after-submit",
        });
      }),
    ),
  );

  effectIt.effect("promotes a surviving workspace window after the preview host closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const originalHostWebContents = {
          ...makeTestHostWebContents(),
          setBackgroundThrottling: vi.fn(),
        };
        const replacementHostWebContents = {
          ...makeTestHostWebContents(),
          setBackgroundThrottling: vi.fn(),
        };
        const replacementWindow = {
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: replacementHostWebContents,
        };
        const previewWebContents = Object.assign(
          makeTestPreviewWebContents(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 1280, height: 720 }),
          })),
          { hostWebContents: replacementHostWebContents },
        );
        fromId.mockReturnValue(previewWebContents as never);
        browserWindowFromWebContents.mockReturnValue(replacementWindow as never);

        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: originalHostWebContents,
        } as never);
        closeMainWindow?.();
        yield* Effect.yieldNow;

        yield* manager.createTab("tab_surviving_workspace");
        yield* manager.registerWebview("tab_surviving_workspace", 42);
        yield* manager.startRecording("tab_surviving_workspace");

        expect(browserWindowFromWebContents).toHaveBeenCalledWith(replacementHostWebContents);
        expect(replacementWindow.once).toHaveBeenCalledWith("closed", expect.any(Function));
        expect(replacementHostWebContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
        yield* manager.stopRecording("tab_surviving_workspace");
      }),
    ),
  );

  effectIt.effect("keeps a tab with its owning window until that window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeFirstWindow: (() => void) | undefined;
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstHost = { ...makeTestHostWebContents(), id: 7 };
        const secondHost = { ...makeTestHostWebContents(), id: 8 };
        const firstWindow = {
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeFirstWindow = listener;
          }),
          webContents: firstHost,
        };
        const secondWindow = { isDestroyed: () => false, once: vi.fn(), webContents: secondHost };
        const guests = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, firstHost)],
          [43, makeTestPreviewWebContents(capturePage, 43, secondHost)],
        ]);
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        browserWindowFromWebContents.mockImplementation(((host: unknown) =>
          host === firstHost ? firstWindow : secondWindow) as never);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.addHostWindow(firstWindow as never);
        yield* manager.addHostWindow(secondWindow as never);

        yield* manager.createTab("tab_owned", undefined, firstHost.id);
        yield* manager.createTab("tab_owned", undefined, secondHost.id);
        yield* manager.registerWebview("tab_owned", 42);
        const rejected = yield* Effect.exit(manager.registerWebview("tab_owned", 43));
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Option.getOrThrow(Cause.findErrorOption(rejected.cause))).toMatchObject({
            _tag: "PreviewTabHostedElsewhereError",
            hostWebContentsId: firstHost.id,
          });
        }
        // The other window dropping its interest leaves the owner's tab open.
        yield* manager.closeTab("tab_owned", secondHost.id);
        expect(states.at(-1)).toMatchObject({ webContentsId: 42, hostWebContentsId: 7 });

        closeFirstWindow?.();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(states.at(-1)).toMatchObject({ webContentsId: null, hostWebContentsId: null });

        yield* manager.registerWebview("tab_owned", 43);
        expect(states.at(-1)).toMatchObject({ webContentsId: 43, hostWebContentsId: 8 });
      }),
    ),
  );

  effectIt.effect("moves a tab to the window that claims it unless it is recording", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstHost = { ...makeTestHostWebContents(), id: 7, setBackgroundThrottling: vi.fn() };
        const secondHost = {
          ...makeTestHostWebContents(),
          id: 8,
          setBackgroundThrottling: vi.fn(),
        };
        const firstWindow = { isDestroyed: () => false, once: vi.fn(), webContents: firstHost };
        const secondWindow = { isDestroyed: () => false, once: vi.fn(), webContents: secondHost };
        const guests = new Map([
          [41, makeTestPreviewWebContents(capturePage, 41, firstHost)],
          [42, makeTestPreviewWebContents(capturePage, 42, firstHost)],
          [43, makeTestPreviewWebContents(capturePage, 43, secondHost)],
        ]);
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        browserWindowFromWebContents.mockImplementation(((host: unknown) =>
          host === firstHost ? firstWindow : secondWindow) as never);
        const states = new Map<string, PreviewManager.PreviewTabState>();
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            states.set(tabId, state);
          }),
        );
        yield* manager.addHostWindow(firstWindow as never);
        yield* manager.addHostWindow(secondWindow as never);
        yield* manager.createTab("tab_claimed", undefined, firstHost.id);
        yield* manager.registerWebview("tab_claimed", 42);

        expect(yield* manager.claimTab("tab_claimed", secondHost.id)).toBe(true);
        expect(states.get("tab_claimed")).toMatchObject({
          webContentsId: null,
          hostWebContentsId: 8,
        });
        yield* manager.registerWebview("tab_claimed", 43);
        expect(states.get("tab_claimed")).toMatchObject({
          webContentsId: 43,
          hostWebContentsId: 8,
        });

        yield* manager.createTab("tab_recording", undefined, firstHost.id);
        yield* manager.registerWebview("tab_recording", 41);
        yield* manager.startRecording("tab_recording");
        expect(yield* manager.claimTab("tab_recording", secondHost.id)).toBe(false);
        expect(states.get("tab_recording")).toMatchObject({
          webContentsId: 41,
          hostWebContentsId: 7,
        });
        yield* manager.stopRecording("tab_recording");
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("detaches a destroyed webview instead of navigating it", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_destroyed_navigation");
        yield* manager.registerWebview("tab_destroyed_navigation", 42);
        yield* manager.setColorScheme("tab_destroyed_navigation", "dark");
        preview.setDestroyed(true);

        yield* manager.navigate("tab_destroyed_navigation", "https://example.com/");

        expect(preview.loadURL).not.toHaveBeenCalled();
        expect(preview.reload).not.toHaveBeenCalled();
        expect(preview.off).toHaveBeenCalled();
        expect(preview.debuggerOff).toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: null,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    ),
  );

  effectIt.effect("attaches the server when native navigation races debugger initialization", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      const initializing = Promise.withResolvers<void>();
      const initialized = Promise.withResolvers<void>();
      const guest = Object.assign(makeTestPreviewWebContents(vi.fn()), {
        isDevToolsOpened: () => false,
        getUserAgent: () => "Electron",
        loadURL: vi.fn(async () => undefined),
      });
      vi.mocked(guest.debugger.sendCommand).mockImplementation(async (method) => {
        if (method === "Runtime.enable") {
          initializing.resolve();
          await initialized.promise;
        }
        return undefined;
      });
      fromId.mockReturnValue(guest);
      const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
      const states: PreviewManager.PreviewTabState[] = [];
      yield* manager.subscribeStateChanges((_tabId, state) =>
        Effect.sync(() => {
          states.push(state);
        }),
      );
      yield* manager.createTab("tab_server_navigation", { serverTab });
      yield* manager.registerWebview("tab_server_navigation", 42);
      yield* Effect.promise(() => initializing.promise);

      yield* manager.navigate("tab_server_navigation", "https://example.org/");
      initialized.resolve();

      expect(states.at(-1)).toMatchObject({
        serverTab,
        navStatus: { kind: "Loading", url: "https://example.org/" },
      });
      expect(JSON.parse(yield* Queue.take(lines))).toMatchObject({
        type: "attached",
        ...serverTab,
      });
      yield* manager.closeTab("tab_server_navigation");
      expect(JSON.parse(yield* Queue.take(lines))).toMatchObject({
        type: "detached",
        ...serverTab,
      });
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("detaches through the pinned debugger after the webview is destroyed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let destroyed = false;
        let attached = false;
        const debuggerOff = vi.fn();
        const debuggerDetach = vi.fn(() => {
          attached = false;
        });
        const wcDebugger = {
          isAttached: () => attached,
          attach: vi.fn(() => {
            attached = true;
          }),
          detach: debuggerDetach,
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: debuggerOff,
        };
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => destroyed,
          getType: () => "webview",
          getURL: () => "http://localhost:3200/",
          getTitle: () => "Preview",
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          reload: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          get debugger() {
            if (destroyed) throw new Error("Object has been destroyed");
            return wcDebugger;
          },
        } as never);
        yield* manager.createTab("tab_pinned_debugger");
        yield* manager.registerWebview("tab_pinned_debugger", 42);
        yield* manager.setColorScheme("tab_pinned_debugger", "dark");
        expect(attached).toBe(true);
        destroyed = true;

        yield* manager.navigate("tab_pinned_debugger", "https://example.com/");

        expect(debuggerOff).toHaveBeenCalledWith("message", expect.any(Function));
        expect(debuggerDetach).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("does not let destroyed-webview cleanup detach a same-id replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const previous = makeFaviconWebContents();
        const replacement = makeFaviconWebContents({ url: "https://example.com/" });
        let current = previous.webContents;
        let startReplacementRegistration: () => void = () => void 0;
        const replacementReady = new Promise<void>((resolve) => {
          startReplacementRegistration = resolve;
        });
        fromId.mockImplementation(() => current);
        yield* manager.createTab("tab_destroyed_replacement_race");
        yield* manager.registerWebview("tab_destroyed_replacement_race", 42);
        yield* manager.setColorScheme("tab_destroyed_replacement_race", "dark");
        const replacementRegistration = yield* Effect.promise(() => replacementReady).pipe(
          Effect.flatMap(() => manager.registerWebview("tab_destroyed_replacement_race", 42)),
          Effect.forkChild({ startImmediately: true }),
        );
        previous.setDestroyed(true);
        previous.debuggerOff.mockImplementationOnce(() => {
          current = replacement.webContents;
          startReplacementRegistration();
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.navigate("tab_destroyed_replacement_race", "https://example.com/");
        const registrationExit = yield* Fiber.await(replacementRegistration);

        expect(Exit.isSuccess(registrationExit)).toBe(true);
        expect(previous.off).toHaveBeenCalled();
        expect(replacement.off).not.toHaveBeenCalled();
        expect(states.at(-1)).toMatchObject({
          webContentsId: 42,
          navStatus: { kind: "Loading", url: "https://example.com/" },
        });
      }),
    ),
  );

  effectIt.effect("shares an identical in-flight event and lets a changed event win", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFirst!: (response: Response) => void;
        const firstResponse = new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
        const preview = makeFaviconWebContents({
          changes,
          fetch: (url) =>
            url.endsWith("first.png")
              ? firstResponse
              : Promise.resolve(
                  new Response(new Uint8Array(makeSourcePng()), {
                    headers: { "content-type": "image/png" },
                  }),
                ),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_latest");
        yield* manager.registerWebview("tab_favicon_latest", 42);

        const faviconUpdated = preview.listeners.get("page-favicon-updated")!;
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        faviconUpdated({} as never, ["http://localhost:3200/first.png"] as never);
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        faviconUpdated({} as never, ["http://localhost:3200/second.png"] as never);
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);
        resolveFirst(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(preview.fetch).toHaveBeenCalledTimes(2);
        expect(states.filter((state) => state.favicon !== undefined)).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("does not publish a capture invalidated by navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const preview = makeFaviconWebContents({
          changes,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_navigation");
        yield* manager.registerWebview("tab_favicon_navigation", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => preview.fetch.mock.calls.length === 1);
        preview.listeners.get("did-start-navigation")?.({
          isMainFrame: true,
          isSameDocument: false,
        } as never);
        preview.setUrl("https://example.com/");
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.some((state) => state.favicon !== undefined)).toBe(false);
      }),
    ),
  );

  effectIt.effect("ignores an old capture that completes after webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        let resolveFetch!: (response: Response) => void;
        const initial = makeFaviconWebContents({
          changes,
          id: 42,
          fetch: () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        });
        const replacement = makeFaviconWebContents({ changes, id: 43 });
        fromId.mockImplementation((id?: number) =>
          id === 42 ? initial.webContents : id === 43 ? replacement.webContents : null,
        );
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_late_replace");
        yield* manager.registerWebview("tab_favicon_late_replace", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => initial.fetch.mock.calls.length === 1);

        yield* manager.registerWebview("tab_favicon_late_replace", 43);
        resolveFetch(
          new Response(new Uint8Array(makeSourcePng()), {
            headers: { "content-type": "image/png" },
          }),
        );
        yield* flushMicrotasks();

        expect(states.at(-1)?.webContentsId).toBe(43);
        expect(
          states.some((state) => state.webContentsId === 43 && state.favicon !== undefined),
        ).toBe(false);
      }),
    ),
  );

  effectIt.effect("treats a reused WebContents id as a new attachment", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const changes = makeChangeSignal();
        const initial = makeFaviconWebContents({ changes, id: 42 });
        const replacement = makeFaviconWebContents({ changes, id: 42 });
        let active = initial.webContents;
        fromId.mockImplementation(() => active);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
            changes.notify();
          }),
        );
        yield* manager.createTab("tab_favicon_reused_id");
        yield* manager.registerWebview("tab_favicon_reused_id", 42);
        initial.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* changes.until(() => states.at(-1)?.favicon !== undefined);

        active = replacement.webContents;
        yield* manager.registerWebview("tab_favicon_reused_id", 42);

        expect(states.at(-1)?.favicon).toBeUndefined();
        expect(initial.off).toHaveBeenCalled();
        expect(replacement.listeners.has("page-favicon-updated")).toBe(true);
      }),
    ),
  );

  effectIt.effect("preserves a favicon when the active attachment registers again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        fromId.mockReturnValue(preview.webContents);
        const states: PreviewManager.PreviewTabState[] = [];
        const faviconPublished = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.gen(function* () {
            states.push(state);
            if (state.favicon !== undefined) yield* Deferred.succeed(faviconPublished, undefined);
          }),
        );
        yield* manager.createTab("tab_favicon_reregister");
        yield* manager.registerWebview("tab_favicon_reregister", 42);
        preview.listeners.get("page-favicon-updated")?.(
          {} as never,
          ["http://localhost:3200/favicon.png"] as never,
        );
        yield* Deferred.await(faviconPublished);

        yield* manager.registerWebview("tab_favicon_reregister", 42);

        expect(states.at(-1)?.favicon?.dataUrl).toBe(TEST_FAVICON);
      }),
    ),
  );

  // The guest reports whatever zoom level Chromium handed it from the app
  // window, so the tab's own zoom is the source of truth in both directions:
  // asserted onto every guest, never read back off one.
  effectIt.effect("keeps the tab's own zoom instead of the guest's reported zoom", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let effectiveZoom = 0.9;
        let zoomReadable = true;
        let url = "https://example.com";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => {
            if (!zoomReadable) throw new Error("zoom unavailable");
            return effectiveZoom;
          },
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_zoom");
        yield* manager.registerWebview("tab_zoom", 42);

        expect(states.at(-1)?.zoomFactor).toBe(1);
        expect(setZoomFactor).toHaveBeenCalledWith(1);

        effectiveZoom = 0.8;
        url = "https://example.com/after-app-zoom";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1);

        yield* manager.zoomIn("tab_zoom");
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);

        zoomReadable = false;
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.zoomFactor).toBe(1.1);

        const replacementSetZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: replacementSetZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.registerWebview("tab_zoom", 43);

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
      }),
    ),
  );

  // Zooming the app UI pushes the window's zoom level onto every guest, so the
  // preview has to be put back at the zoom the user gave it.
  effectIt.effect("re-applies each tab's own zoom when the app window zooms", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_reapply");
        yield* manager.registerWebview("tab_reapply", 42);
        yield* manager.zoomIn("tab_reapply");
        setZoomFactor.mockClear();

        yield* manager.reapplyZoom();

        expect(setZoomFactor).toHaveBeenCalledTimes(1);
        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
      }),
    ),
  );

  effectIt.effect("re-asserts the tab's zoom when the active guest registers again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor,
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_reregister_zoom");
        yield* manager.registerWebview("tab_reregister_zoom", 42);
        yield* manager.zoomIn("tab_reregister_zoom");
        setZoomFactor.mockClear();
        const publishedBefore = states.length;

        yield* manager.registerWebview("tab_reregister_zoom", 42);

        expect(setZoomFactor).toHaveBeenCalledWith(1.1);
        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.zoomFactor).toBe(1.1);
      }),
    ),
  );

  effectIt.effect("re-applies opaque base and color scheme across webview swaps", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const makeWebContents = (id: number) => {
          const sendCommand = vi.fn(async () => undefined);
          return {
            sendCommand,
            wc: {
              id,
              isDestroyed: () => false,
              isDevToolsOpened: () => false,
              getType: () => "webview",
              getURL: () => "https://example.com",
              getTitle: () => "Example",
              isLoadingMainFrame: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              setAudioMuted: vi.fn(),
              isCurrentlyAudible: () => false,
              on: vi.fn(),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              session: { on: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setIgnoreMenuShortcuts: vi.fn(),
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => false,
                attach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as never,
          };
        };
        const first = makeWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_scheme");
        yield* manager.registerWebview("tab_scheme", 42);
        yield* Effect.yieldNow;

        // Guests start with a transparent base; dark-scheme pages need an opaque
        // one or Chromium skips their dark canvas.
        const opaqueBase = {
          color: { r: 255, g: 255, b: 255, a: 1 },
        };
        expect(first.sendCommand).toHaveBeenCalledWith(
          "Emulation.setDefaultBackgroundColorOverride",
          opaqueBase,
        );

        yield* manager.setColorScheme("tab_scheme", "dark");

        expect(first.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        const replacement = makeWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_scheme", 43);
        yield* Effect.yieldNow;

        expect(replacement.sendCommand).toHaveBeenCalledWith(
          "Emulation.setDefaultBackgroundColorOverride",
          opaqueBase,
        );
        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        yield* manager.setColorScheme("tab_scheme", "system");

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("system");
      }),
    ),
  );

  const makeAttachingGuest = (id: number) => {
    const listeners = new Map<string, () => void>();
    const attach = vi.fn();
    const detach = vi.fn();
    const sendCommand = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    const detachListeners = new Set<() => void>();
    let chromiumDetaches = 0;
    let destroyed = false;
    const wc = {
      id,
      isDestroyed: () => destroyed,
      isDevToolsOpened: () => {
        if (destroyed) throw new TypeError("Object has been destroyed");
        return false;
      },
      getType: () => "webview",
      getURL: () => "http://localhost:5173/README.md",
      getTitle: () => "README.md",
      isLoadingMainFrame: () => true,
      isLoading: () => true,
      session: { on: vi.fn() },
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      on: vi.fn(),
      off: vi.fn(),
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      ipc: { on: vi.fn(), off: vi.fn() },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => attach.mock.calls.length > detach.mock.calls.length + chromiumDetaches,
        attach,
        detach,
        sendCommand,
        on: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.add(listener);
        },
        off: (event: string, listener: () => void) => {
          if (event === "detach") detachListeners.delete(listener);
        },
      },
    };
    /** Chromium dropping the debugger without a detach() call. */
    const chromiumDetach = () => {
      chromiumDetaches += 1;
      // Snapshot like an EventEmitter, so a listener added during emit waits for the next one.
      for (const listener of Array.from(detachListeners)) listener();
    };
    return {
      wc: wc as unknown as Electron.WebContents,
      attach,
      detach,
      sendCommand,
      chromiumDetach,
      destroy: () => {
        destroyed = true;
        listeners.get("destroyed")?.();
      },
    };
  };

  effectIt.effect("reattaches a debugger that Chromium dropped on its own", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAttachingGuest(48);
        fromId.mockReturnValue(guest.wc);
        yield* manager.createTab("tab_detached");
        yield* manager.registerWebview("tab_detached", 48);
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(1);

        guest.chromiumDetach();
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(guest.attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("skips a guest destroyed while another guest's session opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const slow = makeAttachingGuest(46);
        let releaseSlow = () => {};
        const slowCommand = new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
        slow.sendCommand.mockImplementation(() => slowCommand);
        const queued = makeAttachingGuest(47);

        const slowFiber = yield* manager
          .prepareWebview(slow.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const queuedFiber = yield* manager
          .prepareWebview(queued.wc)
          .pipe(Effect.forkChild({ startImmediately: true }));
        queued.destroy();
        releaseSlow();

        expect(Exit.isSuccess(yield* Fiber.await(slowFiber))).toBe(true);
        expect(Exit.isSuccess(yield* Fiber.await(queuedFiber))).toBe(true);
        expect(slow.attach).toHaveBeenCalledTimes(1);
        expect(queued.attach).not.toHaveBeenCalled();
      }),
    ),
  );

  const makeAudioWebContents = (id: number) => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const setAudioMuted = vi.fn();
    let audible = false;
    let audibleAfterFirstRead = false;
    let audibleReads = 0;
    return {
      setAudioMuted,
      emitAudioState: (next: boolean) => {
        audible = next;
        listeners.get("audio-state-changed")?.({ audible: next } as never);
      },
      /** Simulate playback starting during attach before the tab owns the guest and can receive its events. */
      startPlayingAfterFirstRead: () => {
        audibleAfterFirstRead = true;
      },
      wc: {
        id,
        isDestroyed: () => false,
        isDevToolsOpened: () => false,
        getType: () => "webview",
        getURL: () => "https://example.com",
        getTitle: () => "Example",
        isLoadingMainFrame: () => false,
        getZoomFactor: () => 1,
        setZoomFactor: vi.fn(),
        setAudioMuted,
        isCurrentlyAudible: () => {
          audibleReads += 1;
          if (audibleAfterFirstRead && audibleReads > 1) return true;
          return audible;
        },
        loadURL: vi.fn(async () => undefined),
        on: vi.fn((event: string, listener: (...args: never[]) => void) => {
          listeners.set(event, listener);
        }),
        off: vi.fn((event: string) => {
          listeners.delete(event);
        }),
        ipc: { on: vi.fn(), off: vi.fn() },
        session: { on: vi.fn() },
        send: webviewSend,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setIgnoreMenuShortcuts: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        debugger: {
          isAttached: () => false,
          attach: vi.fn(),
          sendCommand: vi.fn(async () => undefined),
          on: vi.fn(),
          off: vi.fn(),
        },
      } as never,
    };
  };

  effectIt.effect("reconciles audibility that changed while the guest attached", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const guest = makeAudioWebContents(42);
        guest.startPlayingAfterFirstRead();
        fromId.mockReturnValue(guest.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_window");
        yield* manager.registerWebview("tab_audio_window", 42);
        yield* Effect.yieldNow;

        expect(states.at(-1)?.audible).toBe(true);
      }),
    ),
  );

  effectIt.effect("ignores audio state from a replaced guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const first = makeAudioWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_audio_stale");
        yield* manager.registerWebview("tab_audio_stale", 42);
        yield* Effect.yieldNow;

        const replacement = makeAudioWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_audio_stale", 43);
        yield* Effect.yieldNow;

        const publishedBefore = states.length;
        first.emitAudioState(true);
        yield* Effect.yieldNow;

        expect(states.length).toBe(publishedBefore);
        expect(states.at(-1)?.audible).toBe(false);
      }),
    ),
  );

  effectIt.effect("blocks late webview and capture starts during tab close", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("close-race-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        const replacementListenerSpies = replacementWebContents as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => {
          if (id === 42) return firstWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_close_register_race");
        yield* manager.registerWebview("tab_close_register_race", 42);
        yield* manager.openPictureInPicture("tab_close_register_race");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );

        const closeFiber = yield* manager
          .closeTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const recreateFiber = yield* manager
          .createTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const registrationFiber = yield* manager
          .registerWebview("tab_close_register_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        yield* manager.closeTab("tab_close_register_race");
        const recordingExit = yield* Effect.exit(manager.startRecording("tab_close_register_race"));
        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closeFiber);
        const recreated = yield* Fiber.join(recreateFiber);
        const registrationExit = yield* Fiber.await(registrationFiber);

        for (const exit of [registrationExit, recordingExit] as ReadonlyArray<
          Exit.Exit<unknown, PreviewManager.PreviewManagerError>
        >) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_close_register_race",
          });
        }
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        expect(replacementListenerSpies.off).not.toHaveBeenCalled();
        expect(replacementListenerSpies.ipc.off).not.toHaveBeenCalled();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recreated.webContentsId).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps a main-frame load failure visible until a retry starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        let loading = false;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "localhost:5733",
          isLoadingMainFrame: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const statuses: PreviewManager.PreviewNavStatus[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            statuses.push(state.navStatus);
          }),
        );
        yield* manager.createTab("tab_failed");
        yield* manager.registerWebview("tab_failed", 42);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        listeners.get("did-stop-loading")?.();
        listeners.get("page-title-updated")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)).toEqual({
          kind: "LoadFailed",
          url,
          title: "localhost:5733",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("LoadFailed");

        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("ignores a late cross-origin iframe load once the page has loaded", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const preview = makeFaviconWebContents();
        Object.assign(preview.webContents, { isLoading: () => true });
        fromId.mockReturnValue(preview.webContents);
        yield* manager.createTab("tab_iframe");
        yield* manager.registerWebview("tab_iframe", 42);
        const statuses = yield* Queue.unbounded<PreviewManager.PreviewNavStatus>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Queue.offer(statuses, state.navStatus).pipe(Effect.asVoid),
        );

        preview.listeners.get("did-start-loading")?.();
        expect((yield* Queue.take(statuses)).kind).toBe("Success");
        preview.listeners.get("did-stop-loading")?.();
        expect((yield* Queue.take(statuses)).kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );

        // Chromium reports UnknownVizError while a hidden guest warms its
        // first compositor frame, so transient failures are retried.
        capturePage.mockClear();
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        const retriedFiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1_000);
        const retriedExit = yield* Fiber.join(retriedFiber);
        expect(Exit.isSuccess(retriedExit)).toBe(true);
        expect(capturePage).toHaveBeenCalledTimes(3);

        capturePage.mockClear();
        const captureCause = new Error("capture failed");
        capturePage.mockRejectedValue(captureCause);
        const failingFiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(1_000);
        const exit = yield* Fiber.join(failingFiber);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledTimes(3);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: captureCause,
        });
      }),
    ),
  );

  effectIt.effect("preserves both screenshots of the same site in the same millisecond", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstPng = Buffer.from("first-preview-png");
        const secondPng = Buffer.from("second-preview-png");
        const pngImage = (png: Buffer) => ({
          toPNG: () => png,
          toJPEG: () => png,
          getSize: () => ({ width: 1280, height: 720 }),
        });
        const capturePage = vi
          .fn<() => Promise<ReturnType<typeof pngImage>>>()
          .mockResolvedValueOnce(pngImage(firstPng))
          .mockResolvedValueOnce(pngImage(secondPng));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const first = yield* manager.captureScreenshot("tab_1");
        const second = yield* manager.captureScreenshot("tab_1");

        expect(first.createdAt).toBe(second.createdAt);
        expect(first.id).not.toBe(second.id);
        expect(first.path).not.toBe(second.path);
        expect(first.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(second.id).toMatch(/^browser-screenshot-example-com-[a-z0-9]+-[0-9a-f]{8}$/);
        expect(writeFile.mock.calls).toEqual([
          [first.path, firstPng],
          [second.path, secondPng],
        ]);
      }),
    ),
  );

  effectIt.effect("keeps every recorded guest unthrottled until its frame capture stops", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const firstWebContents = makeTestPreviewWebContents(capturePage, 41, host);
        const secondWebContents = makeTestPreviewWebContents(capturePage, 42, host);
        const webContentsById = new Map([
          [41, firstWebContents],
          [42, secondWebContents],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_capture_throttling_1");
        yield* manager.createTab("tab_capture_throttling_2");
        yield* manager.registerWebview("tab_capture_throttling_1", 41);
        yield* manager.registerWebview("tab_capture_throttling_2", 42);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        yield* manager.startRecording("tab_capture_throttling_1");
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        yield* manager.startRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_1");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(firstWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.stopRecording("tab_capture_throttling_2");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(secondWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("does not commit failed starts and retries throttle restoration", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn<(enabled: boolean) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_throttling_failure");
        yield* manager.registerWebview("tab_capture_throttling_failure", 42);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling },
        } as never);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("start throttling update failed");
        });
        const failedStart = yield* Effect.exit(
          manager.startRecording("tab_capture_throttling_failure"),
        );
        expect(Exit.isFailure(failedStart)).toBe(true);

        yield* manager.startRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false]]);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("stop throttling update failed");
        });
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true], [true]]);

        yield* manager.startRecording("tab_capture_throttling_failure");
        yield* manager.stopRecording("tab_capture_throttling_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [false],
          [true],
          [true],
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("rolls back window throttling when a recorded guest cannot be unthrottled", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setWindowBackgroundThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const wc = makeTestPreviewWebContents(capturePage);
        fromId.mockReturnValue(wc);

        yield* manager.createTab("tab_guest_throttling_failure");
        yield* manager.registerWebview("tab_guest_throttling_failure", 42);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: setWindowBackgroundThrottling },
        } as never);

        wc.setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("guest throttling update failed");
        });
        const failedStart = yield* Effect.exit(
          manager.startRecording("tab_guest_throttling_failure"),
        );
        expect(Exit.isFailure(failedStart)).toBe(true);
        expect(setWindowBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(wc.setBackgroundThrottling.mock.calls).toEqual([[false]]);

        yield* manager.startRecording("tab_guest_throttling_failure");
        yield* manager.stopRecording("tab_guest_throttling_failure");
        expect(setWindowBackgroundThrottling.mock.calls).toEqual([
          [false],
          [true],
          [false],
          [true],
        ]);
        expect(wc.setBackgroundThrottling.mock.calls).toEqual([[false], [false], [true]]);
      }),
    ),
  );

  effectIt.effect("does not publish a replacement window when capture reconciliation fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn(() => {
          throw new Error("replacement throttling update failed");
        });
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_capture_replacement_failure");
        yield* manager.registerWebview("tab_capture_replacement_failure", 42);
        yield* manager.startRecording("tab_capture_replacement_failure");

        const failedReplacement = yield* Effect.exit(
          manager.addHostWindow({
            isDestroyed: () => false,
            once: vi.fn(),
            webContents: { setBackgroundThrottling },
          } as never),
        );
        expect(Exit.isFailure(failedReplacement)).toBe(true);

        yield* manager.stopRecording("tab_capture_replacement_failure");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
      }),
    ),
  );

  effectIt.effect("keeps frame capture closed when a replacement is destroyed during cleanup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const windowEvents = new Map<string, () => void>();
        const host = makeTestHostWebContents();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const guest = makeTestPreviewWebContents(capturePage, 42, host);
        fromId.mockReturnValue(guest);
        yield* manager.createTab("tab_shutdown");
        yield* manager.registerWebview("tab_shutdown", 42);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: (event: string, listener: () => void) => windowEvents.set(event, listener),
          webContents: { id: host.id, setBackgroundThrottling: vi.fn() },
        } as never);
        yield* manager.startRecording("tab_shutdown");
        const pip = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pip.pictureInPictureWindow;
        });
        yield* manager.openPictureInPicture("tab_shutdown");
        const capturesBeforeClose = capturePage.mock.calls.length;
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          state.pictureInPicture
            ? Effect.void
            : Deferred.succeed(cleanupStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseCleanup)),
              ),
        );

        windowEvents.get("closed")!();
        yield* Deferred.await(cleanupStarted);
        let destroyed = false;
        const replacement = yield* manager
          .addHostWindow({
            isDestroyed: () => destroyed,
            once: vi.fn(),
            webContents: { id: host.id, setBackgroundThrottling: vi.fn() },
          } as never)
          .pipe(Effect.forkChild({ startImmediately: true }));
        try {
          expect(replacement.pollUnsafe()).toBeUndefined();
          destroyed = true;
        } finally {
          yield* Deferred.succeed(releaseCleanup, undefined);
        }
        yield* Fiber.join(replacement);

        const restart = yield* Effect.exit(manager.startRecording("tab_shutdown"));
        expect(Exit.isFailure(restart)).toBe(true);
        if (Exit.isFailure(restart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(restart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_shutdown",
          });
        }
        expect(capturePage).toHaveBeenCalledTimes(capturesBeforeClose);
        expect(pip.pictureInPictureWindow.isDestroyed()).toBe(true);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);
      }),
    ),
  );

  effectIt.effect("ignores close events from replaced main windows", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeFirstWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));

        yield* manager.createTab("tab_replaced_window_close");
        yield* manager.registerWebview("tab_replaced_window_close", 42);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeFirstWindow = listener;
          }),
          webContents: { setBackgroundThrottling: firstWindowThrottling },
        } as never);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);

        closeFirstWindow?.();
        yield* manager.startRecording("tab_replaced_window_close");
        expect(firstWindowThrottling).not.toHaveBeenCalled();
        expect(replacementWindowThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_replaced_window_close");
        expect(replacementWindowThrottling.mock.calls).toEqual([[false], [true]]);
      }),
    ),
  );

  effectIt.effect("releases frame capture when the hosting window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        const firstWindowThrottling = vi.fn();
        const replacementWindowThrottling = vi.fn();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const host = makeTestHostWebContents();
        const webContentsById = new Map([
          [42, makeTestPreviewWebContents(capturePage, 42, host)],
          [43, makeTestPreviewWebContents(capturePage, 43, host)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );

        yield* manager.createTab("tab_window_close_recording");
        yield* manager.createTab("tab_window_close_race");
        yield* manager.registerWebview("tab_window_close_recording", 42);
        yield* manager.registerWebview("tab_window_close_race", 43);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          // Closing a window releases the tabs whose guests it hosts.
          webContents: Object.assign(host, { setBackgroundThrottling: firstWindowThrottling }),
        } as never);
        yield* manager.startRecording("tab_window_close_recording");
        expect(firstWindowThrottling.mock.calls).toEqual([[false]]);

        closeMainWindow?.();
        const racedStart = yield* Effect.exit(manager.startRecording("tab_window_close_race"));
        expect(Exit.isFailure(racedStart)).toBe(true);
        if (Exit.isFailure(racedStart)) {
          expect(Option.getOrThrow(Cause.findErrorOption(racedStart.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_race",
          });
        }
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const grants: Array<{ video?: unknown }> = [];
        host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => grants.push(value));
        expect(grants).toEqual([{}]);

        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: { setBackgroundThrottling: replacementWindowThrottling },
        } as never);
        expect(replacementWindowThrottling).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("does not arm recording after the main window closes during warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closeMainWindow: (() => void) | undefined;
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        const capturedImage = {
          toJPEG: () => Buffer.from("recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(
          () =>
            new Promise<TestCapturedPreviewImage>((resolve) => {
              markWarmupStarted();
              finishWarmup = resolve;
            }),
        );
        const host = makeTestHostWebContents();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42, host));

        yield* manager.createTab("tab_window_close_warmup");
        yield* manager.registerWebview("tab_window_close_warmup", 42);
        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") closeMainWindow = listener;
          }),
          webContents: { setBackgroundThrottling: vi.fn() },
        } as never);

        const start = yield* manager
          .startRecording("tab_window_close_warmup")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        closeMainWindow?.();
        finishWarmup(capturedImage);

        const exit = yield* Fiber.await(start);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewMainWindowClosedError",
            tabId: "tab_window_close_warmup",
          });
        }
        expect(host.session.setDisplayMediaRequestHandler).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect(
    "keeps server viewers awake until the last screencast stops, without polling",
    () =>
      Effect.gen(function* () {
        const { guest, windowThrottling, capturePage, command, frames } =
          yield* setupServerStream();
        yield* command("Page.startScreencast");
        expect(yield* Queue.take(frames)).toBe(true);
        expect(windowThrottling.mock.calls).toEqual([[false]]);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* command("Page.startScreencast", "viewer-2");
        yield* command("Page.stopScreencast");
        expect(yield* Queue.clear(frames)).toEqual([]);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* TestClock.adjust(5_000);
        expect(capturePage).not.toHaveBeenCalled();
        yield* command("Page.stopScreencast", "viewer-2");
        expect(yield* Queue.take(frames)).toBe(false);
        expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect.each(["server-stream", "recording"] as const)(
    "releasing %s preserves the other capture consumer's wake lease",
    (first) =>
      Effect.gen(function* () {
        const { manager, guest, host, windowThrottling, command, frames } =
          yield* setupServerStream();
        yield* command("Page.startScreencast");
        expect(yield* Queue.take(frames)).toBe(true);
        yield* manager.startRecording("stream-tab");
        host.displayMediaHandler()?.({ frame: host.mainFrame }, () => {});
        const stopServer = command("Page.stopScreencast").pipe(Effect.andThen(Queue.take(frames)));
        const stopRecording = manager.stopRecording("stream-tab");
        yield* first === "server-stream" ? stopServer : stopRecording;
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(windowThrottling.mock.calls).toEqual([[false]]);
        yield* first === "server-stream" ? stopRecording : stopServer;
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect.each(["disconnect", "close"] as const)(
    "releases server frame activity on %s",
    (action) =>
      Effect.gen(function* () {
        const { manager, browserHost, key, guest, windowThrottling, command, frames } =
          yield* setupServerStream();
        yield* command("Page.startScreencast");
        expect(yield* Queue.take(frames)).toBe(true);
        if (action === "disconnect") {
          yield* browserHost.disconnectRemote(key.environmentId);
          expect(yield* Queue.take(frames)).toBe(false);
        } else yield* manager.closeTab("stream-tab");
        expect(guest.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("wakes only the matching environment's hidden capture surface", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const manager = yield* PreviewManager.PreviewManager;
      const frames = yield* Queue.unbounded<{ tabId: string; active: boolean | undefined }>();
      yield* manager.subscribeFrameRequests((tabId, active) =>
        Queue.offer(frames, { tabId, active }).pipe(Effect.asVoid),
      );
      const lines = yield* Queue.unbounded<string>();
      yield* host.remoteEvents.pipe(
        Stream.runForEach((event) => Queue.offer(lines, event.environmentId)),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const capturePage = vi.fn(async () => ({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 100, height: 80 }),
      }));
      const serverTab = { threadId: "same-thread", tabId: "same-server-tab" };
      for (const [index, environmentId] of ["remote-a", "remote-b"].entries()) {
        const wc = Object.assign(makeTestPreviewWebContents(capturePage, 42 + index), {
          isDevToolsOpened: () => false,
          getUserAgent: () => "Electron",
        });
        fromId.mockReturnValue(wc);
        yield* manager.createTab(environmentId, { serverTab: { ...serverTab, environmentId } });
        yield* manager.registerWebview(environmentId, 42 + index);
        expect(yield* Queue.take(lines)).toBe(environmentId);
      }
      yield* host.remoteCommand("remote-b", {
        type: "cdp",
        ...serverTab,
        message: JSON.stringify({
          id: 1,
          method: "Page.captureScreenshot",
          sessionId: "t3-preview-page",
        }),
      });
      expect(yield* Queue.take(frames)).toEqual({ tabId: "remote-b", active: undefined });
      expect(yield* Queue.take(frames)).toEqual({ tabId: "remote-b", active: true });
      expect(yield* Queue.take(frames)).toEqual({ tabId: "remote-b", active: false });
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect.each([true, false])(
    "delivers server input across the renderer focus guard boundary, focused=%s",
    (focused) =>
      Effect.gen(function* () {
        const manager = yield* PreviewManager.PreviewManager;
        const host = yield* DesktopBrowserHost.DesktopBrowserHost;
        const lines = yield* Queue.unbounded<string>();
        yield* host.events.pipe(
          Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const listeners = new Map<string, () => void>();
        const editor = { tagName: "DIV", isConnected: true, focus: vi.fn() };
        const document = {
          activeElement: editor,
          body: {},
          addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
          removeEventListener: (name: string) => listeners.delete(name),
        };
        const world = NodeVM.createContext({ document });
        const renderer = {
          ...makeTestHostWebContents(),
          executeJavaScriptInIsolatedWorld: async (
            _worldId: number,
            scripts: ReadonlyArray<{ code: string }>,
          ) => {
            // Electron clones the script's completion value back to main. A function
            // result rejects before mouse-down, even though the guard was installed.
            return structuredClone(NodeVM.runInContext(scripts[0]!.code, world));
          },
        };
        const delivered: string[] = [];
        const guest = Object.assign(makeTestPreviewWebContents(vi.fn(), 42, renderer), {
          focusedFrame: focused ? {} : null,
          insertText: async () => {
            expect(listeners.has("focusin")).toBe(true);
            delivered.push("Input.insertText");
          },
          sendInputEvent: () => {
            expect(listeners.has("focusin")).toBe(true);
            delivered.push("Input.dispatchKeyEvent");
          },
          getUserAgent: () => "Electron",
          isDevToolsOpened: () => false,
        });
        vi.mocked(guest.debugger.sendCommand).mockImplementation(async (method) => {
          if (method.startsWith("Input.")) {
            expect(listeners.has("focusin")).toBe(true);
            delivered.push(method);
          }
          return method === "Runtime.evaluate" ? { result: { value: true } } : {};
        });
        fromId.mockImplementation((id) => (id === renderer.id ? renderer : guest) as never);
        const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
        yield* manager.createTab("tab-1", { serverTab });
        yield* manager.registerWebview("tab-1", 42);
        yield* Queue.take(lines); // The tab has attached before commands arrive.
        yield* Effect.yieldNow;
        for (const [id, method] of [
          "Input.dispatchMouseEvent",
          "Input.dispatchKeyEvent",
          "Input.insertText",
        ].entries()) {
          yield* host.handleCommandLine(
            JSON.stringify({
              type: "cdp",
              ...serverTab,
              message: JSON.stringify({
                id,
                method,
                params:
                  method === "Input.dispatchMouseEvent"
                    ? { type: "mousePressed" }
                    : method === "Input.dispatchKeyEvent"
                      ? { type: "rawKeyDown", key: "Escape" }
                      : { text: "hello" },
                sessionId: "t3-preview-page",
              }),
            }),
          );
          expect(JSON.parse(yield* Queue.take(lines))).toMatchObject({
            type: "cdp",
            message: expect.any(String),
          });
          expect(delivered).toHaveLength(id + 1);
          expect(listeners.size).toBe(0);
        }
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("connects another server tab while a page evaluation is pending", () =>
    Effect.gen(function* () {
      const manager = yield* PreviewManager.PreviewManager;
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      yield* TestClock.adjust(0);
      const pending = Promise.withResolvers<unknown>();
      const started = Promise.withResolvers<void>();
      const guests = [42, 43].map((id) =>
        Object.assign(makeTestPreviewWebContents(vi.fn(), id), {
          getUserAgent: () => "Electron",
          isDevToolsOpened: () => false,
        }),
      );
      for (const [index, guest] of guests.entries()) {
        fromId.mockReturnValue(guest);
        yield* manager.createTab(`tab-${index}`, {
          serverTab: { threadId: `thread-${index}`, tabId: `server-tab-${index}` },
        });
        yield* manager.registerWebview(`tab-${index}`, guest.id);
        yield* Queue.take(lines);
      }
      vi.mocked(guests[0]!.debugger.sendCommand).mockImplementation((method) => {
        if (method === "Runtime.evaluate") {
          started.resolve();
          return pending.promise;
        }
        return Promise.resolve({});
      });
      const secondSend = vi.mocked(guests[1]!.debugger.sendCommand);
      secondSend.mockClear();
      const command = (index: number, id: number, method: string) =>
        host.handleCommandLine(
          JSON.stringify({
            type: "cdp",
            threadId: `thread-${index}`,
            tabId: `server-tab-${index}`,
            message: JSON.stringify({ id, method, sessionId: "t3-preview-page" }),
          }),
        );
      yield* command(0, 1, "Runtime.evaluate");
      yield* Effect.promise(() => started.promise);
      try {
        yield* command(1, 2, "Runtime.enable");
        yield* command(1, 3, "DOM.enable");
        yield* Queue.take(lines);
        expect(secondSend).toHaveBeenCalledWith("DOM.enable", {});
        expect(secondSend).toHaveBeenCalledWith("Runtime.enable", {});
      } finally {
        pending.resolve({});
      }
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("tells the server when a tab it renders natively closes", () =>
    Effect.gen(function* () {
      const host = yield* DesktopBrowserHost.DesktopBrowserHost;
      const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
      const lines = yield* Queue.unbounded<string>();
      yield* host.events.pipe(
        Stream.runForEach((line) => Queue.offer(lines, new TextDecoder().decode(line))),
        Effect.forkScoped,
      );
      const nextType = Queue.take(lines).pipe(
        Effect.map((line) => /"type":"(\w+)"/.exec(line)?.[1]),
      );
      const capturePage = vi.fn(async () => ({
        toPNG: () => Buffer.from("png"),
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 100, height: 80 }),
      }));
      fromId.mockReturnValue(
        Object.assign(makeTestPreviewWebContents(capturePage, 42), {
          isDevToolsOpened: () => false,
          getUserAgent: () => "Electron",
        }),
      );
      const manager = yield* PreviewManager.PreviewManager;
      yield* manager.createTab("tab_1", { serverTab });
      yield* manager.registerWebview("tab_1", 42);
      expect(yield* nextType).toBe("attached");
      yield* manager.closeTab("tab_1");
      expect(yield* nextType).toBe("detached");
    }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect(
    "asks the client to paint a navigated server tab while the agent captures it",
    () =>
      Effect.gen(function* () {
        const host = yield* DesktopBrowserHost.DesktopBrowserHost;
        const serverTab = { threadId: "thread-1", tabId: "server-tab-1" };
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => {
            throw new Error("unused");
          }, 42),
          {
            isDevToolsOpened: () => false,
            getUserAgent: () => "Electron",
            loadURL: vi.fn(async () => undefined),
          },
        );
        const screenshot = Promise.withResolvers<unknown>();
        contents.debugger.sendCommand = vi.fn((method: string) =>
          method === "Page.captureScreenshot" ? screenshot.promise : Promise.resolve(undefined),
        ) as unknown as typeof contents.debugger.sendCommand;
        fromId.mockReturnValue(contents);
        const manager = yield* PreviewManager.PreviewManager;
        const capturing = yield* Queue.unbounded<boolean>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Queue.offer(capturing, state.capturing).pipe(Effect.asVoid),
        );
        const attached = yield* Deferred.make<void>();
        yield* host.events.pipe(
          Stream.runForEach((line) =>
            new TextDecoder().decode(line).includes('"type":"attached"')
              ? Deferred.succeed(attached, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* manager.createTab("tab_1", { serverTab });
        yield* manager.registerWebview("tab_1", 42);
        yield* Deferred.await(attached);
        // Navigating rebuilds the tab's state, which must keep the server tab it answers for.
        yield* manager.navigate("tab_1", "https://example.com/next");
        yield* Queue.clear(capturing);

        yield* host.handleCommandLine(
          JSON.stringify({
            type: "cdp",
            ...serverTab,
            message: JSON.stringify({
              id: 1,
              method: "Page.captureScreenshot",
              sessionId: "t3-preview-page",
            }),
          }),
        );
        expect(yield* Queue.take(capturing)).toBe(true);
        screenshot.resolve({ data: "" });
        expect(yield* Queue.take(capturing)).toBe(false);
      }).pipe(Effect.provide(managerLayer()), Effect.scoped),
  );

  effectIt.effect("discards a screenshot that resolves after its guest is replaced", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image = {
          toPNG: () => Buffer.from("stale-png"),
          toJPEG: () => Buffer.from("stale-jpeg"),
          getSize: () => ({ width: 100, height: 80 }),
        };
        const pending = Promise.withResolvers<typeof image>();
        const capturePage = vi.fn(() => pending.promise);
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 42));
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const fiber = yield* Effect.exit(manager.captureScreenshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(0);
        expect(capturePage).toHaveBeenCalledOnce();
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage, 43));
        yield* manager.registerWebview("tab_1", 43);
        pending.resolve(image);
        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();
        expect(writeFile).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("releases snapshot control when every capture attempt stalls", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(() => new Promise<TestCapturedPreviewImage>(() => {}));
        const wc = makeTestPreviewWebContents(capturePage);
        Object.assign(wc, { isDevToolsOpened: () => false });
        Object.assign(wc.debugger, {
          sendCommand: vi.fn(async (method: string, params?: Record<string, unknown>) => {
            if (method === "Runtime.evaluate") {
              return {
                result: {
                  value:
                    params?.["expression"] === "42"
                      ? 42
                      : {
                          url: "https://example.com",
                          title: "Example",
                          loading: false,
                          visibleText: "Example",
                          interactiveElements: [],
                        },
                },
              };
            }
            return method === "Accessibility.getFullAXTree" ? { nodes: [] } : undefined;
          }),
        });
        fromId.mockReturnValue(wc);
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const textOnly = yield* manager.automationSnapshot("tab_1", false);
        expect(textOnly).toMatchObject({
          title: "Example",
          visibleText: "Example",
          interactiveElements: [],
        });
        expect(textOnly).not.toHaveProperty("screenshot");
        expect(capturePage).not.toHaveBeenCalled();

        const snapshot = yield* Effect.exit(manager.automationSnapshot("tab_1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledOnce();
        const evaluate = yield* manager
          .automationEvaluate("tab_1", { expression: "42" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(evaluate.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(4_000);
        const exit = yield* Fiber.join(snapshot);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(capturePage).toHaveBeenCalledTimes(3);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "automationSnapshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: { _tag: "TimeoutError" },
        });
        expect(yield* Fiber.join(evaluate)).toBe(42);
      }),
    ),
  );

  effectIt.effect("grants each concurrent preview recording its own tab frame", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstJpeg = Buffer.from("first-recording-frame");
        const secondJpeg = Buffer.from("second-recording-frame");
        const firstCapturePage = vi.fn(async () => ({
          toJPEG: () => firstJpeg,
          getSize: () => ({ width: 800, height: 600 }),
        }));
        const secondCapturePage = vi.fn(async () => ({
          toJPEG: () => secondJpeg,
          getSize: () => ({ width: 390, height: 844 }),
        }));
        const firstSendCommand = vi.fn(async () => undefined);
        const secondSendCommand = vi.fn(async () => undefined);
        const host = makeTestHostWebContents();
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
        ) =>
          ({
            id,
            mainFrame: { routingId: id },
            hostWebContents: host,
            executeJavaScript: vi.fn(async () =>
              id === 41 ? { width: 800, height: 600 } : { width: 390, height: 844 },
            ),
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoadingMainFrame: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setAudioMuted: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            isCurrentlyAudible: () => false,
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            session: { on: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setIgnoreMenuShortcuts: vi.fn(),
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
            capturePage,
          }) as never;
        const webContentsById = new Map([
          [41, makeWebContents(41, firstCapturePage, firstSendCommand)],
          [42, makeWebContents(42, secondCapturePage, secondSendCommand)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);

        const grants: Array<{ video?: unknown }> = [];
        const takeGrant = () =>
          host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => {
            grants.push(value);
          });

        yield* manager.startRecording("tab_1");
        takeGrant();
        yield* manager.startRecording("tab_2");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 41 } }, { video: { routingId: 42 } }]);

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
        expect(firstSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );
        expect(secondSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );

        yield* Effect.all([manager.stopRecording("tab_1"), manager.stopRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    ),
  );

  effectIt.effect("only lets the host frame that armed a recording claim its stream", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        takeGrant({ frameTreeNodeId: 999 });
        takeGrant();

        expect(grants).toEqual([{}, { video: { routingId: 41 } }]);
        yield* manager.stopRecording("tab_race_a");
      }),
    ),
  );

  effectIt.effect("reclaims the arm slot from a destroyed webContents", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const { grants, takeGrant, destroy } = yield* setupRecordingRaceTabs(manager);

        yield* manager.startRecording("tab_race_a");
        destroy(41);
        yield* manager.startRecording("tab_race_b");
        takeGrant();
        expect(grants).toEqual([{ video: { routingId: 42 } }]);

        yield* manager.stopRecording("tab_race_b");
      }),
    ),
  );

  effectIt.effect("gates recording decorations and isolates failed subscribers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const callbacks = new Map<
          string,
          (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined
        >();
        const contents = Object.assign(
          makeTestPreviewWebContents(async () => ({
            toJPEG: () => Buffer.from("frame"),
            getSize: () => ({ width: 800, height: 600 }),
          })),
          {
            ipc: {
              on: (
                channel: string,
                callback: (event: unknown, input: unknown) => Fiber.Fiber<void, never> | undefined,
              ) => callbacks.set(channel, callback),
              off: vi.fn(),
            },
          },
        );
        fromId.mockReturnValue(contents as never);
        yield* manager.createTab("tab_recording_input");
        yield* manager.registerWebview("tab_recording_input", 42);
        const received: DesktopPreviewRecordingInputEvent[] = [];
        yield* manager.subscribeRecordingInputs(() => Effect.die("renderer unavailable"));
        yield* manager.subscribeRecordingInputs((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        );
        const send = (input: unknown) =>
          Effect.gen(function* () {
            const fiber = callbacks.get("preview:recording-input")?.(null, input);
            if (fiber) yield* Fiber.join(fiber);
          });
        const key = { type: "key", label: "⌘C", held: true, width: 800 };
        const pointer = {
          type: "pointer",
          phase: "down",
          x: 120,
          y: 80,
          width: 800,
          height: 600,
        };
        yield* send(key);
        expect(received).toEqual([]);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: true,
          showMousePresses: false,
        });
        yield* send(key);
        yield* send(pointer);
        yield* send({ ...key, width: 0 });
        expect(received).toEqual([{ tabId: "tab_recording_input", input: key }]);
        yield* manager.stopRecording("tab_recording_input");
        yield* send(key);
        expect(received).toHaveLength(1);
        yield* manager.startRecording("tab_recording_input", {
          showKeyPresses: false,
          showMousePresses: true,
        });
        yield* send(key);
        yield* send(pointer);
        expect(received.at(-1)).toEqual({ tabId: "tab_recording_input", input: pointer });
        expect(received).toHaveLength(2);
      }),
    ),
  );

  effectIt.effect(
    "releases queued STOP after stalled recording warmups and ignores late completion",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const warmupStarted = Promise.withResolvers<void>();
          const firstWarmup = Promise.withResolvers<TestCapturedPreviewImage>();
          const lateWarmup = Promise.withResolvers<TestCapturedPreviewImage>();
          const capturePage = vi
            .fn<() => Promise<TestCapturedPreviewImage>>()
            .mockImplementationOnce(() => {
              warmupStarted.resolve();
              return firstWarmup.promise;
            })
            .mockImplementation(() => lateWarmup.promise);
          const host = makeTestHostWebContents();
          const webContents = makeTestPreviewWebContents(capturePage, 42, host);
          const windowThrottling = vi.fn();
          fromId.mockReturnValue(webContents);
          yield* manager.createTab("tab_recording_stalled_warmup");
          yield* manager.registerWebview("tab_recording_stalled_warmup", 42);
          yield* manager.addHostWindow({
            isDestroyed: () => false,
            once: vi.fn(),
            webContents: { setBackgroundThrottling: windowThrottling },
          } as never);

          const image = {
            toJPEG: () => Buffer.from("late-recording-frame"),
            getSize: () => ({ width: 1280, height: 720 }),
          };
          try {
            const start = yield* manager
              .startRecording("tab_recording_stalled_warmup")
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Effect.promise(() => warmupStarted.promise);
            let stopped = false;
            const stop = yield* manager.stopRecording("tab_recording_stalled_warmup").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  stopped = true;
                }),
              ),
              Effect.forkChild({ startImmediately: true }),
            );
            expect(webContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
            expect(windowThrottling.mock.calls).toEqual([[false]]);
            yield* TestClock.adjust(1_000);
            expect(stopped).toBe(false);
            expect(host.executeJavaScript).not.toHaveBeenCalled();
            yield* TestClock.adjust(1_000);
            expect(stopped).toBe(true);
            yield* Fiber.join(start);
            yield* Fiber.join(stop);
            expect(capturePage).toHaveBeenCalledTimes(2);
            expect(host.executeJavaScript).toHaveBeenCalledOnce();
            expect(webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
            expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
            expect(webviewSend).toHaveBeenLastCalledWith("preview:recording-cursor", false);

            lateWarmup.resolve(image);
            yield* TestClock.adjust(0);
            const streams: Array<{ video?: unknown }> = [];
            host.displayMediaHandler()?.({ frame: host.mainFrame }, (value) => streams.push(value));
            expect(streams).toEqual([{}]);
            expect(capturePage).toHaveBeenCalledTimes(2);
            expect(host.executeJavaScript).toHaveBeenCalledOnce();
            expect(webContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
            expect(windowThrottling.mock.calls).toEqual([[false], [true]]);
            expect(webviewSend).toHaveBeenLastCalledWith("preview:recording-cursor", false);
          } finally {
            // Release stalled native calls after a failing assertion against unchanged base.
            firstWarmup.resolve(image);
            lateWarmup.resolve(image);
          }
        }),
      ),
  );

  effectIt.effect("continues native recording when the source warmup fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => {
          throw new Error("source is not ready");
        });
        const host = makeTestHostWebContents();
        const webContents = Object.assign(makeTestPreviewWebContents(capturePage, 42, host), {
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
        });
        fromId.mockReturnValue(webContents);

        yield* manager.createTab("tab_recording_warmup_failure");
        yield* manager.registerWebview("tab_recording_warmup_failure", 42);

        yield* manager.startRecording("tab_recording_warmup_failure");
        expect(capturePage).toHaveBeenCalledTimes(2);

        const handler = host.displayMediaHandler();
        const streams: Array<{ video?: unknown }> = [];
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        handler?.({ frame: host.mainFrame }, (value) => streams.push(value));
        expect(streams).toEqual([{ video: { routingId: 42 } }, {}]);

        yield* manager.stopRecording("tab_recording_warmup_failure");
      }),
    ),
  );

  effectIt.effect("serializes recording source acquisition with webview replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturedImage = {
          toJPEG: () => Buffer.from("unused-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        let markWarmupStarted!: () => void;
        const warmupStarted = new Promise<void>((resolve) => {
          markWarmupStarted = resolve;
        });
        let finishWarmup!: (image: TestCapturedPreviewImage) => void;
        const capturePage = vi
          .fn<() => Promise<TestCapturedPreviewImage>>()
          .mockImplementationOnce(
            () =>
              new Promise<TestCapturedPreviewImage>((resolve) => {
                markWarmupStarted();
                finishWarmup = resolve;
              }),
          )
          .mockResolvedValue(capturedImage);
        const initialWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementOn = vi.fn();
        const replacementWebContents = Object.assign(makeTestPreviewWebContents(capturePage, 43), {
          on: replacementOn,
        });
        fromId.mockImplementation((id) => {
          if (id === 42) return initialWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });

        yield* manager.createTab("tab_recording_replacement_race");
        yield* manager.registerWebview("tab_recording_replacement_race", 42);
        const start = yield* manager
          .startRecording("tab_recording_replacement_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => warmupStarted);
        const replacement = yield* manager
          .registerWebview("tab_recording_replacement_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementOn).not.toHaveBeenCalled();

        finishWarmup(capturedImage);
        yield* Fiber.join(start);
        yield* Fiber.join(replacement);
        expect(replacementOn).toHaveBeenCalled();
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
        yield* manager.stopRecording("tab_recording_replacement_race");
        expect(initialWebContents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
        expect(replacementWebContents.setBackgroundThrottling.mock.calls).toEqual([
          [false],
          [true],
        ]);
      }),
    ),
  );

  effectIt.effect("shares background frame capture between recording and picture-in-picture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const setBackgroundThrottling = vi.fn();
        const mainWindowWebContents = Object.assign(makeTestHostWebContents(), {
          setBackgroundThrottling,
        });
        const jpeg = Buffer.from("shared-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          toBitmap: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue({
          id: 42,
          mainFrame: { routingId: 42 },
          hostWebContents: mainWindowWebContents,
          executeJavaScript: vi.fn(async () => ({ width: 1280, height: 720 })),
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        const pictureInPictureListeners = new Map<string, () => void>();
        const pictureInPictureSend = vi.fn();
        const pictureInPictureWindow = {
          isDestroyed: vi.fn(() => false),
          once: vi.fn((event: string, listener: () => void) => {
            pictureInPictureListeners.set(event, listener);
          }),
          setAlwaysOnTop: vi.fn(),
          setVisibleOnAllWorkspaces: vi.fn(),
          setAspectRatio: vi.fn(),
          getContentSize: vi.fn(() => [480, 320] as [number, number]),
          setContentSize: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            pictureInPictureListeners.get("closed")?.();
          }),
          webContents: {
            on: vi.fn(),
            off: vi.fn(),
            send: pictureInPictureSend,
          },
        };
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.addHostWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: mainWindowWebContents,
        } as never);

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_pip");
        yield* manager.registerWebview("tab_pip", 42);
        yield* manager.openPictureInPicture("tab_pip");

        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        expect(browserWindowConstructor).toHaveBeenCalledWith(
          expect.objectContaining({
            alwaysOnTop: true,
            show: false,
            skipTaskbar: true,
            webPreferences: expect.objectContaining({
              preload: "/tmp/t3/desktop/preview-pip-preload.cjs",
              backgroundThrottling: false,
            }),
          }),
        );
        expect(pictureInPictureWindow.showInactive).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(pictureInPictureWindow.setContentSize).toHaveBeenCalledWith(523, 294, false);
        expect(pictureInPictureWindow.setAspectRatio.mock.invocationCallOrder[0]).toBeLessThan(
          pictureInPictureWindow.setContentSize.mock.invocationCallOrder[0] ?? 0,
        );
        expect(pictureInPictureWindow.setContentSize.mock.invocationCallOrder[0]).toBeLessThan(
          pictureInPictureWindow.setAspectRatio.mock.invocationCallOrder[1] ?? 0,
        );
        expect(pictureInPictureSend).toHaveBeenCalledWith(
          "desktop:preview-pip-frame",
          expect.objectContaining({
            tabId: "tab_pip",
            data: jpeg.toString("base64"),
            width: 1280,
            height: 720,
          }),
        );
        expect(states.at(-1)?.pictureInPicture).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();
        const pictureInPictureFramesBeforeRecording = pictureInPictureSend.mock.calls.length;

        yield* manager.startRecording("tab_pip");
        expect(capturePage).toHaveBeenCalledTimes(2);

        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(3);
        expect(pictureInPictureSend).toHaveBeenCalledTimes(pictureInPictureFramesBeforeRecording);

        yield* manager.stopRecording("tab_pip");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false]]);
        const framesBeforePictureInPictureOnlyTick = pictureInPictureSend.mock.calls.length;
        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(4);
        expect(pictureInPictureSend.mock.calls.length).toBe(framesBeforePictureInPictureOnlyTick);

        setBackgroundThrottling.mockImplementationOnce(() => {
          throw new Error("picture-in-picture throttling restore failed");
        });
        yield* manager.closePictureInPicture("tab_pip");
        expect(setBackgroundThrottling.mock.calls).toEqual([[false], [true], [true]]);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("keeps picture-in-picture capture separate from recording warmup", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("shared-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          toBitmap: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_recording_then_pip");
        yield* manager.registerWebview("tab_recording_then_pip", 42);
        yield* manager.startRecording("tab_recording_then_pip");

        expect(capturePage).toHaveBeenCalledOnce();
        yield* manager.openPictureInPicture("tab_recording_then_pip");
        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledOnce();

        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(3);
        expect(send).toHaveBeenCalledOnce();
        yield* manager.closePictureInPicture("tab_recording_then_pip");
        yield* manager.stopRecording("tab_recording_then_pip");
      }),
    ),
  );

  effectIt.effect("stops frame capture when the native picture-in-picture window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("native-close-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        const pictureInPictureClosed = yield* Deferred.make<void>();
        let wasPictureInPicture = false;
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.gen(function* () {
            states.push(state);
            if (state.pictureInPicture) wasPictureInPicture = true;
            else if (wasPictureInPicture)
              yield* Deferred.succeed(pictureInPictureClosed, undefined);
          }),
        );

        yield* manager.createTab("tab_native_pip_close");
        yield* manager.registerWebview("tab_native_pip_close", 42);
        yield* manager.openPictureInPicture("tab_native_pip_close");

        pictureInPictureWindow.close();
        yield* Deferred.await(pictureInPictureClosed);

        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("retries an unchanged picture-in-picture frame after delivery fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("retry-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          toBitmap: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        send.mockImplementationOnce(() => {
          throw new Error("picture-in-picture delivery failed");
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_pip_delivery_retry");
        yield* manager.registerWebview("tab_pip_delivery_retry", 42);
        yield* manager.openPictureInPicture("tab_pip_delivery_retry");
        expect(send).toHaveBeenCalledOnce();

        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledTimes(2);
        yield* manager.closePictureInPicture("tab_pip_delivery_retry");
      }),
    ),
  );

  effectIt.effect("replays an unchanged picture-in-picture frame after its renderer reloads", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("reloaded-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          toBitmap: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send, webContentsListeners } =
          makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_pip_reload");
        yield* manager.registerWebview("tab_pip_reload", 42);
        yield* manager.openPictureInPicture("tab_pip_reload");
        expect(send).toHaveBeenCalledOnce();

        webContentsListeners.get("did-finish-load")?.();
        yield* TestClock.adjust(100);

        expect(send).toHaveBeenCalledTimes(2);
        yield* manager.closePictureInPicture("tab_pip_reload");
      }),
    ),
  );

  effectIt.effect("encodes a picture-in-picture frame only when the page changes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let page = "static-page";
        let pixelsReadable = true;
        const toJPEG = vi.fn((pixels: string) => Buffer.from(`jpeg:${pixels}`));
        const capturePage = vi.fn(async () => {
          const pixels = page;
          return {
            toJPEG: () => toJPEG(pixels),
            toBitmap: () => (pixelsReadable ? Buffer.from(pixels) : Buffer.alloc(0)),
            getSize: () => ({ width: 1280, height: 720 }),
          };
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_pip_unchanged");
        yield* manager.registerWebview("tab_pip_unchanged", 42);
        yield* manager.openPictureInPicture("tab_pip_unchanged");
        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(toJPEG).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledOnce();

        page = "changed-page";
        yield* TestClock.adjust(100);

        expect(toJPEG).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith(
          "desktop:preview-pip-frame",
          expect.objectContaining({ data: Buffer.from("jpeg:changed-page").toString("base64") }),
        );

        // A frame whose pixels cannot be read has no fingerprint and is still delivered.
        pixelsReadable = false;
        yield* TestClock.adjust(100);

        expect(toJPEG).toHaveBeenCalledTimes(3);
        expect(send).toHaveBeenCalledTimes(3);
        yield* manager.closePictureInPicture("tab_pip_unchanged");
      }),
    ),
  );

  effectIt.effect("drops empty frames before picture-in-picture delivery", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const validImage: TestCapturedPreviewImage = {
          toJPEG: () => Buffer.from("valid-preview-frame"),
          toBitmap: () => Buffer.from("valid-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(async () => validImage);
        capturePage.mockResolvedValueOnce({
          toJPEG: () => Buffer.from("empty-preview-frame"),
          getSize: () => ({ width: 0, height: 0 }),
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_empty_frame");
        yield* manager.registerWebview("tab_empty_frame", 42);
        yield* manager.openPictureInPicture("tab_empty_frame");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setAspectRatio).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();

        yield* TestClock.adjust(100);

        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(send).toHaveBeenCalledOnce();
        yield* manager.closePictureInPicture("tab_empty_frame");
      }),
    ),
  );

  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () => new Promise<void>(() => {}),
        );
        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();
        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);
        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        let resolveLoad: (() => void) | undefined;
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);
        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();
        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);
        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);
          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps element picking active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, (...args) => {
              listeners.delete(event);
              listener(...args);
            });
          }),
          off: vi.fn(),
          session: { on: vi.fn() },
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({
          url: "about:blank",
          isSameDocument: false,
          isMainFrame: false,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({
          url: "https://example.com/next",
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
        });
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("keeps annotation send grants isolated and updates an active pick", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const picked = new Map<number, (event: unknown, ...args: unknown[]) => void>();
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("annotation"),
          toDataURL: () => "data:image/png;base64,YW5ub3RhdGlvbg==",
          getSize: () => ({ width: 10, height: 10 }),
        }));
        const guests = new Map(
          [42, 43, 44].map(
            (id) =>
              [
                id,
                Object.assign(makeTestPreviewWebContents(capturePage, id), {
                  isFocused: () => true,
                  once: vi.fn(),
                  ipc: {
                    on: vi.fn(
                      (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => {
                        if (channel === "preview:element-picked") picked.set(id, listener);
                      },
                    ),
                    off: vi.fn(),
                    removeListener: vi.fn(),
                  },
                }),
              ] as const,
          ),
        );
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));
        yield* manager.createTab("tab_a");
        yield* manager.createTab("tab_b");
        yield* manager.registerWebview("tab_a", 42);
        yield* manager.registerWebview("tab_b", 43);
        yield* manager.setAnnotationSendEnabled("tab_a", true);
        const annotation = {
          id: "annotation-scopes",
          pageUrl: "https://example.com",
          pageTitle: "Example",
          comment: "Tighten this spacing",
          elements: [],
          regions: [],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-09-05T00:00:00.000Z",
        };
        for (const [tabId, id, nextGrant, expected] of [
          ["tab_b", 43, undefined, "attach"],
          ["tab_a", 42, false, "attach"],
          ["tab_a", 42, true, "send"],
        ] as const) {
          const pick = yield* manager.pickElement(tabId).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          if (nextGrant !== undefined) {
            yield* manager.setAnnotationSendEnabled(tabId, nextGrant);
          }
          picked.get(id)?.({}, annotation, null, "send");
          const result = yield* Fiber.join(pick);
          expect(result?.annotation.id).toBe(annotation.id);
          expect(result?.submission).toBe(expected);
        }
        yield* manager.registerWebview("tab_a", 44);
        const replacementPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(replacementPick))?.submission).toBe("send");
        yield* manager.closeTab("tab_a");
        yield* manager.createTab("tab_a");
        yield* manager.registerWebview("tab_a", 44);
        const reopenedPick = yield* manager.pickElement("tab_a").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        picked.get(44)?.({}, annotation, null, "send");
        expect((yield* Fiber.join(reopenedPick))?.submission).toBe("attach");
      }),
    ),
  );

  effectIt.effect("settles the pick when the annotation screenshot never arrives", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
          capturePage: vi.fn(() => new Promise(() => {})),
          session: { on: vi.fn() },
          ipc: {
            on: vi.fn((channel: string, listener: typeof onPicked) => {
              if (channel === "preview:element-picked") onPicked = listener;
            }),
            off: vi.fn(),
            removeListener: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        yield* manager.setAnnotationSendEnabled("tab_1", true);
        onPicked?.(
          {},
          {
            id: "annotation_1",
            pageUrl: "https://example.com",
            pageTitle: "Example",
            comment: "Tighten this spacing",
            elements: [],
            regions: [{ id: "region_1", rect: { x: 5, y: 6, width: 20, height: 30 } }],
            strokes: [],
            styleChanges: [],
            screenshot: null,
            createdAt: "2026-06-11T00:00:00.000Z",
          },
          null,
          "send",
        );
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("6 seconds");
        const result = yield* Fiber.join(pick);
        expect(result?.annotation.screenshot).toBeNull();
        expect(result?.screenshotFailed).toBe(true);
        expect(result?.submission).toBe("send");
        expect(webviewSend).toHaveBeenCalledWith("preview:annotation-captured");
      }),
    ),
  );

  describe("annotation screenshots", () => {
    const captureAnnotation = (
      cropRect: PreviewAnnotationRect | null,
      targets: Partial<Pick<PreviewAnnotationPayload, "elements" | "regions" | "strokes">> = {},
      emptyImage?: "viewport" | "crop",
    ) =>
      withManager((manager) =>
        Effect.gen(function* () {
          let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
          const crop = vi.fn((rect: Electron.Rectangle) => ({
            isEmpty: () => emptyImage === "crop",
            getSize: () =>
              emptyImage === "crop"
                ? { width: 0, height: 0 }
                : { width: rect.width, height: rect.height },
            toDataURL: () => (emptyImage === "crop" ? "data:," : "data:image/png;base64,cropped"),
          }));
          const capturePage = vi.fn(async () => ({
            isEmpty: () => emptyImage === "viewport",
            getSize: () =>
              emptyImage === "viewport" ? { width: 0, height: 0 } : { width: 2000, height: 1200 },
            toJPEG: () => Buffer.from("unused"),
            toDataURL: () => (emptyImage === "viewport" ? "data:," : "data:image/png;base64,full"),
            crop,
          }));
          fromId.mockReturnValue(
            Object.assign(makeTestPreviewWebContents(capturePage), {
              isFocused: () => true,
              once: vi.fn(),
              ipc: {
                on: vi.fn((channel: string, listener: typeof onPicked) => {
                  if (channel === "preview:element-picked") onPicked = listener;
                }),
                off: vi.fn(),
                removeListener: vi.fn(),
              },
            }),
          );

          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          onPicked?.(
            {},
            {
              id: "annotation_1",
              pageUrl: "https://example.com",
              pageTitle: "Example",
              comment: "Tighten this spacing",
              elements: [],
              regions: [],
              strokes: [],
              ...targets,
              styleChanges: [],
              screenshot: null,
              createdAt: "2026-06-11T00:00:00.000Z",
            },
            cropRect,
            "attach",
            2,
          );

          const result = yield* Fiber.join(pick);
          expect(capturePage).toHaveBeenCalledExactlyOnceWith();
          expect(result?.annotation.comment).toBe("Tighten this spacing");
          expect(result?.submission).toBe("attach");
          return { result, crop };
        }),
      );

    effectIt.effect("clips a partially visible selection to the captured viewport", () =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(
          { x: -40, y: 570, width: 240, height: 110 },
          { regions: [{ id: "region_1", rect: { x: -20, y: 590, width: 200, height: 70 } }] },
        );
        expect(crop).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 1140, width: 400, height: 60 });
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: 400,
          height: 60,
        });
      }),
    );

    effectIt.effect.each([
      {
        name: "an offscreen crop without individual target bounds",
        cropRect: { x: 1010, y: 40, width: 100, height: 70 },
        regions: [],
      },
      {
        name: "padding overlapping the viewport while its target is offscreen",
        cropRect: { x: 40, y: -100, width: 240, height: 110 },
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
      {
        name: "a union spanning the viewport with both targets offscreen",
        cropRect: { x: -230, y: 40, width: 1460, height: 110 },
        regions: [
          { id: "region_1", rect: { x: -210, y: 60, width: 200, height: 70 } },
          { id: "region_2", rect: { x: 1010, y: 60, width: 200, height: 70 } },
        ],
      },
      {
        name: "an offscreen target when crop bounds are missing",
        cropRect: null,
        regions: [{ id: "region_1", rect: { x: 60, y: -80, width: 200, height: 70 } }],
      },
    ])("does not attach $name", ({ cropRect, regions }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, { regions });
        expect(crop).not.toHaveBeenCalled();
        expect(result?.annotation.screenshot).toBeNull();
        expect(result?.screenshotFailed).toBe(true);
      }),
    );

    // regression: #18441 zero-area strokes on the viewport edge must still get a screenshot crop
    effectIt.effect.each([
      {
        name: "zero-width SVG line on the left edge",
        rect: { x: 0, y: 60, width: 0, height: 70 },
        cropRect: { x: -20, y: 40, width: 40, height: 110 },
        expectedCrop: { x: 0, y: 80, width: 40, height: 220 },
      },
      {
        name: "zero-height SVG line on the top edge",
        rect: { x: 60, y: 0, width: 70, height: 0 },
        cropRect: { x: 40, y: -20, width: 110, height: 40 },
        expectedCrop: { x: 80, y: 0, width: 220, height: 40 },
      },
    ])("captures a stroked $name", ({ rect, cropRect, expectedCrop }) =>
      Effect.gen(function* () {
        const { result, crop } = yield* captureAnnotation(cropRect, {
          elements: [
            {
              id: "element_1",
              rect,
              element: {
                pageUrl: "https://example.com",
                pageTitle: "Example",
                tagName: "line",
                selector: "svg > line",
                htmlPreview: '<line stroke="black" stroke-width="2" />',
                componentName: null,
                source: null,
                stack: [],
                styles: "stroke: black; stroke-width: 2px;",
                pickedAt: "2026-06-11T00:00:00.000Z",
              },
            },
          ],
        });
        expect(crop).toHaveBeenCalledExactlyOnceWith(expectedCrop);
        expect(result?.screenshotFailed).toBeUndefined();
        expect(result?.annotation.screenshot).toMatchObject({
          dataUrl: "data:image/png;base64,cropped",
          width: expectedCrop.width,
          height: expectedCrop.height,
        });
      }),
    );
  });

  effectIt.effect("a stale capture from a replaced pick never touches the next pick", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let onPicked: ((event: unknown, ...args: unknown[]) => void) | undefined;
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
          capturePage: vi.fn(() => new Promise(() => {})),
          session: { on: vi.fn() },
          ipc: {
            on: vi.fn((channel: string, listener: typeof onPicked) => {
              if (channel === "preview:element-picked") onPicked = listener;
            }),
            off: vi.fn(),
            removeListener: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const annotation = {
          id: "annotation_1",
          pageUrl: "https://example.com",
          pageTitle: "Example",
          comment: "Tighten this spacing",
          elements: [],
          regions: [{ id: "region_1", rect: { x: 5, y: 6, width: 20, height: 30 } }],
          strokes: [],
          styleChanges: [],
          screenshot: null,
          createdAt: "2026-06-11T00:00:00.000Z",
        };

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const firstPick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        onPicked?.({}, annotation, null, "send");
        yield* Effect.yieldNow;

        const secondPick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Fiber.join(firstPick)).toBeNull();
        webviewSend.mockClear();

        yield* TestClock.adjust("6 seconds");
        yield* Effect.yieldNow;
        expect(webviewSend).not.toHaveBeenCalledWith("preview:annotation-captured");
        expect(secondPick.pollUnsafe()).toBeUndefined();

        onPicked?.({}, { ...annotation, id: "annotation_2" }, null, "attach");
        yield* TestClock.adjust("6 seconds");
        const result = yield* Fiber.join(secondPick);
        expect(result?.annotation.id).toBe("annotation_2");
        expect(result?.submission).toBe("attach");
      }),
    ),
  );

  effectIt.effect("navigates the guest history when the thumb-button ipc fires", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let mouseNavigate: ((event: unknown, payload: unknown) => void) | undefined;
        const goBack = vi.fn();
        const goForward = vi.fn();
        let canGoBack = true;
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoadingMainFrame: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          session: { on: vi.fn() },
          ipc: {
            on: vi.fn((channel: string, listener: typeof mouseNavigate) => {
              if (channel === "preview:mouse-navigate") mouseNavigate = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: {
            canGoBack: () => canGoBack,
            canGoForward: () => true,
            goBack,
            goForward,
          },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_nav");
        yield* manager.registerWebview("tab_nav", 42);
        expect(mouseNavigate).toBeDefined();

        mouseNavigate?.({}, { direction: "back" });
        yield* Effect.yieldNow;
        expect(goBack).toHaveBeenCalledOnce();

        mouseNavigate?.({}, { direction: "forward" });
        yield* Effect.yieldNow;
        expect(goForward).toHaveBeenCalledOnce();

        mouseNavigate?.({}, { direction: "sideways" });
        canGoBack = false;
        mouseNavigate?.({}, { direction: "back" });
        yield* Effect.yieldNow;
        expect(goBack).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(clipboardItemConstructor).toHaveBeenCalledWith({
          "image/png": expect.any(Blob),
        });
        expect(writeClipboard).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);

        createFromPath.mockReturnValueOnce({
          isEmpty: () => true,
          toPNG: () => Buffer.from("invalid"),
        });
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(invalidImageExit)).toBe(true);
        if (Exit.isSuccess(invalidImageExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: "PreviewArtifactImageLoadError",
          artifactPath,
        });

        const writeCause = new Error("clipboard write failed");
        writeClipboard.mockRejectedValueOnce(writeCause);
        const writeExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(writeExit)).toBe(true);
        if (Exit.isSuccess(writeExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(writeExit.cause))).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "copyArtifactToClipboard.write",
          artifactPath,
          cause: writeCause,
        });
      }),
    ),
  );

  /** A webview guest that accepts automation input, minus the tab-specific hooks. */
  const makeAutomationWebContents = (
    id: number,
    sendCommand: (_method: string, _params?: Record<string, unknown>) => Promise<unknown>,
    hooks: {
      readonly onFocusListener?: (_listener: (() => void) | undefined) => void;
      readonly onHumanInput?: (
        _listener: ((_event: unknown, _signal: unknown) => void) | undefined,
      ) => void;
    } = {},
  ) =>
    ({
      id,
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isLoading: () => false,
      isLoadingMainFrame: () => false,
      isDevToolsOpened: () => false,
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
      setAudioMuted: vi.fn(),
      isCurrentlyAudible: () => false,
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "focus") hooks.onFocusListener?.(listener);
      }),
      off: vi.fn((event: string) => {
        if (event === "focus") hooks.onFocusListener?.(undefined);
      }),
      session: { on: vi.fn() },
      ipc: {
        on: vi.fn((channel: string, listener: (_event: unknown, _signal: unknown) => void) => {
          if (channel === "preview:human-input") hooks.onHumanInput?.(listener);
        }),
        off: vi.fn(),
      },
      send: webviewSend,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      setIgnoreMenuShortcuts: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      debugger: {
        isAttached: () => false,
        attach: vi.fn(),
        sendCommand,
        on: vi.fn(),
        off: vi.fn(),
      },
    }) as never;

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const activity: string[] = [];
        let focusListener: (() => void) | undefined;
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            activity.push("mousePressed");
            focusListener?.();
            expect(restoreFocus).toHaveBeenCalledOnce();
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return undefined;
        });
        const restoreFocus = vi.fn();
        const previewWebContents = makeAutomationWebContents(42, sendCommand, {
          onFocusListener: (listener) => {
            focusListener = listener;
          },
          onHumanInput: (listener) => {
            humanInput = listener;
          },
        });
        fromId.mockReturnValue(previewWebContents);
        getFocusedWebContents
          .mockReturnValueOnce({
            id: 7,
            isDestroyed: () => false,
            focus: restoreFocus,
          } as never)
          .mockReturnValueOnce(previewWebContents);

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            activity.push(event.phase);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(restoreFocus).toHaveBeenCalledOnce();
        expect(focusListener).toBeUndefined();
      }),
    ),
  );

  describe("file pickers and downloads", () => {
    const settle = TestClock.adjust(0);
    const viewport = { result: { value: { width: 800, height: 600 } } };

    const makeGuest = (
      sendCommand: (_method: string, _params?: Record<string, unknown>) => Promise<unknown>,
    ) => {
      let humanInput: ((_event: unknown, _signal: unknown) => void) | undefined;
      let willDownload: ((_event: unknown, _item: unknown, _source: unknown) => void) | undefined;
      let debuggerMessage:
        | ((_event: unknown, _method: string, _params: unknown) => void)
        | undefined;
      const guest = makeAutomationWebContents(42, sendCommand, {
        onHumanInput: (listener) => {
          humanInput = listener;
        },
      }) as unknown as {
        session: { on: ReturnType<typeof vi.fn> };
        debugger: { on: ReturnType<typeof vi.fn> };
      };
      guest.session.on = vi.fn((event: string, listener: typeof willDownload) => {
        if (event === "will-download") willDownload = listener;
      });
      guest.debugger.on = vi.fn((event: string, listener: typeof debuggerMessage) => {
        if (event === "message") debuggerMessage = listener;
      });
      return {
        guest: guest as unknown as Electron.WebContents,
        humanClick: () => humanInput?.({}, { kind: "pointer", x: 5, y: 5, button: 0 }),
        openFileChooser: (mode: "selectSingle" | "selectMultiple") =>
          debuggerMessage?.({}, "Page.fileChooserOpened", { backendNodeId: 77, mode }),
        startDownload: (name: string) => {
          let finish: ((_event: unknown, _state: string) => void) | undefined;
          const item = {
            getFilename: () => name,
            getURL: () => `https://example.com/${name}`,
            getMimeType: () => "text/csv",
            getTotalBytes: () => 3,
            getReceivedBytes: () => 3,
            setSavePath: vi.fn(),
            once: vi.fn((_event: string, listener: typeof finish) => {
              finish = listener;
            }),
          };
          willDownload?.({}, item, { id: 42 });
          return { item, finish: (state: string) => finish?.({}, state) };
        },
      };
    };

    const openAgentTab = (manager: PreviewManager.PreviewManager["Service"], guest: unknown) =>
      Effect.gen(function* () {
        fromId.mockReturnValue(guest as Electron.WebContents);
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 10, y: 10 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        return yield* Fiber.join(click);
      });

    effectIt.effect(
      "keeps an agent's download from showing a Save dialog and hands it over once",
      () =>
        withManager((manager) =>
          Effect.gen(function* () {
            const browser = makeGuest(async (method) =>
              method === "Runtime.evaluate" ? viewport : undefined,
            );
            yield* openAgentTab(manager, browser.guest);
            const download = browser.startDownload("report.csv");
            const savePath = download.item.setSavePath.mock.calls[0]?.[0] as string;
            expect(savePath).toMatch(
              /^\/tmp\/t3\/dev\/browser-artifacts\/transfers\/tab_1\/download-/,
            );
            download.finish("completed");
            readFile.mockReturnValueOnce(new TextEncoder().encode("a,b"));

            const received = yield* manager.automationDownload("tab_1");
            expect(received).toMatchObject({
              fileName: "report.csv",
              mimeType: "text/csv",
              url: "https://example.com/report.csv",
            });
            expect(new TextDecoder().decode(received.data)).toBe("a,b");
            expect(readFile).toHaveBeenCalledWith(savePath);

            const nothingLeft = yield* manager
              .automationDownload("tab_1", 100)
              .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
            yield* TestClock.adjust(200);
            expect(yield* Fiber.join(nothingLeft)).toMatchObject({
              failure: { _tag: "PreviewFileTransferError", reason: "no-download" },
            });
          }),
        ),
    );

    effectIt.effect(
      "captures a direct agent navigation download without waiting for a page load",
      () =>
        withManager((manager) =>
          Effect.gen(function* () {
            const browser = makeGuest(async () => undefined);
            const download = vi.fn(() => browser.startDownload("report.csv"));
            Object.assign(browser.guest, {
              loadURL: vi.fn(async () => {
                download();
                throw new Error("ERR_ABORTED (-3)");
              }),
            });
            fromId.mockReturnValue(browser.guest);
            yield* manager.createTab("tab_1");
            yield* manager.registerWebview("tab_1", 42);

            expect(yield* manager.navigate("tab_1", "https://example.com/report.csv", true)).toBe(
              true,
            );
            const transfer = download.mock.results[0]?.value;
            expect(transfer?.item.setSavePath).toHaveBeenCalledOnce();
            transfer?.finish("completed");
            readFile.mockReturnValueOnce(new TextEncoder().encode("a,b"));
            const received = yield* manager.automationDownload("tab_1");
            expect(received.fileName).toBe("report.csv");
            expect(new TextDecoder().decode(received.data)).toBe("a,b");
          }),
        ),
    );

    effectIt.effect("preserves a direct human navigation's Save dialog", () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const browser = makeGuest(async () => undefined);
          const download = vi.fn(() => browser.startDownload("report.csv"));
          Object.assign(browser.guest, {
            loadURL: vi.fn(async () => {
              download();
            }),
          });
          fromId.mockReturnValue(browser.guest);
          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          yield* manager.navigate("tab_1", "https://example.com/agent.csv", true);
          download.mockClear();
          yield* manager.navigate("tab_1", "https://example.com/report.csv");
          expect(download.mock.results[0]?.value?.item.setSavePath).not.toHaveBeenCalled();
        }),
      ),
    );

    effectIt.effect("leaves a download to the Save dialog once a person uses the tab", () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const browser = makeGuest(async (method) =>
            method === "Runtime.evaluate" ? viewport : undefined,
          );
          yield* openAgentTab(manager, browser.guest);
          browser.humanClick();
          yield* settle;
          const download = browser.startDownload("report.csv");
          expect(download.item.setSavePath).not.toHaveBeenCalled();
        }),
      ),
    );

    effectIt.effect(
      "reports a picker emitted after the input response, before the renderer barrier completes",
      () =>
        withManager((manager) =>
          Effect.gen(function* () {
            const browser = makeGuest(async (method, params) => {
              if (method === "Runtime.evaluate" && params?.["expression"] === "void 0") {
                browser.openFileChooser("selectSingle");
              }
              return method === "Runtime.evaluate" ? viewport : undefined;
            });
            const result = yield* openAgentTab(manager, browser.guest);
            expect(result).toEqual({ fileChooser: { multiple: false } });
          }),
        ),
    );

    effectIt.effect("holds a picker the agent opened and answers it with uploaded files", () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const sendCommand = vi.fn(async (method: string) =>
            method === "Runtime.evaluate" ? viewport : undefined,
          );
          const browser = makeGuest(sendCommand);
          yield* openAgentTab(manager, browser.guest);
          browser.openFileChooser("selectSingle");
          yield* settle;
          expect(showOpenDialog).not.toHaveBeenCalled();

          const tooMany = yield* manager
            .automationUpload("tab_1", {
              files: [
                { name: "a.txt", data: new Uint8Array([1]) },
                { name: "b.txt", data: new Uint8Array([2]) },
              ],
            })
            .pipe(Effect.result);
          expect(tooMany).toMatchObject({ failure: { reason: "single-file" } });

          // The rejected attempt leaves the picker waiting for a corrected one.
          const names = yield* manager.automationUpload("tab_1", {
            files: [{ name: "../notes.txt", data: new Uint8Array([1]) }],
          });
          expect(names).toEqual(["notes.txt"]);
          const [writtenPath] = writeFile.mock.calls.at(-1)!;
          expect(writtenPath).toMatch(/\/transfers\/tab_1\/uploads\/[^/]+\/0\/notes\.txt$/);
          expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
            files: [writtenPath],
            backendNodeId: 77,
          });

          const none = yield* manager
            .automationUpload("tab_1", { files: [{ name: "a.txt", data: new Uint8Array([1]) }] })
            .pipe(Effect.result);
          expect(none).toMatchObject({ failure: { reason: "no-file-chooser" } });
        }),
      ),
    );

    effectIt.effect("sets files directly on a targeted file input", () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
            if (method === "Runtime.evaluate") {
              if (params?.["returnByValue"] === false) {
                return { result: { objectId: "file-input", subtype: "node" } };
              }
              return String(params?.["expression"]).includes("__t3PlaywrightInjected)")
                ? { result: { value: true } }
                : viewport;
            }
            if (method === "Runtime.callFunctionOn") return { result: { value: true } };
            return undefined;
          });
          const browser = makeGuest(sendCommand);
          fromId.mockReturnValue(browser.guest);
          yield* manager.createTab("tab_1");
          yield* manager.registerWebview("tab_1", 42);
          const names = yield* manager.automationUpload("tab_1", {
            locator: "input[type=file]",
            files: [
              { name: "a.txt", data: new Uint8Array([1]) },
              { name: "a.txt", data: new Uint8Array([2]) },
            ],
          });
          expect(names).toEqual(["a.txt", "a.txt"]);
          const setFiles = sendCommand.mock.calls.find(
            ([method]) => method === "DOM.setFileInputFiles",
          );
          const setFilesParams = setFiles?.[1] as
            | { readonly objectId?: string; readonly files?: Array<string> }
            | undefined;
          expect(setFilesParams?.objectId).toBe("file-input");
          expect(new Set(setFilesParams?.files).size).toBe(2);
        }),
      ),
    );

    effectIt.effect("shows an open dialog for a picker a person opens", () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const sendCommand = vi.fn(async (method: string) => {
            if (method === "Runtime.evaluate") return viewport;
            if (method === "DOM.resolveNode") return { object: { objectId: "picker" } };
            if (method === "Runtime.callFunctionOn") {
              return { result: { value: { accept: ".csv", directory: false } } };
            }
            return undefined;
          });
          showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/Users/me/a.csv"] });
          const browser = makeGuest(sendCommand);
          yield* openAgentTab(manager, browser.guest);
          browser.humanClick();
          yield* settle;
          browser.openFileChooser("selectMultiple");
          yield* settle;
          yield* settle;

          expect(showOpenDialog).toHaveBeenCalledWith({
            properties: ["openFile", "multiSelections"],
            filters: [{ name: "Accepted files", extensions: ["csv"] }],
          });
          expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
            files: ["/Users/me/a.csv"],
            backendNodeId: 77,
          });
          const upload = yield* manager
            .automationUpload("tab_1", { files: [{ name: "a.txt", data: new Uint8Array([1]) }] })
            .pipe(Effect.result);
          expect(upload).toMatchObject({ failure: { reason: "no-file-chooser" } });
        }),
      ),
    );
  });

  effectIt.effect("never restores agent click focus to another agent's tab", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let focusListener: (() => void) | undefined;
        let humanInput: ((_event: unknown, _signal: unknown) => void) | undefined;
        const viewportCommand = async (method: string) =>
          method === "Runtime.evaluate"
            ? { result: { value: { width: 800, height: 600 } } }
            : undefined;
        let dispatched = false;
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            dispatched = true;
            focusListener?.();
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return await viewportCommand(method);
        });
        const drivenWebContents = makeAutomationWebContents(42, sendCommand, {
          onFocusListener: (listener) => {
            focusListener = listener;
          },
          onHumanInput: (listener) => {
            humanInput = listener;
          },
        });
        // A second agent session's tab, focused because its own click is in
        // flight. Handing focus there would drag the caret into a webview the
        // human is not using, so it is not a restore target.
        const otherAgentFocus = vi.fn();
        const otherAgentWebContents = makeAutomationWebContents(43, vi.fn(viewportCommand));
        Object.assign(otherAgentWebContents, { focus: otherAgentFocus });
        fromId.mockImplementation((id?: number) =>
          id === 43 ? otherAgentWebContents : drivenWebContents,
        );
        // Before the dispatch the other agent's guest holds focus; the dispatch
        // moves it to the driven guest, which is when the restore guard fires.
        getFocusedWebContents.mockImplementation(() =>
          dispatched ? drivenWebContents : otherAgentWebContents,
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_2", 43);

        const click = yield* manager
          .automationClick("tab_1", { x: 20, y: 20 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        // The click reaches its cursor sleeps only after attaching a control
        // session to each guest, so keep advancing until it settles.
        for (let attempt = 0; attempt < 5; attempt += 1) yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 20,
          y: 20,
          button: "left",
          clickCount: 1,
        });
        expect(otherAgentFocus).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("types and presses keys in background webviews without taking app focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failKeyDown = false;
        let routeToIframe = false;
        let interruptFrameKeyDown = false;
        let holdKeyUp = false;
        let releaseKeyUp: (() => void) | undefined;
        let notifyKeyUpQueued: (() => void) | undefined;
        const keyUpQueued = new Promise<void>((resolve) => {
          notifyKeyUpQueued = resolve;
        });
        const listeners = new Map<string, (event: unknown) => void>();
        const eventCounts = new Map<string, number>();
        const animationFrames = new Map<number, () => void>();
        let animationFrameId = 0;
        const renderFrame = () => {
          const callbacks = [...animationFrames.values()];
          animationFrames.clear();
          callbacks.forEach((callback) => callback());
        };
        const frameContext = NodeVM.createContext({
          performance: { eventCounts },
          requestAnimationFrame: (callback: () => void) => {
            const id = ++animationFrameId;
            animationFrames.set(id, callback);
            return id;
          },
          cancelAnimationFrame: (id: number) => animationFrames.delete(id),
          window: {
            addEventListener: (type: string, listener: (event: unknown) => void) =>
              listeners.set(type, listener),
            removeEventListener: (type: string) => listeners.delete(type),
          },
        });
        const frame = {
          executeJavaScript: vi.fn(async (expression: string) =>
            NodeVM.runInContext(expression, frameContext),
          ),
        };
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(
          async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
            if (method === "Runtime.evaluate") {
              if (params?.["returnByValue"] === true) return { result: { value: { ok: true } } };
              return {
                result:
                  routeToIframe && !sessionId
                    ? { objectId: "focused-iframe-object" }
                    : { subtype: "null" },
              };
            }
            if (method === "DOM.describeNode") return { node: { frameId: "focused-frame" } };
            if (method === "Target.getTargets")
              return {
                targetInfos: [
                  { targetId: "unrelated-frame", type: "iframe" },
                  { targetId: "focused-frame", type: "iframe" },
                ],
              };
            if (method === "Target.attachToTarget") return { sessionId: "child-session" };
            if (method === "Input.dispatchKeyEvent" && params?.["type"] !== "keyUp") {
              if (failKeyDown) throw new Error("key dispatch failed");
              if (interruptFrameKeyDown)
                humanInput?.({}, { kind: "pointer", x: 80, y: 40, button: 0 });
            }
            return undefined;
          },
        );
        const sendInputEvent = vi.fn((input: Electron.KeyboardInputEvent) => {
          const signal = {
            kind: "key",
            key: input.keyCode,
            code: input.keyCode === "!" ? "Digit1" : `Key${input.keyCode.toUpperCase()}`,
          };
          if (input.type === "keyUp") {
            const deliver = () => {
              eventCounts.set("keyup", (eventCounts.get("keyup") ?? 0) + 1);
              renderFrame();
            };
            if (holdKeyUp) {
              releaseKeyUp = deliver;
              notifyKeyUpQueued?.();
            } else {
              queueMicrotask(deliver);
            }
          }
          if (input.type !== "keyDown") return;
          if (failKeyDown) throw new Error("key dispatch failed");
          humanInput?.({}, signal);
        });
        const focus = vi.fn();
        const restoreFocus = vi.fn();
        getFocusedWebContents.mockReturnValue({
          id: 7,
          isDestroyed: () => false,
          focus: restoreFocus,
        } as never);
        fromId.mockReturnValue({
          id: 42,
          mainFrame: { framesInSubtree: [frame] },
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          focus,
          sendInputEvent,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          session: { on: vi.fn() },
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_input");
        yield* manager.registerWebview("tab_input", 42);
        yield* manager.automationType("tab_input", { text: "hello", clear: true });
        yield* manager.automationType("tab_input", { text: "", clear: true });
        yield* manager.automationPress("tab_input", { key: "x" });

        const calls = sendCommand.mock.calls;
        const methods = calls.map(([method]) => method);
        const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");
        const focusOnIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
        );
        const focusOffIndex = calls.findIndex(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
        );
        const typeEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('document.execCommand("insertText"'),
        );
        expect(typeEvaluation).toBeDefined();
        const clearOnlyEvaluation = sendCommand.mock.calls.find(
          ([method, params]) =>
            method === "Runtime.evaluate" &&
            typeof params === "object" &&
            params !== null &&
            "expression" in params &&
            typeof params.expression === "string" &&
            params.expression.includes('const text = ""') &&
            params.expression.includes("Object.getOwnPropertyDescriptor"),
        );
        expect(clearOnlyEvaluation).toBeDefined();
        expect(methods).not.toContain("Input.insertText");
        expect(enableIndex).toBeGreaterThanOrEqual(0);
        expect(focus).not.toHaveBeenCalled();
        expect(methods).not.toContain("Page.bringToFront");
        expect(methods).not.toContain("Input.dispatchKeyEvent");
        expect(enableIndex).toBeLessThan(focusOnIndex);
        expect(sendCommand.mock.invocationCallOrder[focusOnIndex]).toBeLessThan(
          sendInputEvent.mock.invocationCallOrder[0]!,
        );
        expect(sendInputEvent.mock.invocationCallOrder[2]).toBeLessThan(
          sendCommand.mock.invocationCallOrder[focusOffIndex]!,
        );
        expect(sendInputEvent.mock.calls.map(([input]) => input.type)).toEqual([
          "keyDown",
          "char",
          "keyUp",
        ]);
        expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });
        expect(listeners.size).toBe(0);
        expect(animationFrames.size).toBe(0);

        sendCommand.mockClear();
        sendInputEvent.mockClear();
        getFocusedWebContents.mockReturnValue(null);
        holdKeyUp = true;
        const backgroundPress = yield* manager
          .automationPress("tab_input", { key: "x" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => keyUpQueued);
        expect(sendCommand).not.toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        renderFrame();
        expect(animationFrames.size).toBe(1);
        releaseKeyUp?.();
        yield* Fiber.join(backgroundPress);
        expect(listeners.size).toBe(0);
        expect(animationFrames.size).toBe(0);
        expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
        holdKeyUp = false;

        // Both native failures and expected-input matching must leave focus emulation off.
        for (const key of ["y", "!"]) {
          sendCommand.mockClear();
          sendInputEvent.mockClear();
          failKeyDown = key === "y";
          const exit = yield* Effect.exit(manager.automationPress("tab_input", { key }));
          expect(Exit.isFailure(exit)).toBe(failKeyDown);
          expect(sendInputEvent.mock.calls.map(([input]) => input.type)).toEqual(
            failKeyDown ? ["keyDown", "keyUp"] : ["keyDown", "char", "keyUp"],
          );
          expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: false,
          });
        }

        routeToIframe = true;
        sendInputEvent.mockClear();
        for (const outcome of ["success", "failure", "interrupted"]) {
          sendCommand.mockClear();
          failKeyDown = outcome === "failure";
          interruptFrameKeyDown = outcome === "interrupted";
          const exit = yield* Effect.exit(
            manager.automationPress("tab_input", {
              key: outcome === "success" ? "Enter" : "x",
            }),
          );
          expect(Exit.isSuccess(exit)).toBe(outcome === "success");
          if (outcome === "interrupted" && Exit.isFailure(exit)) {
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
              _tag: "PreviewAutomationControlInterruptedError",
            });
          }
          expect(sendInputEvent).not.toHaveBeenCalled();
          expect(sendCommand).toHaveBeenCalledWith("Target.attachToTarget", {
            targetId: "focused-frame",
            flatten: true,
          });
          expect(
            sendCommand.mock.calls
              .filter(([method]) => method === "Input.dispatchKeyEvent")
              .map(([, params, sessionId]) => ({ type: params?.["type"], sessionId })),
          ).toEqual([
            { type: "keyDown", sessionId: "child-session" },
            { type: "keyUp", sessionId: "child-session" },
          ]);
          expect(sendCommand).toHaveBeenCalledWith(
            "Emulation.setFocusEmulationEnabled",
            { enabled: false },
            "child-session",
          );
          expect(sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", {
            sessionId: "child-session",
          });
        }
        expect(focus).not.toHaveBeenCalled();
        expect(restoreFocus).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          session: { on: vi.fn() },
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";
        const exceptionDetails = {
          text,
          exception: { description: "" },
        };
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isLoadingMainFrame: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setAudioMuted: vi.fn(),
          isCurrentlyAudible: () => false,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          session: { on: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setIgnoreMenuShortcuts: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );

  effectIt.effect(
    "blocks arbitrary evaluation after password autofill until a full navigation",
    () => {
      const credentialLayer = Layer.mock(BrowserCredentials.BrowserCredentials)({
        list: Effect.succeed([]),
        save: () => Effect.die("unused in Manager tests"),
        delete: () => Effect.void,
        resolveForFill: () => Effect.succeed({ username: "hamish", password: "credential-secret" }),
      });
      return withManager(
        (manager) =>
          Effect.gen(function* () {
            const webContentsListeners = new Map<
              string,
              (...args: ReadonlyArray<unknown>) => void
            >();
            let autofillPending = true;
            const sendCommand = vi.fn(async (method: string) => {
              if (method !== "Runtime.evaluate") return undefined;
              if (autofillPending) {
                autofillPending = false;
                return {
                  result: {
                    value: {
                      filled: true,
                      filledPassword: true,
                      filledUsername: true,
                    },
                  },
                };
              }
              return { result: { value: "safe-after-navigation" } };
            });
            fromId.mockReturnValue({
              id: 42,
              isDestroyed: () => false,
              getType: () => "webview",
              getURL: () => "https://example.com/login",
              getTitle: () => "Example",
              isLoading: () => false,
              isLoadingMainFrame: () => false,
              isDevToolsOpened: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              setAudioMuted: vi.fn(),
              isCurrentlyAudible: () => false,
              on: vi.fn((event: string, listener: (...args: ReadonlyArray<unknown>) => void) => {
                webContentsListeners.set(event, listener);
              }),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              session: { on: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setIgnoreMenuShortcuts: vi.fn(),
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => false,
                attach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as never);

            yield* manager.createTab("tab_credential");
            yield* manager.registerWebview("tab_credential", 42);
            expect(
              yield* manager.automationAutofill("tab_credential", {
                environmentId: "env_a",
                profile: null,
              }),
            ).toMatchObject({ filled: true, origin: "https://example.com" });

            const protectedExit = yield* Effect.exit(
              manager.automationEvaluate("tab_credential", {
                expression: 'document.querySelector("input[type=password]")?.value',
              }),
            );
            expect(Exit.isFailure(protectedExit)).toBe(true);
            if (Exit.isFailure(protectedExit)) {
              expect(Option.getOrThrow(Cause.findErrorOption(protectedExit.cause))).toMatchObject({
                _tag: "PreviewAutomationCredentialProtectedError",
                tabId: "tab_credential",
              });
            }

            webContentsListeners.get("did-navigate")?.();
            yield* Effect.yieldNow;
            expect(
              yield* manager.automationEvaluate("tab_credential", { expression: "document.title" }),
            ).toBe("safe-after-navigation");

            const evaluatedExit = yield* Effect.exit(
              manager.automationAutofill("tab_credential", {
                environmentId: "env_a",
                profile: null,
              }),
            );
            expect(Exit.isFailure(evaluatedExit)).toBe(true);
            if (Exit.isFailure(evaluatedExit)) {
              expect(Option.getOrThrow(Cause.findErrorOption(evaluatedExit.cause))).toMatchObject({
                _tag: "PreviewAutomationCredentialAutofillBlockedError",
                tabId: "tab_credential",
              });
            }
          }),
        makeLayer(credentialLayer),
      );
    },
  );
});

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

describe("Preview automation diagnostics", () => {
  it("keeps browser exception detail out of structural diagnostics", () => {
    const secret = "unrelated-browser-payload-secret";
    const detail = "ReferenceError: missingValue is not defined";
    const cause = {
      text: "Uncaught Error",
      exception: { description: detail },
      unsafePayload: secret,
    };
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_1",
      detailKind: "exception-description",
      detailLength: detail.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error.message).toBe("Preview JavaScript evaluation failed in tab tab_1");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret);
    expect("detail" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    );
  });

  it("reports the match count without leaking page content for an ambiguous selector", () => {
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: 27,
      reasonLength: 100,
      cause: {
        message: "strict mode violation: locator('secret') resolved to 2 elements: secret HTML",
      },
    });
    expect(error.message).toBe(
      "Preview automation click matched 2 elements; use a more specific selector from preview_snapshot.",
    );
    expect(error.message).not.toContain("secret");
  });

  it("retains bounded selector diagnostics without exposing selector or reason text", () => {
    const selector = "role=button[name='selector-secret']";
    const reason = "Unexpected token near reason-secret";
    const cause = { invalidSelector: true as const, message: reason };
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error).toMatchObject({
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
    });
    expect(error.detail).toEqual({
      selectorKind: "locator",
      selectorLength: selector.length,
    });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(encodedDiagnostics)).not.toContain("secret");
    expect("selector" in error).toBe(false);
    expect("reason" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    );
  });

  it("does not retain a missing target locator", () => {
    const selector = "[data-token='target-secret']";
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: "scroll",
      tabId: "tab_1",
      selectorKind: "selector",
      selectorLength: selector.length,
    });

    expect(error.message).not.toContain(selector);
    expect(JSON.stringify(error)).not.toContain(selector);
    expect("locator" in error).toBe(false);
  });
});
