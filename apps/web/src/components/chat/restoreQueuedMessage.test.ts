import { EnvironmentId, ThreadId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { restoreQueuedMessage } from "./restoreQueuedMessage";

const threadId = ThreadId.make("restore-queue");
const target = scopeThreadRef(EnvironmentId.make("remote"), threadId);
const file = new File(["report"], "report.pdf", { type: "application/pdf" });
const message = {
  text: "Check the report",
  attachments: [
    {
      type: "file" as const,
      id: "report",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    },
  ],
};
beforeEach(() =>
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} }),
);

it("returns queued text and files after existing composer content", async () => {
  const store = useComposerDraftStore.getState();
  store.setPrompt(target, "Keep this draft");
  const cancel = vi.fn(async () => {});
  expect(
    await restoreQueuedMessage({
      target,
      threadId,
      message,
      prepareFiles: async () => [file],
      cancel,
    }),
  ).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  expect(store.getComposerDraft(target)?.prompt).toBe("Keep this draft\n\nCheck the report");
  expect(store.getComposerDraft(target)?.files[0]).toMatchObject({
    name: "report.pdf",
    uploadedAttachmentId: "report",
  });
});
it("keeps a queued message when its attachments cannot be recovered", async () => {
  const cancel = vi.fn(async () => {});
  await expect(
    restoreQueuedMessage({
      target,
      threadId,
      message,
      prepareFiles: async () => {
        throw new Error("offline");
      },
      cancel,
    }),
  ).rejects.toThrow("offline");
  expect(cancel).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "").toBe("");
});
it("keeps overflow in the server queue", async () => {
  useComposerDraftStore.getState().addFiles(
    target,
    Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
      type: "file" as const,
      id: `existing-${index}`,
      file,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    })),
    { allowDuplicates: true },
  );
  const cancel = vi.fn(async () => {});
  expect(
    await restoreQueuedMessage({
      target,
      threadId,
      message,
      prepareFiles: async () => [file],
      cancel,
    }),
  ).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
});
it("does not duplicate a queued message that already started", async () => {
  await expect(
    restoreQueuedMessage({
      target,
      threadId,
      message,
      prepareFiles: async () => [file],
      cancel: async () => {
        throw new Error("no longer queued");
      },
    }),
  ).rejects.toThrow("no longer queued");
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "").toBe("");
});
