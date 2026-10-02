import { describe, expect, it } from "vite-plus/test";

import { fileChooserDialogOptions, isAgentDrivenTab } from "./FileTransfer.ts";

describe("isAgentDrivenTab", () => {
  it("belongs to the agent only until a person uses the tab", () => {
    expect(isAgentDrivenTab(undefined, undefined)).toBe(false);
    expect(isAgentDrivenTab(0, undefined)).toBe(true);
    expect(isAgentDrivenTab(2, 2)).toBe(true);
    expect(isAgentDrivenTab(2, 3)).toBe(false);
  });
});

describe("fileChooserDialogOptions", () => {
  it("keeps extension filters and drops MIME patterns macOS cannot express", () => {
    expect(
      fileChooserDialogOptions({ multiple: false, accept: ".PDF, .png", directory: false }),
    ).toEqual({
      properties: ["openFile"],
      filters: [{ name: "Accepted files", extensions: ["pdf", "png"] }],
    });
    expect(
      fileChooserDialogOptions({ multiple: true, accept: "image/*,.png", directory: false }),
    ).toEqual({ properties: ["openFile", "multiSelections"] });
    expect(fileChooserDialogOptions({ multiple: false, accept: "", directory: true })).toEqual({
      properties: ["openDirectory"],
    });
  });
});
