import {
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewAutomationClickInputSchema,
  DesktopPreviewAutomationDownloadInputSchema,
  DesktopPreviewAutomationUploadInputSchema,
  DesktopPreviewDownloadedFileSchema,
  PreviewAutomationInputResult,
  DesktopPreviewAutomationEvaluateInputSchema,
  DesktopPreviewAutomationPressInputSchema,
  DesktopPreviewAutomationScrollInputSchema,
  DesktopPreviewAutomationStatusSchema,
  DesktopPreviewAutomationTypeInputSchema,
  DesktopPreviewAutomationWaitForInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewRecordingArtifactSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewScreenshotArtifactSchema,
  DesktopPreviewSetAudioMutedInputSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  BrowserImportResult,
  BrowserImportSource,
  DesktopPreviewClearDataInputSchema,
  DesktopPreviewImportCookiesInputSchema,
  DesktopPreviewCreateTabInputSchema,
  DesktopPreviewAutomationRelayInputSchema,
  DesktopPreviewAutomationRelayResponseInputSchema,
  DesktopPreviewTabInputSchema,
  DesktopBrowserAutofillInputSchema,
  DesktopBrowserAutofillResultSchema,
  DesktopBrowserCredentialSaveInputSchema,
  DesktopBrowserCredentialSummarySchema,
  DesktopPreviewWebviewConfigSchema,
  PreviewAnnotationSubmissionResultSchema,
  PreviewAutomationSnapshot,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { webContents } from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../../preview/WebviewPreferences.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const installPreviewEventForwarding = Effect.fn(
  "desktop.ipc.preview.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const manager = yield* PreviewManager.PreviewManager;
  yield* manager.subscribeStateChanges((tabId, state) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, tabId, state),
  );
  yield* manager.subscribeRecordingFrames((frame) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, frame),
  );
  yield* manager.subscribePointerEvents((event) =>
    electronWindow.sendAll(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, event),
  );
});

export const createTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREATE_TAB_CHANNEL,
  payload: DesktopPreviewCreateTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.createTab")(function* (
    { tabId, zoomFactor, colorScheme },
    event,
  ) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.createTab(tabId, { zoomFactor, colorScheme }, event?.sender.id);
  }),
});

export const closeTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.closeTab")(function* ({ tabId }, event) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.closeTab(tabId, event?.sender.id);
  }),
});

export const getHostWebContentsId = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.PREVIEW_HOST_ID_CHANNEL,
  result: Schema.Number,
  handler: (event) => Effect.succeed(event.sender.id),
});

export class PreviewAutomationRelayError extends Schema.TaggedError<PreviewAutomationRelayError>()(
  "PreviewAutomationRelayError",
  { hostWebContentsId: Schema.Number, reason: Schema.String },
) {
  override get message(): string {
    return `Could not reach the window that owns this browser tab: ${this.reason}`;
  }
}

export const claimTab = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLAIM_TAB_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.preview.claimTab")(function* ({ tabId }, event) {
    if (!event) return false;
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.claimTab(tabId, event.sender.id);
  }),
});

const pendingAutomationRelays = new Map<
  string,
  { readonly hostWebContentsId: number; readonly resolve: (response: unknown) => void }
>();

/** Allows for the owner's own host wait and IPC after the request's budget. */
const AUTOMATION_RELAY_GRACE_MS = 5_000;

export const relayAutomation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_RELAY_CHANNEL,
  payload: DesktopPreviewAutomationRelayInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.relayAutomation")(function* (
    { tabId, environmentId, timeoutMs, request },
    event,
  ) {
    const manager = yield* PreviewManager.PreviewManager;
    const hostWebContentsId = yield* manager.getTabHostWebContentsId(tabId);
    const target = hostWebContentsId === null ? undefined : webContents.fromId(hostWebContentsId);
    if (
      hostWebContentsId === null ||
      !target ||
      target.isDestroyed() ||
      target.id === event?.sender.id
    ) {
      return yield* new PreviewAutomationRelayError({
        hostWebContentsId: hostWebContentsId ?? -1,
        reason: "no other window owns the tab",
      });
    }
    const relayId = NodeCrypto.randomUUID();
    const relayTimeoutMs = timeoutMs + AUTOMATION_RELAY_GRACE_MS;
    return yield* Effect.callback<unknown, PreviewAutomationRelayError>((resume) => {
      const cleanup = () => {
        target.off("destroyed", onDestroyed);
        pendingAutomationRelays.delete(relayId);
      };
      const onDestroyed = () => {
        cleanup();
        resume(
          Effect.fail(
            new PreviewAutomationRelayError({ hostWebContentsId, reason: "the window closed" }),
          ),
        );
      };
      pendingAutomationRelays.set(relayId, {
        hostWebContentsId,
        resolve: (response) => {
          cleanup();
          resume(Effect.succeed(response));
        },
      });
      target.once("destroyed", onDestroyed);
      target.send(IpcChannels.PREVIEW_AUTOMATION_RELAY_REQUEST_CHANNEL, {
        relayId,
        environmentId,
        request,
      });
      return Effect.sync(cleanup);
    }).pipe(
      Effect.timeoutOrElse({
        duration: relayTimeoutMs,
        orElse: () =>
          Effect.fail(
            new PreviewAutomationRelayError({
              hostWebContentsId,
              reason: `no response within ${relayTimeoutMs}ms`,
            }),
          ),
      }),
    );
  }),
});

export const respondToAutomationRelay = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_RELAY_RESPONSE_CHANNEL,
  payload: DesktopPreviewAutomationRelayResponseInputSchema,
  result: Schema.Void,
  handler: ({ relayId, response }, event) =>
    Effect.sync(() => {
      const pending = pendingAutomationRelays.get(relayId);
      // Only the window the request was sent to may answer it.
      if (pending && pending.hostWebContentsId === event?.sender.id) pending.resolve(response);
    }),
});

export const registerWebview = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL,
  payload: DesktopPreviewRegisterWebviewInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.registerWebview")(function* ({ tabId, webContentsId }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.registerWebview(tabId, webContentsId);
  }),
});

export const navigate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_NAVIGATE_CHANNEL,
  payload: DesktopPreviewNavigateInputSchema,
  // Void encodes any value as undefined, so retain the download receipt first.
  result: Schema.Union([Schema.Boolean, Schema.Void]),
  handler: Effect.fn("desktop.ipc.preview.navigate")(function* ({ tabId, url, agentDriven }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.navigate(tabId, url, agentDriven);
  }),
});

const tabMethod = (
  channel: string,
  name: string,
  invoke: (
    manager: PreviewManager.PreviewManager["Service"],
    tabId: string,
  ) => Effect.Effect<void, PreviewManager.PreviewManagerError>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopPreviewTabInputSchema,
    result: Schema.Void,
    handler: Effect.fn(name)(function* ({ tabId }) {
      const manager = yield* PreviewManager.PreviewManager;
      yield* invoke(manager, tabId);
    }),
  });

export const goBack = tabMethod(
  IpcChannels.PREVIEW_GO_BACK_CHANNEL,
  "desktop.ipc.preview.goBack",
  (manager, tabId) => manager.goBack(tabId),
);
export const goForward = tabMethod(
  IpcChannels.PREVIEW_GO_FORWARD_CHANNEL,
  "desktop.ipc.preview.goForward",
  (manager, tabId) => manager.goForward(tabId),
);
export const refresh = tabMethod(
  IpcChannels.PREVIEW_REFRESH_CHANNEL,
  "desktop.ipc.preview.refresh",
  (manager, tabId) => manager.refresh(tabId),
);
export const zoomIn = tabMethod(
  IpcChannels.PREVIEW_ZOOM_IN_CHANNEL,
  "desktop.ipc.preview.zoomIn",
  (manager, tabId) => manager.zoomIn(tabId),
);
export const zoomOut = tabMethod(
  IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL,
  "desktop.ipc.preview.zoomOut",
  (manager, tabId) => manager.zoomOut(tabId),
);
export const resetZoom = tabMethod(
  IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL,
  "desktop.ipc.preview.resetZoom",
  (manager, tabId) => manager.resetZoom(tabId),
);
export const hardReload = tabMethod(
  IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL,
  "desktop.ipc.preview.hardReload",
  (manager, tabId) => manager.hardReload(tabId),
);
export const setColorScheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewSetColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* ({ tabId, colorScheme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setColorScheme(tabId, colorScheme);
  }),
});
export const setAudioMuted = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL,
  payload: DesktopPreviewSetAudioMutedInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAudioMuted")(function* ({ tabId, audioMuted }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAudioMuted(tabId, audioMuted);
  }),
});
export const openDevTools = tabMethod(
  IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  "desktop.ipc.preview.openDevTools",
  (manager, tabId) => manager.openDevTools(tabId),
);
export const cancelPickElement = tabMethod(
  IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL,
  "desktop.ipc.preview.cancelPickElement",
  (manager, tabId) => manager.cancelPickElement(tabId),
);
export const startRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_START_CHANNEL,
  "desktop.ipc.preview.startRecording",
  (manager, tabId) => manager.startRecording(tabId),
);
export const stopRecording = tabMethod(
  IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL,
  "desktop.ipc.preview.stopRecording",
  (manager, tabId) => manager.stopRecording(tabId),
);
export const openPictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL,
  "desktop.ipc.preview.openPictureInPicture",
  (manager, tabId) => manager.openPictureInPicture(tabId),
);
export const closePictureInPicture = tabMethod(
  IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL,
  "desktop.ipc.preview.closePictureInPicture",
  (manager, tabId) => manager.closePictureInPicture(tabId),
);

export const clearCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL,
  payload: DesktopPreviewClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCookies")(function* ({
    environmentId,
    profileId,
    browserScope,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCookies(
      yield* resolveClearPartitions(manager, environmentId, profileId, browserScope),
    );
  }),
});

export const clearCache = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: DesktopPreviewClearDataInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* ({
    environmentId,
    profileId,
    browserScope,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.clearCache(
      yield* resolveClearPartitions(manager, environmentId, profileId, browserScope),
    );
  }),
});

export const listBrowserCredentials = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIALS_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopBrowserCredentialSummarySchema),
  handler: Effect.fn("desktop.ipc.preview.credentials.list")(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.listBrowserCredentials;
  }),
});

export const saveBrowserCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIALS_SAVE_CHANNEL,
  payload: DesktopBrowserCredentialSaveInputSchema,
  result: DesktopBrowserCredentialSummarySchema,
  handler: Effect.fn("desktop.ipc.preview.credentials.save")(function* (input) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveBrowserCredential(input);
  }),
});

export const deleteBrowserCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIALS_DELETE_CHANNEL,
  payload: Schema.Struct({ id: Schema.String }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.credentials.delete")(function* ({ id }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.deleteBrowserCredential(id);
  }),
});

export const autofillBrowserCredential = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CREDENTIALS_AUTOFILL_CHANNEL,
  payload: DesktopBrowserAutofillInputSchema,
  result: DesktopBrowserAutofillResultSchema,
  handler: Effect.fn("desktop.ipc.preview.credentials.autofill")(function* (input) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationAutofill(input.tabId, {
      environmentId: input.environmentId,
      profile: input.profile,
      ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      ...(input.username === undefined ? {} : { username: input.username }),
    });
  }),
});

/**
 * Partition scope for an (environment, profile) pair.
 *
 * The default profile keeps the bare environment id it used before profiles
 * existed, so upgrading does not strand anyone's existing logins in an
 * orphaned partition. Incognito derives a non-persistent partition.
 */
export function resolvePartitionScope(
  environmentId: string,
  profileId: string | undefined,
  browserScope?: string,
): {
  readonly scope: string;
  readonly persistent: boolean;
  readonly namespace?: "profile";
} {
  if (browserScope) {
    return {
      scope: `${environmentId}/${browserScope}`,
      persistent: !browserScope.startsWith("ephemeral:"),
    };
  }
  if (profileId === undefined || profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return { scope: environmentId, persistent: true };
  }
  // JSON's tuple framing is injective for strings, including lone UTF-16
  // surrogates (which it escapes). URI encoding throws on those supported ids,
  // while replacing them with U+FFFD would collapse distinct identities.
  return {
    scope: JSON.stringify([environmentId, profileId]),
    persistent: profileId !== INCOGNITO_BROWSER_PROFILE_ID,
    namespace: "profile" as const,
  };
}

/**
 * Clearing without a profile keeps the historical "everything" behaviour for
 * an explicit all-profiles action; naming a profile confines it to that
 * profile's partition so one profile's sign-out cannot reach the others.
 */
const resolveClearPartitions = Effect.fn("desktop.ipc.preview.resolveClearPartitions")(function* (
  manager: PreviewManager.PreviewManager["Service"],
  environmentId: string,
  profileId: string | undefined,
  browserScope?: string,
) {
  if (profileId === undefined && !browserScope) return undefined;
  const { scope, persistent, namespace } = resolvePartitionScope(
    environmentId,
    profileId,
    browserScope,
  );
  // Loading the session is what puts the partition in the map the clear walks.
  // Deriving the partition string alone leaves nothing to match, so clearing a
  // profile with no tab open this run — after a restart, or when deleting a
  // profile — would report success and delete nothing.
  yield* manager.getBrowserSession(scope, persistent, namespace);
  return [yield* manager.getBrowserPartition(scope, persistent, namespace)];
});

export const getPreviewConfig = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_GET_CONFIG_CHANNEL,
  payload: DesktopPreviewConfigInputSchema,
  result: DesktopPreviewWebviewConfigSchema,
  handler: Effect.fn("desktop.ipc.preview.getConfig")(function* ({
    environmentId,
    profileId,
    browserScope,
  }) {
    const manager = yield* PreviewManager.PreviewManager;
    const { scope, persistent, namespace } = resolvePartitionScope(
      environmentId,
      profileId,
      browserScope,
    );
    // Creating the session first is what installs the UA rewrite and permission
    // handlers; a guest that attached to an untouched partition would run with
    // Electron's default UA and Chromium's default permission behaviour.
    yield* manager.getBrowserSession(scope, persistent, namespace);
    return {
      partition: yield* manager.getBrowserPartition(scope, persistent, namespace),
      webPreferences: PREVIEW_WEBVIEW_PREFERENCES,
      preloadUrl: NodeURL.pathToFileURL(`${__dirname}/preview-pick-preload.cjs`).href,
    };
  }),
});

/**
 * Registered separately from `methods`: these carry `BrowserImport` in their
 * context and their own failure type, so they do not unify with the
 * manager-backed handlers the shared loop iterates.
 */
export const listBrowserImportSources = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(BrowserImportSource),
  handler: Effect.fn("desktop.ipc.preview.listBrowserImportSources")(function* () {
    const browserImport = yield* BrowserImport.BrowserImport;
    return yield* browserImport.listSources;
  }),
});

export const importBrowserCookies = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL,
  payload: DesktopPreviewImportCookiesInputSchema,
  result: BrowserImportResult,
  handler: Effect.fn("desktop.ipc.preview.importBrowserCookies")(function* ({
    environmentId,
    ...importInput
  }) {
    const browserImport = yield* BrowserImport.BrowserImport;
    // Derived in main from the same helper the webview config uses, so cookies
    // land in exactly the partition the profile's tabs attach to.
    const { scope, persistent, namespace } = resolvePartitionScope(
      environmentId,
      importInput.targetProfileId,
    );
    return yield* browserImport.importCookies({
      input: importInput,
      scope,
      persistent,
      ...(namespace === undefined ? {} : { namespace }),
    });
  }),
});

export const setAnnotationTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL,
  payload: DesktopPreviewAnnotationThemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationTheme")(function* ({ theme }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.setAnnotationTheme(theme);
  }),
});

export const pickElement = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: Schema.NullOr(PreviewAnnotationSubmissionResultSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.pickElement(tabId);
  }),
});

export const captureScreenshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewScreenshotArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.captureScreenshot")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.captureScreenshot(tabId);
  }),
});

export const revealArtifact = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.revealArtifact")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.revealArtifact(path);
  }),
});

export const copyArtifactToClipboard = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL,
  payload: DesktopPreviewArtifactInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.copyArtifactToClipboard")(function* ({ path }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.copyArtifactToClipboard(path);
  }),
});

export const automationStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL,
  payload: DesktopPreviewTabInputSchema,
  result: DesktopPreviewAutomationStatusSchema,
  handler: Effect.fn("desktop.ipc.preview.automationStatus")(function* ({ tabId }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationStatus(tabId);
  }),
});

export const automationSnapshot = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL,
  payload: Schema.Struct({
    ...DesktopPreviewTabInputSchema.fields,
    includeImage: Schema.optional(Schema.Boolean),
  }),
  result: PreviewAutomationSnapshot,
  handler: Effect.fn("desktop.ipc.preview.automationSnapshot")(function* ({ tabId, includeImage }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationSnapshot(tabId, includeImage);
  }),
});

export const automationClick = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL,
  payload: DesktopPreviewAutomationClickInputSchema,
  result: PreviewAutomationInputResult,
  handler: Effect.fn("desktop.ipc.preview.automationClick")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationClick(tabId, input);
  }),
});

export const automationType = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL,
  payload: DesktopPreviewAutomationTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationType")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationType(tabId, input);
  }),
});

export const automationPress = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL,
  payload: DesktopPreviewAutomationPressInputSchema,
  result: PreviewAutomationInputResult,
  handler: Effect.fn("desktop.ipc.preview.automationPress")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationPress(tabId, input);
  }),
});

export const automationScroll = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL,
  payload: DesktopPreviewAutomationScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationScroll")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationScroll(tabId, input);
  }),
});

export const automationEvaluate = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL,
  payload: DesktopPreviewAutomationEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.automationEvaluate")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationEvaluate(tabId, input);
  }),
});

export const automationWaitFor = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL,
  payload: DesktopPreviewAutomationWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.automationWaitFor")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    yield* manager.automationWaitFor(tabId, input);
  }),
});

export const automationUpload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_UPLOAD_CHANNEL,
  payload: DesktopPreviewAutomationUploadInputSchema,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.preview.automationUpload")(function* ({ tabId, input }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationUpload(tabId, input);
  }),
});

export const automationDownload = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_AUTOMATION_DOWNLOAD_CHANNEL,
  payload: DesktopPreviewAutomationDownloadInputSchema,
  result: DesktopPreviewDownloadedFileSchema,
  handler: Effect.fn("desktop.ipc.preview.automationDownload")(function* ({ tabId, timeoutMs }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.automationDownload(tabId, timeoutMs);
  }),
});

export const saveRecording = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL,
  payload: DesktopPreviewRecordingSaveInputSchema,
  result: DesktopPreviewRecordingArtifactSchema,
  handler: Effect.fn("desktop.ipc.preview.saveRecording")(function* ({ tabId, mimeType, data }) {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* manager.saveRecording(tabId, mimeType, data);
  }),
});

export const methods = [
  createTab,
  closeTab,
  claimTab,
  registerWebview,
  navigate,
  goBack,
  goForward,
  refresh,
  zoomIn,
  zoomOut,
  resetZoom,
  hardReload,
  setColorScheme,
  setAudioMuted,
  openDevTools,
  clearCookies,
  clearCache,
  getPreviewConfig,
  listBrowserCredentials,
  saveBrowserCredential,
  deleteBrowserCredential,
  autofillBrowserCredential,
  setAnnotationTheme,
  pickElement,
  cancelPickElement,
  captureScreenshot,
  revealArtifact,
  copyArtifactToClipboard,
  openPictureInPicture,
  closePictureInPicture,
  automationStatus,
  automationSnapshot,
  automationClick,
  automationType,
  automationPress,
  automationScroll,
  automationEvaluate,
  automationWaitFor,
  automationUpload,
  automationDownload,
  startRecording,
  stopRecording,
  saveRecording,
] as const;
