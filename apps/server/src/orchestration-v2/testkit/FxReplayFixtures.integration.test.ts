import { describe } from "@effect/vitest";

import { FxOrchestratorReplayHarness } from "../Adapters/FxAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("fx replay fixtures", () => {
  // Fx recordings without an explicit mode were recorded in Supervised mode.
  itRunsReplayFixtures("fx", (input) =>
    runReplayFixture({
      ...input,
      buildInput: () => {
        const fixtureInput = input.buildInput();
        return {
          ...fixtureInput,
          runtimeMode: fixtureInput.runtimeMode ?? "approval-required",
        };
      },
      harness: FxOrchestratorReplayHarness,
    }),
  );
});
