import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderIndependentModelName } from "./providerIconUtils";

describe("getProviderIndependentModelName", () => {
  it("removes the Claude provider prefix", () => {
    expect(
      getProviderIndependentModelName(
        { slug: "claude-fable-5", name: "Claude Fable 5" },
        ProviderDriverKind.make("claudeAgent"),
        "Claude",
      ),
    ).toBe("Fable 5");
  });

  it("removes provider aliases without changing the model family", () => {
    expect(
      getProviderIndependentModelName(
        { slug: "gpt-5.6-sol", name: "OpenAI GPT-5.6-Sol" },
        ProviderDriverKind.make("codex"),
        "Codex",
      ),
    ).toBe("GPT-5.6-Sol");
  });

  it("preserves names that do not repeat their provider", () => {
    expect(
      getProviderIndependentModelName(
        { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
        ProviderDriverKind.make("codex"),
        "Codex Personal",
      ),
    ).toBe("GPT-5.6-Sol");
  });
});

import { getDisplayModelName, getProviderRowLabel } from "./providerIconUtils";

describe("getProviderRowLabel", () => {
  it("shows a sub-provider named after its provider on its own", () => {
    expect(getProviderRowLabel("OpenCode", "OpenCode Zen")).toBe("OpenCode Zen");
    expect(getProviderRowLabel("OpenCode", "OpenCode Go")).toBe("OpenCode Go");
  });

  it("keeps a provider id that merely starts like the provider name", () => {
    expect(getProviderRowLabel("OpenCode", "opencode-go")).toBe("OpenCode · opencode-go");
  });

  it("joins a sub-provider that names something else", () => {
    expect(getProviderRowLabel("OpenCode", "GitHub Copilot")).toBe("OpenCode · GitHub Copilot");
  });

  it("keeps the provider name when a model has no sub-provider", () => {
    expect(getProviderRowLabel("Claude", undefined)).toBe("Claude");
  });
});

describe("getDisplayModelName", () => {
  it("drops a leading sub-provider qualifier from the model name", () => {
    expect(
      getDisplayModelName({
        slug: "a/b",
        name: "OpenCode Zen: Step 5",
        subProvider: "OpenCode Zen",
      }),
    ).toBe("Step 5");
  });
});
