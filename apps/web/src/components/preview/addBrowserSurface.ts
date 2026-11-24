import { showBrowserInset } from "./showBrowserInset";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";

import type { BrowserSettingsReadError, OpenPreviewMutation } from "~/browser/openFileInPreview";

import { openPreviewSession } from "./openPreviewSession";

export async function addBrowserSurface<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly profileId?: string | undefined;
  readonly duplicateFrom?: PreviewSessionSnapshot;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const source = input.duplicateFrom;
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...(source === undefined
      ? {}
      : {
          ...(source.navStatus._tag === "Idle" ? {} : { url: source.navStatus.url }),
          ...(source.profileId === undefined ? {} : { profileId: source.profileId }),
          ...(source.viewport === undefined ? {} : { viewport: source.viewport }),
          runtime: source.runtime ?? "desktop",
        }),
  });
  return mapAtomCommandResult(result, (snapshot) => {
    showBrowserInset(input.threadRef, snapshot.tabId);
  });
}
