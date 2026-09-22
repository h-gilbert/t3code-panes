import { describe, expect, it } from "vite-plus/test";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";
import { T3_CODE_BACKGROUND_BROWSER_INSTRUCTIONS } from "./PreviewBrowserInstructions.ts";

describe("Codex tool availability in this fork", () => {
  it.each(["default", "plan"] as const)(
    "keeps background browser guidance with device-only tools in %s mode",
    (mode) => {
      const instructions = buildCodexDeveloperInstructions(
        mode,
        { model: "gpt-6-astra", reasoningEffort: "medium" },
        { browser: false, device: true },
      );
      expect(instructions).toContain(T3_CODE_BACKGROUND_BROWSER_INSTRUCTIONS);
      expect(instructions).toContain("device_open");
      expect(instructions).not.toContain("## T3 Code collaborative browser");
    },
  );
  it("does not advertise device tools when they are unavailable", () => {
    const instructions = buildCodexDeveloperInstructions(
      "default",
      { model: "gpt-6-astra", reasoningEffort: "medium" },
      false,
    );
    expect(instructions).toContain(T3_CODE_BACKGROUND_BROWSER_INSTRUCTIONS);
    expect(instructions).not.toContain("device_open");
  });
});
