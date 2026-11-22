import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("gt-react", async (importOriginal) => {
  const gt = await importOriginal<typeof import("gt-react")>();
  return {
    ...gt,
    useGT: () => (text: string) => text,
    useMessages: () => gt.decodeMsg,
  };
});

const mocks = vi.hoisted(() => ({
  buttons: new Map<string, (() => void) | undefined>(),
  commit: vi.fn(async () => undefined),
  viewport: { _tag: "fill" } as
    | { readonly _tag: "fill" }
    | { readonly _tag: "freeform"; readonly width: number; readonly height: number },
}));
vi.mock("./PreviewView", () => ({ PreviewView: () => <section aria-label="Browser controls" /> }));
vi.mock("react-dom", () => ({ createPortal: (children: ReactNode) => children }));
vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    mocks.buttons.set(
      String(props["aria-label"]),
      props.onClick ? () => props.onClick!({} as never) : undefined,
    );
    return <button {...props} />;
  },
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/previewMiniPlayerStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/previewMiniPlayerStore")>();
  return {
    ...actual,
    usePreviewMiniPlayerStore: Object.assign(
      (
        selector: (state: ReturnType<typeof actual.usePreviewMiniPlayerStore.getState>) => unknown,
      ) => selector(actual.usePreviewMiniPlayerStore.getState()),
      actual.usePreviewMiniPlayerStore,
    ),
  };
});
vi.mock("~/previewStateStore", () => ({
  useThreadPreviewState: () => ({
    serverEpoch: null,
    sessions: { tab: { tabId: "tab", viewport: mocks.viewport, navStatus: { _tag: "Idle" } } },
    desktopByTabId: { tab: { hasWebContents: true } },
  }),
}));
vi.mock("~/browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({}),
  browserResponsiveViewportForToggle: () => ({ _tag: "freeform", width: 800, height: 600 }),
}));
vi.mock("~/browser/browserViewportActions", () => ({ commitBrowserViewportChange: mocks.commit }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({
  BrowserSurfaceSlot: (props: { fitSourceContent: boolean; zIndex: number }) => (
    <div data-test-fit={String(props.fitSourceContent)} data-test-layer={props.zIndex} />
  ),
}));
vi.mock("~/components/ChatView.logic", () => ({
  agentControlledBrowserCloseConfirmationForCount: () => null,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { close: {} } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: vi.fn() }) },
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("./closePreviewSession", () => ({ closePreviewSession: vi.fn() }));
vi.mock("./previewBridge", () => ({ previewBridge: null }));

import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const render = () =>
  renderToStaticMarkup(
    <ThreadPreviewMiniPlayer
      threadRef={ref}
      miniPlayer={selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        ref,
      )!}
      bottomInset={0}
    />,
  );
beforeEach(() => {
  vi.stubGlobal("document", { body: {} });
  mocks.buttons.clear();
  mocks.commit.mockClear();
  mocks.viewport = { _tag: "fill" };
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  usePreviewMiniPlayerStore.getState().open(ref, "tab");
});

describe("browser presentation controls", () => {
  it("opens a workspace-wide window from the mini preview and restores it after fullscreen", () => {
    expect(render()).toContain('data-preview-presentation="mini"');
    expect(mocks.buttons.has("Expand preview to full screen")).toBe(true);
    mocks.buttons.get("Open floating browser window")!();
    const windowMarkup = render();
    expect(windowMarkup).toContain('data-preview-presentation="window"');
    expect(windowMarkup).toContain('aria-label="Browser controls"');
    mocks.buttons.get("Expand preview to full screen")!();
    expect(render()).toContain('data-preview-presentation="fullscreen"');
    mocks.buttons.get("Exit full screen")!();
    expect(render()).toContain('data-preview-presentation="window"');
    mocks.buttons.get("Return to small preview")!();
    expect(render()).toContain('data-preview-presentation="mini"');
  });

  it("resets a fixed viewport to fill when expanding from compact, without overwriting explicit window viewports", () => {
    mocks.viewport = { _tag: "freeform", width: 1020, height: 760 };
    render();
    mocks.buttons.get("Expand preview to full screen")!();
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab" }), {
      _tag: "fill",
    });

    mocks.commit.mockClear();
    render();
    mocks.buttons.get("Exit full screen")!();
    expect(mocks.commit).not.toHaveBeenCalled();

    render();
    mocks.buttons.get("Open floating browser window")!();
    expect(mocks.commit).toHaveBeenCalledWith(expect.objectContaining({ tabId: "tab" }), {
      _tag: "fill",
    });

    // Toggling between floating and fullscreen preserves an explicit fixed viewport.
    mocks.commit.mockClear();
    render();
    mocks.buttons.get("Expand preview to full screen")!();
    expect(mocks.commit).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllGlobals());
