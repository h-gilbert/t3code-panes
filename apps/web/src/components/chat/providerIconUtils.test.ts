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
