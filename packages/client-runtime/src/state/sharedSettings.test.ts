import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  filterSharedServerPatch,
  pickSharedServerSettings,
  findSharedSettingsMismatches,
  splitSharedServerPatch,
  supportsSharedSettingsSync,
} from "./sharedSettings.ts";

const primaryId = EnvironmentId.make("env-primary");
const boxId = EnvironmentId.make("env-box");

const restartCapabilities = { threadRestartContinuation: true };

describe("supportsSharedSettingsSync", () => {
  it("accepts only connected servers that advertise the shared-settings capability", () => {
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
      }),
    ).toBe(true);
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: {} } },
      }),
    ).toBe(false);
    expect(
      supportsSharedSettingsSync({
        connection: { phase: "reconnecting" },
        serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
      }),
    ).toBe(false);
  });
});

describe("splitSharedServerPatch", () => {
  it("shares one starred default with Mac and Fred, including clear", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    for (const starredModelSelection of [selection, null]) {
      const patch = { starredModelSelection };
      expect(splitSharedServerPatch(patch)).toEqual({ sharedPatch: patch, localPatch: {} });
      expect(filterSharedServerPatch(patch, restartCapabilities, DEFAULT_SERVER_SETTINGS)).toEqual(
        patch,
      );
    }
    expect(
      findSharedSettingsMismatches({
        primaryEnvironmentId: primaryId,
        primarySettings: { ...DEFAULT_SERVER_SETTINGS, starredModelSelection: selection },
        environments: [
          {
            environmentId: boxId,
            label: "Fred",
            syncEligible: true,
            settings: DEFAULT_SERVER_SETTINGS,
          },
        ],
      }),
    ).toEqual([{ environmentId: boxId, label: "Fred" }]);
  });

  it("does not share a starred model with a disabled provider or a different driver", () => {
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
    expect(
      filterSharedServerPatch({ starredModelSelection: selection }, restartCapabilities, {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          ...DEFAULT_SERVER_SETTINGS.providerInstances,
          [selection.instanceId]: {
            ...DEFAULT_SERVER_SETTINGS.providerInstances[selection.instanceId],
            enabled: false,
          },
        },
      }),
    ).toEqual({});
    expect(
      filterSharedServerPatch(
        { starredModelSelection: selection },
        restartCapabilities,
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            ...DEFAULT_SERVER_SETTINGS.providerInstances,
            [selection.instanceId]: {
              ...DEFAULT_SERVER_SETTINGS.providerInstances[selection.instanceId],
              driver: ProviderDriverKind.make("claudeAgent"),
            },
          },
        },
        DEFAULT_SERVER_SETTINGS,
      ),
    ).toEqual({});
  });

  it("keeps project overrides local: project ids belong to one environment", () => {
    const patch = {
      projectSettingsOverrides: { [ProjectId.make("project")]: { defaultAutoPull: true } },
      sidebarAutoSettleOnMerge: false,
    };
    expect(splitSharedServerPatch(patch)).toEqual({
      sharedPatch: { sidebarAutoSettleOnMerge: false },
      localPatch: { projectSettingsOverrides: patch.projectSettingsOverrides },
    });
  });

  it.each([
    {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      options: [{ id: "effort", value: "high" }],
    },
    DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
  ])("shares the text generation model and options, including reset (%j)", (selection) => {
    const patch = { textGenerationModelSelection: selection };
    expect(splitSharedServerPatch(patch)).toEqual({ sharedPatch: patch, localPatch: {} });
    expect(pickSharedServerSettings({ ...DEFAULT_SERVER_SETTINGS, ...patch })).toMatchObject(patch);
    const environment = {
      environmentId: boxId,
      label: "Remote Box",
      syncEligible: true,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: { ...selection, model: "different-model" },
      },
    };
    const input = {
      primaryEnvironmentId: primaryId,
      primarySettings: { ...DEFAULT_SERVER_SETTINGS, ...patch },
      environments: [environment],
    };
    expect(findSharedSettingsMismatches(input)).toEqual([
      { environmentId: boxId, label: "Remote Box" },
    ]);
    expect(
      findSharedSettingsMismatches({
        ...input,
        environments: [{ ...environment, settings: input.primarySettings }],
      }),
    ).toEqual([]);
  });

  it("routes preference keys to the shared patch and machine keys to the local patch", () => {
    const { sharedPatch, localPatch } = splitSharedServerPatch({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      continueThreadsAfterServerUpdate: true,
      enableAgentBrowserAccess: false,
      defaultThreadEnvMode: "worktree",
      newWorktreesStartFromOrigin: true,
    });
    expect(sharedPatch).toEqual({
      sidebarAutoSettleAfterDays: 7,
      sidebarAutoSettleOnMerge: false,
      continueThreadsAfterServerUpdate: true,
      newWorktreesStartFromOrigin: true,
    });
    expect(localPatch).toEqual({
      enableAgentBrowserAccess: false,
      defaultThreadEnvMode: "worktree",
    });
  });
});

describe("pickSharedServerSettings", () => {
  it("returns only the shared keys", () => {
    expect(
      Object.keys(pickSharedServerSettings(DEFAULT_SERVER_SETTINGS, restartCapabilities)).sort(),
    ).toEqual([
      "autoResumeLimitedThreads",
      "continueThreadsAfterServerUpdate",
      "newWorktreesStartFromOrigin",
      "sidebarAutoSettleAfterDays",
      "sidebarAutoSettleOnMerge",
      "snoozeLimitedThreads",
      "snoozePresets",
      "sourceControlWritingStyle",
      "starredModelSelection",
      "textGenerationModelSelection",
    ]);
  });
});

describe("filterSharedServerPatch", () => {
  it("holds the restart preference until the target's config loads", () => {
    const patch = { continueThreadsAfterServerUpdate: true, sidebarAutoSettleAfterDays: 7 };
    expect(filterSharedServerPatch(patch, undefined)).toEqual({ sidebarAutoSettleAfterDays: 7 });
    expect(filterSharedServerPatch(patch, DEFAULT_SERVER_SETTINGS)).toEqual(patch);
  });

  it.each([true, false])(
    "resets a disabled default provider only on the originating environment (%s)",
    (targetIsSource) => {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
          claudeAgent: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: {},
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
      };
      const patch = {
        textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      };
      expect(filterSharedServerPatch(patch, settings, settings, targetIsSource)).toEqual({
        ...(targetIsSource
          ? { textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection }
          : {}),
        continueThreadsAfterServerUpdate: true,
        sidebarAutoSettleAfterDays: 7,
      });
    },
  );

  it.each(["missing", "disabled", "different-driver", "enabled"] as const)(
    "shares a custom model only when its target provider is enabled (%s)",
    (availability) => {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const selection = {
        instanceId,
        model: "gpt-5.6-luna",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      const instance = {
        driver: ProviderDriverKind.make(
          availability === "different-driver" ? "claudeAgent" : "codex",
        ),
        enabled: availability !== "disabled",
        config: {},
      };
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: availability === "missing" ? {} : { [instanceId]: instance },
      };
      const patch = { sidebarAutoSettleAfterDays: 7, textGenerationModelSelection: selection };
      const sourceSettings = {
        ...settings,
        providerInstances: {
          [instanceId]: { ...instance, driver: ProviderDriverKind.make("codex"), enabled: true },
        },
      };
      expect(filterSharedServerPatch(patch, settings, sourceSettings)).toEqual(
        availability === "enabled" ? patch : { sidebarAutoSettleAfterDays: 7 },
      );
    },
  );
});
