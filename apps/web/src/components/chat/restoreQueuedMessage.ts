import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type OrchestrationV2ConversationMessage,
  type ThreadId,
} from "@t3tools/contracts";
import { useComposerDraftStore, type ComposerThreadTarget } from "../../composerDraftStore";
import {
  asKnownContextRecord,
  previewAnnotationFromRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
} from "../../lib/composerContextRecords";
import { producerIdFromComposerContextId } from "../../lib/composerContextReferences";

/** Cancel only after attachments are readable. Overflow stays in the held server queue. */
export async function restoreQueuedMessage(input: {
  target: ComposerThreadTarget;
  threadId: ThreadId;
  message: Pick<OrchestrationV2ConversationMessage, "text" | "attachments" | "context">;
  prepareFiles: () => Promise<File[]>;
  cancel: () => Promise<void>;
}): Promise<boolean> {
  const store = useComposerDraftStore.getState();
  const fits = () => {
    const draft = store.getComposerDraft(input.target);
    return (
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + input.message.attachments.length <=
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    );
  };
  if (!fits()) return false;
  const files = await input.prepareFiles();
  if (!fits()) return false;
  await input.cancel();
  const draft = store.getComposerDraft(input.target);
  store.setPrompt(
    input.target,
    [draft?.prompt, input.message.text].filter((text) => text?.trim()).join("\n\n"),
  );
  const records = (input.message.context?.records ?? []).flatMap((record) => {
    const known = asKnownContextRecord(record);
    return known ? [known] : [];
  });
  files.forEach((file, index) => {
    const saved = input.message.attachments[index]!;
    const record = records.find(
      (record) =>
        (record.kind === "image" || record.kind === "file") && record.attachmentId === saved.id,
    );
    const id = record ? producerIdFromComposerContextId(saved.type, record.contextId) : saved.id;
    const attachment = { id, name: file.name, mimeType: file.type, sizeBytes: file.size, file };
    if (saved.type === "image")
      store.addImages(
        input.target,
        [{ ...attachment, type: "image", previewUrl: URL.createObjectURL(file) }],
        { allowDuplicates: true },
      );
    else
      store.addFiles(
        input.target,
        [{ ...attachment, type: "file", uploadedAttachmentId: saved.id }],
        { allowDuplicates: true },
      );
  });
  for (const record of records) {
    switch (record.kind) {
      case "terminal":
        store.addTerminalContext(
          input.target,
          terminalContextDraftFromRecord(record, input.threadId),
        );
        break;
      case "review-comment":
        store.addReviewComment(input.target, reviewCommentFromRecord(record));
        break;
      case "preview-annotation":
        store.addPreviewAnnotation(input.target, previewAnnotationFromRecord(record));
        break;
      case "thread":
        store.addThreadContexts(input.target, [record]);
        break;
    }
  }
  return true;
}
