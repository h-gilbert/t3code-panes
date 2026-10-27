import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

import { T3_CODE_BACKGROUND_BROWSER_INSTRUCTIONS } from "./PreviewBrowserInstructions.ts";

/**
 * Codex cuts the middle out of any `additionalContext` value over 1,000 tokens,
 * which it counts as UTF-8 bytes divided by four. It does this silently, so
 * every value built here has to fit.
 */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = `## T3 Code devices

For simulators, emulators, and physical phones/tablets, try \`device_list\`, then \`device_open\`. Use its exact \`agent-device\` launcher and target flags on every command. Prefer snapshot refs over coordinates and use \`device_screenshot\` for captures. Reuse this thread's device; otherwise choose the only matching connected device and ask if several match. Coordinate with another thread before using its physical device.

When T3 cannot discover, open, stream, or control connected hardware, report the exact limitation and continue with the host's agent-device or native device tools, including adb for Android UI control. Use explicit device IDs. Missing emulator tooling does not make physical Android unavailable. Live video is optional: continue using screenshots and snapshots. Never stop merely because a tool instruction assumes a simulator. Preserve device-support and agent-access settings; fallback must not bypass disabled access or a permission denial.

A requested physical-device test includes installing the development app and automation helpers, signing in, UI interaction, captures, and task-related settings. Set up a signed iOS runner when needed, respecting the shared compilation lock. Ask only for trust, Developer Mode, or credentials you cannot supply. USB and already-paired wireless devices on configured hosts are supported targets. Preserve unrelated apps, data, and running work.`;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    T3_CODE_BACKGROUND_BROWSER_INSTRUCTIONS,
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
  };
}
