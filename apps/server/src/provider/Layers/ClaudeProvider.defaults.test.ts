import { assert, it } from "@effect/vitest";

import {
  getClaudeCatalogModelCapabilities,
  BUNDLED_CLAUDE_MODEL_CATALOG,
} from "../ClaudeModelCatalog.ts";

it("defaults Claude Opus 4.8 to medium reasoning", () => {
  const capabilities = getClaudeCatalogModelCapabilities(
    BUNDLED_CLAUDE_MODEL_CATALOG,
    "claude-opus-4-8",
  );
  const effort = capabilities.optionDescriptors?.find(
    (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
  );

  assert.equal(effort?.type === "select" ? effort.currentValue : null, "medium");
  assert.equal(
    effort?.type === "select" ? effort.options.find((option) => option.isDefault)?.id : null,
    "medium",
  );
});
