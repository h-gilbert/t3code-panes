import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../shortcutModifierState", () => ({
  useShortcutModifierState: () => ({
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  }),
}));

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (mode: string) =>
    mode === "artwork" ? stageArtworkState.variant : null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { m } from "../../i18n/messages";

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => m,
  useMessages: () => m,
}));

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      canInterrupt: isRunning,
      isSendBusy: false,
      sendDisabledReason: null,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
    }),
  );
}

function renderRunningActions(hasSendableContent: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      followUpBehavior: "queue",
      isRunning: true,
      canOperateThread: true,
      canInterrupt: true,
      isSendBusy: false,
      sendDisabledReason: null,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
    }),
  );
}

function renderSendButton(
  sendDisabledReason: string | null = null,
  backgroundAgentsWorking = false,
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: null,
      isRunning: false,
      canInterrupt: false,
      isSendBusy: false,
      sendDisabledReason,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      backgroundAgentsWorking,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
    }),
  );
}

function setup() {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
}

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    setup();
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    setup();
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    setup();
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    setup();
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    setup();
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });

  it("distinguishes an idle main turn while background agents are still working", () => {
    setup();
    const markup = renderSendButton(null, true);

    expect(markup).toContain("ring-warning/55");
    expect(markup).toContain("bg-warning");
    expect(markup).toContain('aria-label="Send message. Agents are still working"');
  });

  it("renders a queue action while running with a sendable draft", () => {
    setup();
    const markup = renderRunningActions(true);

    expect(markup).not.toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).toContain('type="submit"');
  });

  it("keeps stop as the only action while running with an empty composer", () => {
    setup();
    const markup = renderRunningActions(false);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Queue message"');
  });
});
