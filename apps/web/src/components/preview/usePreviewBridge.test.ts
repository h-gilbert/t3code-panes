import type { DesktopPreviewTabState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectDesktopState } from "./usePreviewBridge";

const favicon = {
  dataUrl: "data:image/png;base64,AAAA",
  pageUrl: "http://localhost:3000/app",
  capturedAt: 1,
};

function state(navStatus: DesktopPreviewTabState["navStatus"]): DesktopPreviewTabState {
  return {
    tabId: "tab-1",
    webContentsId: 1,
    hostWebContentsId: 7,
    navStatus,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    favicon,
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("projectDesktopState", () => {
  it("shows a retained icon only while the current document has the captured origin", () => {
    expect(
      projectDesktopState(
        state({ kind: "Loading", url: "http://localhost:3000/reload", title: "" }),
      ).favicon,
    ).toEqual(favicon);
    expect(
      projectDesktopState(
        state({
          kind: "LoadFailed",
          url: "https://example.com/",
          title: "",
          code: -105,
          description: "failed",
        }),
      ).favicon,
    ).toBeNull();
    expect(projectDesktopState(state({ kind: "Idle" })).favicon).toBeNull();
  });

  it("hides a guest that another window owns", () => {
    const success = state({ kind: "Success", url: "https://example.com/", title: "" });
    expect(projectDesktopState(success, 7)).toMatchObject({
      hasWebContents: true,
      hostedElsewhere: false,
    });
    expect(projectDesktopState(success, 8)).toMatchObject({
      hasWebContents: false,
      hostedElsewhere: true,
    });
    expect(projectDesktopState({ ...success, hostWebContentsId: null }, 8)).toMatchObject({
      hasWebContents: true,
      hostedElsewhere: false,
    });
  });
});
