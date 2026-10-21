// @effect-diagnostics nodeBuiltinImport:off -- Transfer bearer tokens use native cryptographic random bytes.
import * as NodeCrypto from "node:crypto";
import { safeFileNameSegment } from "@t3tools/shared/fileNameSegment";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PREVIEW_FILE_TRANSFER_TIMEOUT_MS,
  PREVIEW_RECORDING_STOP_TIMEOUT_MS,
  PreviewAutomationFileTooLargeError,
  PreviewAutomationFileTransferError,
  PreviewAutomationFileUnreadableError,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  type PreviewAutomationAutofillResult,
  type PreviewAutomationCloseResult,
  type PreviewAutomationDownloadInput,
  type PreviewAutomationInputResult,
  type PreviewAutomationUploadFile,
  type PreviewAutomationUploadInput,
  type PreviewAutomationUploadResult,
  type ToolActivityIcon,
  type PreviewAutomationOperation,
  type PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  type ThreadId,
  type PreviewAutomationRecordingStatus,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  PreviewTabId,
} from "@t3tools/contracts";

import {
  attachmentFileExtension,
  createPendingAttachmentId,
  parseAttachmentUuid,
  parseAttachmentFileExtension,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../../../attachmentStore.ts";
import { issueStagedAttachmentUrl } from "../../../assets/AssetAccess.ts";
import { resolveAttachmentRelativePath } from "../../../attachmentPaths.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

/** Whether a preview the agent
 * said nothing about surfaces is the user's `browserAutoShowFloatingPreview`
 * preference, which is desktop-local and unreadable from here — filling in
 * `true` would silently override it for every `preview_open`.
 */
export function normalizePreviewOpenInput(
  input: PreviewAutomationOpenInput,
): PreviewAutomationOpenInput {
  const open = input.open ?? input.show;
  return {
    ...input,
    ...(open === undefined ? {} : { open, show: open }),
    reuseExistingTab: input.reuseExistingTab ?? true,
  };
}

const invoke = Effect.fn("PreviewToolkit.invoke")(function* <A>(
  operation: PreviewAutomationOperation,
  input: unknown,
  timeoutMs?: number,
  tabId?: PreviewTabId,
): Effect.fn.Return<
  { result: A; toolIcon?: ToolActivityIcon },
  import("@t3tools/contracts").PreviewAutomationError,
  McpInvocationContext.McpInvocationContext | PreviewAutomationBroker.PreviewAutomationBroker
> {
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  let targetTabId = tabId;
  const result = yield* broker.invoke<A>({
    onTargetTab: (resolvedTabId) => {
      targetTabId = resolvedTabId;
    },
    scope,
    operation,
    input,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tabId === undefined ? {} : { tabId }),
  });
  if (["status", "open", "navigate", "snapshot"].includes(operation)) return { result };
  const statusTabId =
    (operation !== "evaluate" && typeof result === "object" && result !== null
      ? (result as { tabId?: PreviewTabId }).tabId
      : undefined) ?? targetTabId;
  const page = yield* broker
    .invoke<PreviewAutomationStatus>({
      scope,
      operation: "status",
      input: {},
      timeoutMs: 500,
      disconnectOnTimeout: false,
      updateCurrentTab: false,
      ...(statusTabId === undefined ? {} : { tabId: statusTabId }),
    })
    .pipe(Effect.orElseSucceed(() => null));
  return {
    result,
    ...(page?.url && /^https?:\/\//i.test(page.url) && page.url.length <= 4096
      ? { toolIcon: { _tag: "website" as const, pageUrl: page.url } }
      : {}),
  };
});

const invokeTargeted = <A extends object>(
  operation: PreviewAutomationOperation,
  input: {
    readonly tabId?: PreviewTabId | undefined;
    readonly [key: string]: unknown;
  },
  timeoutMs?: number,
) => {
  const { tabId, ...operationInput } = input;
  return invoke<A>(operation, operationInput, timeoutMs, tabId).pipe(
    Effect.map(({ result, toolIcon }) => ({
      ...result,
      ...(toolIcon ? { toolIcon } : {}),
    })),
  );
};

const UploadedRecordingArtifact = Schema.Struct({
  ...PreviewAutomationRecordingArtifact.fields,
  uploadedAttachmentId: Schema.optional(Schema.String),
});
const decodeUploadedRecordingArtifact = Schema.decodeUnknownEffect(UploadedRecordingArtifact);

export const claimPreviewRecording = Effect.fn("PreviewToolkit.claimRecording")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const artifact = yield* decodeUploadedRecordingArtifact(response).pipe(
    Effect.mapError(
      (cause) =>
        new PreviewAutomationRecordingTransferError({
          threadId,
          cause,
        }),
    ),
  );
  if (!artifact.uploadedAttachmentId) {
    return yield* new PreviewAutomationRecordingDesktopUpdateRequiredError({ threadId });
  }
  const config = yield* ServerConfig.ServerConfig;
  const uuid = parseAttachmentUuid(artifact.uploadedAttachmentId);
  const extension = parseAttachmentFileExtension(artifact.uploadedAttachmentId);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`;
  if (!uuid || !extension || !threadSegment || artifact.uploadedAttachmentId !== pendingId) {
    return yield* new PreviewAutomationRecordingTransferError({
      threadId,
    });
  }
  const finalId = `${threadSegment}-${uuid}-${extension}`;
  const currentPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${pendingId}.${extension}`,
  });
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${finalId}.${extension}`,
  });
  if (!currentPath || !finalPath) {
    return yield* new PreviewAutomationRecordingTransferError({ threadId });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const validateFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.filterOrFail(
        (stat) =>
          stat.type === "File" &&
          Number(stat.size) === artifact.sizeBytes &&
          artifact.sizeBytes > 0 &&
          artifact.sizeBytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES,
        () => new PreviewAutomationRecordingTransferError({ threadId }),
      ),
    );
  yield* Effect.gen(function* () {
    yield* validateFile(currentPath);
    yield* fileSystem.rename(currentPath, finalPath);
  }).pipe(
    Effect.catchIf(
      (cause) =>
        cause._tag !== "PreviewAutomationRecordingTransferError" &&
        cause.reason._tag === "NotFound",
      () => validateFile(finalPath),
    ),
    Effect.mapError((cause) => new PreviewAutomationRecordingTransferError({ threadId, cause })),
  );
  const { uploadedAttachmentId: _uploadedAttachmentId, ...recording } = artifact;
  return { ...recording, id: finalId, path: finalPath };
});

/**
 * Copies one agent file into a pending attachment the desktop host can fetch
 * over HTTP, so bytes never ride the WebSocket. The copy is removed when the
 * enclosing scope closes; a crash leaves it for the stale-pending sweep.
 */
export const stageUploadFile = Effect.fn("PreviewToolkit.stageUploadFile")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const unreadable = (cause?: unknown) =>
    new PreviewAutomationFileUnreadableError({ path: filePath, cause });
  if (!path.isAbsolute(filePath)) return yield* unreadable();
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.mapError(unreadable));
  if (stat.type !== "File") return yield* unreadable();
  const name = path.basename(filePath);
  const sizeBytes = Number(stat.size);
  if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return yield* new PreviewAutomationFileTooLargeError({
      fileName: name,
      maximumBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    });
  }
  const extension = attachmentFileExtension(name);
  const attachmentId = createPendingAttachmentId(extension);
  const stagedPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${attachmentId}${extension}`,
  });
  if (!stagedPath) return yield* unreadable();
  yield* Effect.acquireRelease(
    fileSystem.copyFile(filePath, stagedPath).pipe(Effect.mapError(unreadable)),
    () => fileSystem.remove(stagedPath).pipe(Effect.ignore),
  );
  const url = yield* issueStagedAttachmentUrl({ attachmentId, fileName: name }).pipe(
    Effect.mapError(unreadable),
  );
  return { name, url, sizeBytes } satisfies PreviewAutomationUploadFile;
});

const uploadFiles = Effect.fn("PreviewToolkit.uploadFiles")(function* (
  input: PreviewAutomationUploadInput,
) {
  return yield* invokeTargeted<PreviewAutomationUploadResult>(
    "upload",
    input,
    PREVIEW_FILE_TRANSFER_TIMEOUT_MS,
  );
}, Effect.scoped);

const UploadedDownload = Schema.Struct({
  tabId: PreviewTabId,
  fileName: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  url: Schema.String,
  uploadedAttachmentId: Schema.String,
});
const decodeUploadedDownload = Schema.decodeUnknownEffect(UploadedDownload);

/** Moves an uploaded download out of pending attachments into the browser artifacts dir. */
export const claimPreviewDownload = Effect.fn("PreviewToolkit.claimDownload")(function* (
  threadId: ThreadId,
  response: unknown,
) {
  const transferError = (cause?: unknown) =>
    new PreviewAutomationFileTransferError({ threadId, cause });
  const download = yield* decodeUploadedDownload(response).pipe(Effect.mapError(transferError));
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extension = parseAttachmentFileExtension(download.uploadedAttachmentId);
  const uuid = parseAttachmentUuid(download.uploadedAttachmentId);
  if (
    !uuid ||
    !extension ||
    download.uploadedAttachmentId !== `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${uuid}-${extension}`
  ) {
    return yield* transferError();
  }
  const pendingPath = resolveAttachmentRelativePath({
    attachmentsDir: config.attachmentsDir,
    relativePath: `${download.uploadedAttachmentId}.${extension}`,
  });
  if (!pendingPath) return yield* transferError();
  const fileName = safeFileNameSegment(download.fileName, "download");
  const directory = path.join(config.browserArtifactsDir, "downloads", NodeCrypto.randomUUID());
  const finalPath = path.join(directory, fileName);
  yield* Effect.gen(function* () {
    const stat = yield* fileSystem.stat(pendingPath);
    if (stat.type !== "File" || Number(stat.size) !== download.sizeBytes) {
      return yield* transferError();
    }
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.rename(pendingPath, finalPath);
  }).pipe(Effect.mapError(transferError));
  return {
    tabId: download.tabId,
    fileName,
    path: finalPath,
    mimeType: download.mimeType,
    sizeBytes: download.sizeBytes,
    url: download.url,
  };
});

/**
 * `available` answers "is this tab automation-capable", which agents read as "may
 * I drive it". Only the broker knows whether a competing session has the tab, so
 * the pre-flight read every agent is told to make carries the hold too.
 */
const readStatusWithHold = Effect.fn("PreviewToolkit.statusWithHold")(function* (
  input: { readonly tabId?: PreviewTabId | undefined } | undefined,
) {
  const status = yield* invokeTargeted<PreviewAutomationStatus>("status", input ?? {});
  const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const hold = yield* broker.readHold({
    scope,
    ...(status.tabId === null ? {} : { tabId: status.tabId }),
  });
  return hold === undefined
    ? status
    : { ...status, heldByAnotherSession: true, heldByThreadId: hold.threadId };
});

const handlers = {
  preview_dialog: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("dialog", input),
  ),
  preview_status: McpToolAccess.readsAsCaller((input) => readStatusWithHold(input)),
  preview_open: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("open", normalizePreviewOpenInput(input)),
  ),
  preview_navigate: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationStatus>("navigate", input, input.timeoutMs),
  ),
  preview_resize: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationResizeResult>("resize", input, input.timeoutMs),
  ),
  preview_set_appearance: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSetColorSchemeResult>("setColorScheme", input),
  ),
  preview_snapshot: McpToolAccess.readsAsCaller((input) => {
    // Saving still needs a capture even when the tool omits its image output.
    const { includeImage, save, ...operationInput } = input ?? {};
    return invokeTargeted<PreviewAutomationSnapshot>("snapshot", {
      ...operationInput,
      includeImage: includeImage !== false || save === true,
    });
  }),
  preview_click: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationInputResult>("click", input, input.timeoutMs),
  ),
  preview_type: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("type", input, input.timeoutMs),
  ),
  preview_hover: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("hover", input, input.timeoutMs),
  ),
  preview_select: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationSelectResult>("select", input, input.timeoutMs),
  ),
  preview_drag: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<object>("drag", input, input.timeoutMs),
  ),
  preview_upload: McpToolAccess.actsAsCaller((input) => uploadFiles(input)),
  preview_press: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationInputResult>("press", input),
  ),
  preview_scroll: McpToolAccess.actsAsCaller((input) => invokeTargeted<object>("scroll", input)),
  preview_evaluate: McpToolAccess.actsAsCaller(({ tabId, ...input }) =>
    invoke<unknown>("evaluate", input, undefined, tabId).pipe(
      Effect.map(({ result, toolIcon }) => ({
        value: result ?? null,
        ...(toolIcon ? { toolIcon } : {}),
      })),
    ),
  ),
  preview_wait_for: McpToolAccess.readsAsCaller((input) =>
    invokeTargeted<object>("waitFor", input, input.timeoutMs),
  ),
  preview_recording_start: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationRecordingStatus>("recordingStart", input ?? {}),
  ),
  preview_recording_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "recordingStop",
        { ...operationInput, transferToEnvironment: true },
        PREVIEW_RECORDING_STOP_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewRecording(scope.thread.threadId, response.result);
      return { ...artifact, ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}) };
    }),
  ),
  preview_download: McpToolAccess.actsAsCaller((input: PreviewAutomationDownloadInput) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireThreadMcpCapability("preview");
      const { tabId, ...operationInput } = input;
      const response = yield* invoke<unknown>(
        "download",
        operationInput,
        (input.timeoutMs ?? 15_000) + PREVIEW_FILE_TRANSFER_TIMEOUT_MS,
        tabId,
      );
      const artifact = yield* claimPreviewDownload(scope.thread.threadId, response.result);
      return { ...artifact, ...(response.toolIcon ? { toolIcon: response.toolIcon } : {}) };
    }),
  ),
  preview_close: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationCloseResult>("close", input ?? {}),
  ),
  preview_autofill: McpToolAccess.actsAsCaller((input) =>
    invokeTargeted<PreviewAutomationAutofillResult>("autofill", input ?? {}),
  ),
} satisfies McpToolAccess.Handlers<typeof PreviewToolkit.tools>;

const { preview_snapshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(PreviewStandardToolkit, standardHandlers);

export const layerSnapshot = McpToolAccess.toLayer(PreviewSnapshotToolkit, {
  preview_snapshot,
});
