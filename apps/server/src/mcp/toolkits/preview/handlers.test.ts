import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
} from "../../../attachmentStore.ts";
import { resolveAsset } from "../../../assets/AssetAccess.ts";
import * as NativeAppIconResolver from "../../../assets/NativeAppIconResolver.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import {
  claimPreviewDownload,
  claimPreviewRecording,
  normalizePreviewOpenInput,
  stageUploadFile,
} from "./handlers.ts";

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

describe("claimPreviewRecording", () => {
  it.effect("overlapping and repeated claims return the same retained recording", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const uploadedAttachmentId = createPendingAttachmentId(".webm");
      const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(pendingPath, "video!");
      const response = {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
        uploadedAttachmentId,
      };
      const claim = claimPreviewRecording(ThreadId.make("thread-1"), response);
      const [first, second] = yield* Effect.all([claim, claim], { concurrency: "unbounded" });
      expect(first).toEqual(second);
      expect(yield* claim).toEqual(first);
      expect(yield* fileSystem.readFileString(first.path)).toBe("video!");
      expect(yield* fileSystem.exists(pendingPath)).toBe(false);
      const wrongThread = yield* claimPreviewRecording(ThreadId.make("thread-2"), response).pipe(
        Effect.result,
      );
      expect(wrongThread._tag).toBe("Failure");
      const wrongPath = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: `../${uploadedAttachmentId}`,
      }).pipe(Effect.result);
      expect(wrongPath._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect.each([6, 5])(
    "claims only a complete uploaded recording (reported bytes: %s)",
    (sizeBytes) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const uploadedAttachmentId = createPendingAttachmentId(".webm");
        const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.webm`);
        yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fileSystem.writeFileString(pendingPath, "video!");
        const response = {
          id: "desktop-recording",
          tabId: "tab-1",
          path: "/desktop/recording.webm",
          mimeType: "video/webm",
          sizeBytes,
          createdAt: "2026-09-07T00:00:00.000Z",
          uploadedAttachmentId,
        };
        const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), response).pipe(
          Effect.result,
        );
        if (sizeBytes === 6) {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.path).not.toBe(response.path);
          expect(parseThreadSegmentFromAttachmentId(result.success.id)).toBe("thread-1");
          expect(yield* fileSystem.readFileString(result.success.path)).toBe("video!");
          expect(yield* fileSystem.exists(pendingPath)).toBe(false);
        } else {
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") return;
          expect(result.failure._tag).toBe("PreviewAutomationRecordingTransferError");
          expect(yield* fileSystem.exists(pendingPath)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect("reports an older desktop without returning its inaccessible path", () =>
    Effect.gen(function* () {
      const result = yield* claimPreviewRecording(ThreadId.make("thread-1"), {
        id: "desktop-recording",
        tabId: "tab-1",
        path: "/desktop/recording.webm",
        mimeType: "video/webm",
        sizeBytes: 6,
        createdAt: "2026-09-07T00:00:00.000Z",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("PreviewAutomationRecordingDesktopUpdateRequiredError");
      expect(result.failure.message).toContain("Update the desktop app");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-recording-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

const transferLayer = (prefix: string) => {
  const configLayer = ServerConfig.layerTest(process.cwd(), { prefix });
  return Layer.mergeAll(
    configLayer,
    WorkspacePaths.layer,
    NativeAppIconResolver.layer.pipe(Layer.provide(configLayer)),
    ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

describe("stageUploadFile", () => {
  it.effect("serves a staged copy at its signed URL until the upload finishes", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      const sourceDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const source = path.join(sourceDirectory, "report.pdf");
      yield* fileSystem.writeFileString(source, "pdf!");

      yield* Effect.gen(function* () {
        const staged = yield* stageUploadFile(source);
        expect(staged).toMatchObject({ name: "report.pdf", sizeBytes: 4 });
        const [, , , token, fileName] = staged.url.split("/");
        const resolved = yield* resolveAsset(token!, fileName!);
        expect(resolved?.kind).toBe("file");
        expect(yield* fileSystem.readFileString(resolved!.path)).toBe("pdf!");
      }).pipe(Effect.scoped);

      expect(yield* fileSystem.readDirectory(config.attachmentsDir)).toEqual([]);
      expect(yield* fileSystem.readFileString(source)).toBe("pdf!");
    }).pipe(Effect.scoped, Effect.provide(transferLayer("t3-preview-upload-"))),
  );

  it.effect("refuses relative paths and directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      for (const filePath of ["report.pdf", directory]) {
        const result = yield* stageUploadFile(filePath).pipe(Effect.scoped, Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") return;
        expect(result.failure._tag).toBe("PreviewAutomationFileUnreadableError");
      }
    }).pipe(Effect.scoped, Effect.provide(transferLayer("t3-preview-upload-"))),
  );
});

describe("claimPreviewDownload", () => {
  it.effect("moves a complete download under a safe name and rejects a partial one", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      const upload = (contents: string) =>
        Effect.gen(function* () {
          const uploadedAttachmentId = createPendingAttachmentId(".csv");
          const pendingPath = path.join(config.attachmentsDir, `${uploadedAttachmentId}.csv`);
          yield* fileSystem.writeFileString(pendingPath, contents);
          return { uploadedAttachmentId, pendingPath };
        });
      const response = {
        tabId: "tab-1",
        fileName: "../../outside/export.csv",
        mimeType: "text/csv",
        sizeBytes: 6,
        url: "https://example.com/export.csv",
      };

      const complete = yield* upload("a,b\n1,");
      const claimed = yield* claimPreviewDownload(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: complete.uploadedAttachmentId,
      });
      expect(claimed.fileName).toBe("export.csv");
      expect(path.dirname(path.dirname(claimed.path))).toBe(
        path.join(config.browserArtifactsDir, "downloads"),
      );
      expect(yield* fileSystem.readFileString(claimed.path)).toBe("a,b\n1,");
      expect(yield* fileSystem.exists(complete.pendingPath)).toBe(false);

      const partial = yield* upload("a,b");
      const result = yield* claimPreviewDownload(ThreadId.make("thread-1"), {
        ...response,
        uploadedAttachmentId: partial.uploadedAttachmentId,
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") return;
      expect(result.failure._tag).toBe("PreviewAutomationFileTransferError");
    }).pipe(Effect.provide(transferLayer("t3-preview-download-"))),
  );
});
