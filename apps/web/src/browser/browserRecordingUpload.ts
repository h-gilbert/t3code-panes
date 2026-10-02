import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PreviewAutomationFileTooLargeError,
  PreviewAutomationFileTransferError,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  type DesktopPreviewRecordingArtifact,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { readPreparedConnection } from "~/state/session";

/** Sends the finished encoded file once; capture frames never cross the environment connection. */
export async function uploadBrowserRecording(
  threadRef: ScopedThreadRef,
  artifact: DesktopPreviewRecordingArtifact,
  blob: Blob,
  deadlineMs: number,
): Promise<string> {
  const { threadId } = threadRef;
  if (blob.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    throw new PreviewAutomationRecordingTooLargeError({ threadId });
  }
  const result = await uploadBrowserFile(
    threadRef,
    { name: artifact.path.split(/[\\/]/).at(-1) ?? artifact.id, mimeType: artifact.mimeType },
    blob,
    deadlineMs,
  );
  if ("attachmentId" in result) return result.attachmentId;
  if (result.deadlineExpired) {
    throw new PreviewAutomationRecordingDeadlineExpiredError({ threadId, cause: result.cause });
  }
  throw new PreviewAutomationRecordingTransferError({ threadId, cause: result.cause });
}

/** Sends a file the agent downloaded in the browser to the agent's environment. */
export async function uploadBrowserDownload(
  threadRef: ScopedThreadRef,
  file: { readonly name: string; readonly mimeType: string },
  blob: Blob,
  deadlineMs: number,
): Promise<string> {
  if (blob.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    throw new PreviewAutomationFileTooLargeError({
      fileName: file.name,
      maximumBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    });
  }
  const result = await uploadBrowserFile(threadRef, file, blob, deadlineMs);
  if ("attachmentId" in result) return result.attachmentId;
  throw new PreviewAutomationFileTransferError({
    threadId: threadRef.threadId,
    cause: result.cause,
  });
}

/** Uploads one blob as a pending attachment within the automation request's budget. */
async function uploadBrowserFile(
  { environmentId }: ScopedThreadRef,
  file: { readonly name: string; readonly mimeType: string },
  blob: Blob,
  deadlineMs: number,
): Promise<
  { readonly attachmentId: string } | { readonly cause: unknown; readonly deadlineExpired: boolean }
> {
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId,
    upload: {
      type: "file",
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: blob.size,
    },
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => {
      const controller = new AbortController();
      // Encoding, saving and minting consume the same request budget. Leave time to reply.
      const remainingMs = deadlineMs - Date.now() - 1_000;
      return {
        abort: () => controller.abort(),
        done:
          remainingMs <= 0
            ? Promise.reject(new Error("Browser file transfer deadline expired."))
            : fetch(url, {
                method: "POST",
                headers: { "Content-Type": file.mimeType },
                body: blob,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(remainingMs)]),
              }).then((response) => {
                if (!response.ok)
                  throw new Error(`Browser file upload rejected (${response.status}).`);
              }),
      };
    },
  });
  if (result.status === "uploaded") return { attachmentId: result.attachmentId };
  if (result.attachmentId) {
    deletePendingAttachmentUpload({
      registry: appAtomRegistry,
      remove: attachmentEnvironment.remove,
      environmentId,
      attachmentId: result.attachmentId,
    });
  }
  return {
    cause: result.status === "failed" ? result.error : undefined,
    deadlineExpired: Date.now() >= deadlineMs - 1_000,
  };
}

/** Fetches a file the server staged for `preview_upload`. */
export async function fetchStagedUploadFile(
  environmentId: ScopedThreadRef["environmentId"],
  relativeUrl: string,
  deadlineMs: number,
): Promise<Uint8Array> {
  const connection = readPreparedConnection(environmentId);
  const url = connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
  if (!url) throw new Error("The environment connection is not ready.");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Math.max(1, deadlineMs - Date.now() - 1_000)),
  });
  if (!response.ok) throw new Error(`Staged upload fetch failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}
