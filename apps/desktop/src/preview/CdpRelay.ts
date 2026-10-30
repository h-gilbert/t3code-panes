// Electron allows one debugger per webContents; share the manager's attachment.

export interface CdpRelayTarget {
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
    /** The extra session that sent it, such as a viewer's; the main connection has none. */
    owner?: string,
  ) => Promise<unknown>;
  readonly sessionDetached?: (owner: string) => void;
  /** The page's own CDP target id; Playwright keys the main frame by it. */
  readonly targetId: () => Promise<string>;
  readonly url: () => string;
  readonly title: () => string;
  readonly userAgent: () => string;
  /** The desktop and its server share a disk; download paths need no translation. */
  readonly setDownloadDirectory: (directory: string | null) => void;
  /** Composite hidden guests only while a capture or viewer needs frames. */
  readonly setFrameActivity?: (active: boolean) => void;
}

export interface CdpRelayConnection {
  readonly receive: (raw: string) => void;
  readonly event: (method: string, params: unknown, sessionId: string | undefined) => void;
  readonly dispose: () => void;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

const BROWSER_CONTEXT_ID = "t3-preview";
const ANNOUNCE = Symbol("announce");
const PAGE_SESSION_ID = "t3-preview-page";

const ACKNOWLEDGED = new Set([
  "Target.setDiscoverTargets",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.cancelDownload",
]);

export function createCdpRelayConnection(
  target: CdpRelayTarget,
  write: (message: string) => void,
): CdpRelayConnection {
  const send = (message: Record<string, unknown>) => write(JSON.stringify(message));
  let attached = false;
  let runtimeReset: Promise<unknown> | undefined;
  let disposed = false;
  let captures = 0;
  let frameActivity = false;
  const screencasts = new Set<string>();
  const syncFrameActivity = () => {
    const active = !disposed && (captures > 0 || screencasts.size > 0);
    if (active === frameActivity) return;
    frameActivity = active;
    target.setFrameActivity?.(active);
  };
  /**
   * Sessions this relay invented. Extra page sessions (Playwright's
   * `newCDPSession`) all reach the one real debugger session, so each gets the
   * page's events; other ids are the page's own child sessions, such as iframes.
   */
  const sessions = new Map<string, "browser" | "page">([[PAGE_SESSION_ID, "page"]]);
  let sessionSequence = 0;
  const newSession = (kind: "browser" | "page") => {
    const sessionId = `t3-preview-${kind}-${++sessionSequence}`;
    sessions.set(sessionId, kind);
    return sessionId;
  };
  const targetInfo = async () => ({
    targetId: await target.targetId(),
    type: "page",
    title: target.title(),
    url: target.url(),
    attached: true,
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  });

  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case "Browser.setDownloadBehavior": {
        const directory = command.params?.["downloadPath"];
        const allowed = command.params?.["behavior"] !== "deny" && typeof directory === "string";
        target.setDownloadDirectory(allowed ? directory : null);
        const { browserContextId: _ignored, ...params } = command.params ?? {};
        return target.send("Browser.setDownloadBehavior", params, undefined);
      }
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Electron",
          revision: "",
          userAgent: target.userAgent(),
          jsVersion: "",
        };
      case "Target.getTargetInfo":
        return {
          targetInfo: {
            targetId: "browser",
            type: "browser",
            title: "",
            url: "",
            attached: true,
            canAccessOpener: false,
          },
        };
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.getTargets":
        return { targetInfos: [await targetInfo()] };
      case "Target.attachToBrowserTarget":
        return { sessionId: newSession("browser") };
      case "Target.attachToTarget": {
        const targetId = command.params?.["targetId"];
        if (targetId !== (await target.targetId()))
          throw new Error("Only this preview tab's page can be attached.");
        return { sessionId: newSession("page") };
      }
      case "Target.detachFromTarget": {
        const sessionId = command.params?.["sessionId"];
        if (typeof sessionId === "string" && sessionId !== PAGE_SESSION_ID) {
          sessions.delete(sessionId);
          if (typeof sessionId === "string") screencasts.delete(sessionId);
          syncFrameActivity();
          target.sessionDetached?.(sessionId);
        }
        return {};
      }
      case "Target.setAutoAttach": {
        if (attached) return {};
        attached = true;
        const info = await targetInfo();
        return {
          [ANNOUNCE]: {
            method: "Target.attachedToTarget",
            params: { sessionId: PAGE_SESSION_ID, targetInfo: info, waitingForDebugger: false },
          },
        };
      }
      default:
        throw new Error(`Not supported for a desktop preview tab: ${command.method}`);
    }
  };

  const pageCommand = (command: CdpCommand): Promise<unknown> => {
    const child = sessions.get(command.sessionId!) === "page" ? undefined : command.sessionId;
    const owner =
      child === undefined && command.sessionId !== PAGE_SESSION_ID ? command.sessionId : undefined;
    if (command.method === "Page.captureScreenshot") {
      captures += 1;
      syncFrameActivity();
      return (async () => {
        try {
          return await target.send(command.method, command.params ?? {}, child, owner);
        } finally {
          captures -= 1;
          syncFrameActivity();
        }
      })();
    }
    if (command.method === "Page.startScreencast") {
      screencasts.add(command.sessionId!);
      syncFrameActivity();
      return (async () => {
        try {
          return await target.send(command.method, command.params ?? {}, child, owner);
        } catch (cause) {
          screencasts.delete(command.sessionId!);
          syncFrameActivity();
          throw cause;
        }
      })();
    }
    if (command.method === "Page.stopScreencast") {
      screencasts.delete(command.sessionId!);
      syncFrameActivity();
    }
    if (command.method === "Runtime.enable" && command.sessionId === PAGE_SESSION_ID) {
      // The manager enabled Runtime before this relay existed. Enabling it again
      // does not replay existing contexts, leaving Playwright's main-world reads
      // waiting forever. Refresh once per connection, before acknowledging enable.
      runtimeReset ??= target.send("Runtime.disable", {}, undefined);
      return runtimeReset.then(() =>
        target.send("Runtime.enable", command.params ?? {}, undefined),
      );
    }
    // Child frames/workers pause on auto-attach until resumed; only the main page can skip this command.
    if (command.method === "Runtime.runIfWaitingForDebugger" && child === undefined) {
      return Promise.resolve({});
    }
    // Playwright asks for this on every page; the host emulates focus only while it is in use.
    if (command.method === "Emulation.setFocusEmulationEnabled") return Promise.resolve({});
    return target.send(command.method, command.params ?? {}, child, owner);
  };

  return {
    dispose: () => {
      disposed = true;
      screencasts.clear();
      syncFrameActivity();
    },
    receive: (raw) => {
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const result =
        command.sessionId === undefined || sessions.get(command.sessionId) === "browser"
          ? browserCommand(command)
          : pageCommand(command);
      const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      // Reply as commands finish so slow commands cannot block later replies.
      void result.then(
        (value) => {
          const announce =
            typeof value === "object" && value !== null && ANNOUNCE in value
              ? (value as { [ANNOUNCE]: Record<string, unknown> })[ANNOUNCE]
              : undefined;
          send({ id: command.id, result: announce ? {} : (value ?? {}), ...route });
          if (announce) send(announce);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          }),
      );
    },
    event: (method, params, sessionId) => {
      if (!attached) return;
      // Download events are the browser's; Playwright listens on its root session.
      if (method.startsWith("Browser.download")) {
        send({ method, params });
        return;
      }
      // Electron reports the page's own events with an empty session id.
      if (sessionId) {
        send({ method, params, sessionId });
        return;
      }
      for (const [id, kind] of sessions)
        if (kind === "page") send({ method, params, sessionId: id });
    },
  };
}
