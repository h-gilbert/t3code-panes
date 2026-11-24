import type { ProviderInteractionMode } from "@t3tools/contracts";

// Codex truncates entries over 4,000 bytes; keep each section self-contained and below that limit.
export const T3_CODE_ORCHESTRATION_SECTIONS: ReadonlyArray<string> = [
  `## T3 Code orchestration

Ordinary coding tasks need no T3 tools.

- Subagents: use your native tool only when it supports the selected provider and model and there are no requested or inherited model options. Use \`delegate_task\` for explicitly T3-owned work (including a request to use \`delegate_task\`), another provider's model, model options, background work, or a separate checkout (\`isolation:"worktree"\`). Use Workflow only when asked.
- Call \`orchestrator_capabilities\` before the first \`delegate_task\` in a thread to discover live providers and models, including custom ones. Refresh it after an error or a user-named provider change. Put settings in \`target.options\`, including nonempty \`inheritedOptions\` when keeping the parent's provider and model. Check the returned provider, model and options. Never silently downgrade. Report unavailable options and do not switch unasked. Retain each \`taskId\` for follow-up operations. \`childThreadId\` identifies the stored conversation. Never create a child's checkout in the shell or task prompt.
- Every new delegate review or re-check is a new \`delegate_task\` (brief, findings, objections), never a \`t3_thread_send\`. Fix small review findings yourself; start no delegate for them. When told to proceed without a delegate, or to run fewer, \`task_cancel\` the extras. Start no replacement.
- Follow a running delegate's \`next\`. Don't poll it (\`task_status\`, \`sleep\`, watchers, Monitor, ScheduleWakeup). Stop a delegate run you replace or no longer need with \`task_cancel\`, never \`t3_thread_interrupt\` on a \`childThreadId\`.
- As a subagent or child, do the work yourself. Start no subagents unless your task says to.`,
  `- \`t3_thread_launch\` and \`create_threads\` make new top-level threads, only when the user asks for a new thread. "Subagent", "delegate", and "parallel" never mean one. Worktree thread: set \`workspaceStrategy\`. Honor a requested base. Otherwise independent work uses the default branch as \`remote/branch\` with \`startFromOrigin:true\`; with no remote, use the local default. Required unpublished commits and dependent work use their local base. Shell worktrees don't bind it, and no checkout setup in its prompt. No \`workspaceStrategy\`: project root, not your worktree.
- Given a thread id, \`t3_thread_read\` it before you answer about it. Asked to settle a thread, this one too: \`t3_thread_organize\`.
- Another machine: \`t3_environment_links\` lists linked ones. Pass its \`environmentId\` and that machine's \`threadId\` to T3 tools.
- Unlinked ("delegate this to my vps"): \`t3_environment_link\` with a \`hint\` from the user's words, never a pairing code in chat. No link tools: say to enable Settings → Labs → Linked environments.
- In your reply, use each thread's \`link\` verbatim on first mention. If absent, use \`[title](t3-thread://v1/<exact id>)\`.
- For a login, token, PIN, pairing code or sudo password only the user can give, call \`request_secret\` yourself. Pass its \`secretRef\` to a T3 tool or use \`delivery: "file"\` for a command. If \`sudo -n <cmd>\` needs a password, use \`sudo -S -p '' <cmd> < "$file"\`. Pass any other input as a file argument since sudo uses stdin. Asked only to schedule: \`schedule_task\` without running its prompt.
- T3 tools may load late. Try the name once before you call it absent.`,
  `### Visuals and preview

- Answer data with a trend or comparison with a chart and show any visual the user asks for here: pass an HTML file path or inline HTML to \`html_preview\`, then \`html_render\`. A screenshot on disk or a text description doesn't show it. Never start a server for it. Page tools write only on user request. Never use them to show results. Asked for an image to post, send or use elsewhere: a \`.png\` file and its path, never \`html_render\`.
- Use \`preview_*\` for browser work, including verifying frontend edits. Keep routine automation in the background. Use web fetch or search for public pages when browser work is unnecessary. Close tabs you created unless the user requested or uses them.`,
];

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

${T3_CODE_ORCHESTRATION_SECTIONS.join("\n\n")}
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

Use \`preview_*\` for the browser shared with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Read the user's tab when asked about it. While its owner is human, use read-only snapshots or open your own tab; use saved profiles by passing \`profileId\`. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user or an invoked workflow asks, or two preview calls fail on one step. Quote the error when switching after failure.

Keep routine browser automation headless and in the background. Do not activate windows or use desktop-wide input. Ask before visible sign-in or focus changes unless already requested. Resume background work after manual interaction.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices${loadTools}

For simulators, emulators, and physical phones/tablets, try \`device_list\`, then \`device_open\`. Use its exact \`agent-device\` launcher and target flags on every command. Prefer snapshot refs over coordinates and use \`device_screenshot\` for captures. For remote hosts over ssh, keep its returned \`hostId\` and launcher. Run the returned command for device interaction; its snapshots, screenshots and input need \`open <app>\` first, so open the app before using them. Reuse this thread's device; otherwise choose the only matching connected device and ask if several match. Coordinate with another thread before using its physical device.

If a device tool fails, follow its advice once, but never reuse or close another session; if it still fails, report the error and use the fallback below.

When T3 cannot discover, open, stream, or control connected hardware, report the exact limitation and continue with the host's agent-device or native device tools, including adb for Android UI control. Use explicit device IDs. Missing emulator tooling does not make physical Android unavailable. Live video is optional: continue using screenshots and snapshots. Never stop merely because a tool instruction assumes a simulator. Preserve device-support and agent-access settings; fallback must not bypass disabled access or a permission denial.

A requested physical-device test includes installing the development app and automation helpers, signing in, UI interaction, captures, and task-related settings. Set up a signed iOS runner when needed, respecting the shared compilation lock. Ask only for trust, Developer Mode, or credentials you cannot supply. USB and already-paired wireless devices on configured hosts are supported targets. Preserve unrelated apps, data, and running work.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. On Windows, run \`T3_ACP_MCP_CALL\` instead and pipe the JSON to stdin, as in PowerShell \`'{}' | & $env:T3_ACP_MCP_CALL orchestrator_capabilities -\`, writing non-ASCII characters as \`\\uXXXX\` escapes.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
  /** Guidance for this provider's own tools, sent until `providerInstructionsDelivered`. */
  readonly providerInstructions?: string;
  readonly providerInstructionsDelivered?: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  const instructions = [
    !input.orchestrationDelivered
      ? orchestrationInstructions(input.hasDeviceTools)
      : input.hasDeviceTools && !input.deviceInstructionsDelivered
        ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS
        : undefined,
    input.providerInstructionsDelivered === true ? undefined : input.providerInstructions,
  ].flatMap((part) => (part === undefined ? [] : [part.trim()]));
  return instructions.length === 0
    ? input.prompt
    : prependT3OrchestrationInstructions(input.prompt, instructions.join("\n\n"));
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}
