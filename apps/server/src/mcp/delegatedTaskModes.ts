import {
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** How much a runtime mode allows, narrowest first. */
export function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

/** How much an interaction mode allows: plan, then default. */
export function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message: `Runtime mode ${resolved} exceeds this caller's authorized ceiling ${parentMode}. Have the user raise the calling thread's access or approve a new MCP client grant before retrying.`,
      }),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  return Effect.fail(
    new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Provider ${target?.modelSelection.instanceId} does not offer ${inherited ? "inherited" : "requested"} runtime mode ${resolved}. Choose another access mode or provider. Supported modes: ${supported.join(", ")}.`,
    }),
  );
}

/** The same, for interaction modes. */
export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "interaction_mode_escalation_denied",
          message: `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        }),
      )
    : Effect.succeed(resolved);
}

/** The task as its child receives it, with the role the caller asked for. */
export function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}
