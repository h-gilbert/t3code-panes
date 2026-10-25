import {
  PreviewAutomationAutofillInput,
  PreviewAutomationAutofillResult,
  ToolActivityIcon,
  PreviewAutomationClickInput,
  PreviewAutomationCloseInput,
  PreviewAutomationCloseResult,
  PreviewAutomationDownloadArtifact,
  PreviewAutomationDownloadInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationInputResult,
  OrchestratorMcpFailure,
  PreviewAutomationDialogInput,
  PreviewAutomationDragInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
  PreviewAutomationSelectInput,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationTypeInput,
  PreviewAutomationUploadInput,
  PreviewAutomationUploadResult,
  PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields).annotate({
  description: "The preview action completed successfully.",
});

const PreviewInputActionResult = Schema.Struct({
  ...presentationFields,
  ...PreviewAutomationInputResult.fields,
}).annotate({
  description:
    "The preview action completed. fileChooser is set when it opened a file picker, which waits for preview_upload without a target.",
});

/** Drives the real browser and can destroy page state. */
const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether a collaborative browser tab is automation-capable, including its control owner, pending dialog, URL, title, visibility, loading state, viewport mode, and measured CSS-pixel size. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. Server hosts also list every tab in the thread (tabs) with its owner, including tabs the user opened, and the browser profiles preview_open accepts. You can read any listed tab; act only on your own tabs, or on an unclaimed tab while no human controls it. While another agent session is mid-interaction, heldByAnotherSession is true and competing actions fail until that step finishes.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a collaborative browser tab with visibility controlled by the user’s auto-show preference, off by default. Use open=false for routine background automation and open=true when the user asks to see the page. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab. Parallel subagents sharing a provider session must each open with reuseExistingTab=false and pass their returned tabId on every call. Pass profileId (an id or name from preview_status profiles) to open under a browser profile and its saved logins; omit it for the user's default profile. Another agent session's tabs can be read but not operated.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss the dialog `preview_status` reports. Pass `promptText` to accept a prompt. Needs your own tab, or an unclaimed one. Desktop hosts may not support this.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate the chosen tab. Pass `url` for a website, or `target:{kind:'environment-port',port}` for a dev server. Exactly one of `url` and `target`.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize the chosen tab: {mode:'fill'}, {mode:'freeform',width,height}, or {mode:'preset',preset,orientation}. Changes CSS size only, not the user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Set `prefers-color-scheme` for the chosen tab: 'dark', 'light', or 'system' to clear the override.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page before interacting. Pass tabId to inspect a specific tab, including one the user opened (see preview_status tabs), even while they control it; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. Returns page state, semantic elements, diagnostics, action history, and a PNG screenshot. Server snapshots include an accessibilityTree with refs; pass locator=aria-ref=<ref> to target one exact element, including inside frames. Refresh refs after navigation, another snapshot, or human takeover. The text is capped near 20 KB and lists what it omitted; use preview_evaluate to read more. Set includeImage=false for text-only output. Set save=true to also write the PNG to disk; with includeImage=false, return only the url and screenshotPath. Embed that path in your reply as ![alt](screenshotPath) so the user sees it. This is the only way to show the user a screenshot; the image in the tool result is not saved anywhere.",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Include the PNG image in the tool response. Defaults to true. Set false for text-only output.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Write the screenshot PNG to disk and return its absolute path as screenshotPath. With includeImage=false, return only the url and screenshotPath. Defaults to false.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together. Set button=right or clickCount=2 for server tabs. A file picker the click opens is held without a native dialog and reported as fileChooser; a file the click downloads is held for preview_download without a Save dialog.",
    parameters: PreviewAutomationClickInput,
    success: PreviewInputActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description: "Type literal text into one input. `clear=true` replaces the current text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewHoverTool = safeBrowserTool(
  Tool.make("preview_hover", {
    description: "Hover one target to show menus or tooltips.",
    parameters: PreviewAutomationHoverInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Hover preview page"),
);

const PreviewSelectTool = browserTool(
  Tool.make("preview_select", {
    description:
      "Pick options in one native <select>, by value or label. For a custom dropdown, click it open, then click the option.",
    parameters: PreviewAutomationSelectInput,
    success: Schema.Struct({
      ...PreviewAutomationSelectResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Select preview option"),
);

const PreviewDragTool = browserTool(
  Tool.make("preview_drag", {
    description: "Drag one element onto another.",
    parameters: PreviewAutomationDragInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Drag in preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description: "Press one key, such as {key:'Enter'} or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewInputActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the chosen tab, or one container with a locator or selector. Positive `deltaY` scrolls down. Positive `deltaX` scrolls right.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

/** Wrap non-objects: MCP requires object structuredContent, and Claude Code rejects invalid results entirely. */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
});

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Needs the same control as clicking: it works on your own tabs and on the user's tab only while nobody controls it. To read a tab the user is driving, use preview_snapshot. Returns {value} with a serializable result up to 64 KB; the expression may mutate page state. A document that runs agent JavaScript cannot receive saved-login autofill, and evaluation is unavailable after password autofill. A full navigation resets either restriction.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until all given locator, selector, text, and URL conditions match in the chosen tab.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording the chosen tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the chosen tab. Returns a local path to the recording file (max 50 MiB).",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Choose files for a page's file picker in the tab selected by tabId, or this agent session's current tab when omitted. No native file dialog opens. Pass absolute paths from this agent's environment; they are copied to the browser even when it runs on another machine. Target an <input type=file>, its label, or the button that opens the picker with locator or selector, or omit the target to answer the picker your last click or key press opened.",
    parameters: PreviewAutomationUploadInput,
    success: Schema.Struct({ ...PreviewAutomationUploadResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [
      ...dependencies,
      FileSystem.FileSystem,
      Path.Path,
      ServerConfig.ServerConfig,
      ServerSecretStore.ServerSecretStore,
    ],
  }).annotate(Tool.Title, "Upload files to preview page"),
);

const PreviewDownloadTool = safeBrowserTool(
  Tool.make("preview_download", {
    description:
      "Receive a file your actions downloaded in the tab selected by tabId, or this agent session's current tab when omitted. Downloads started by your clicks or key presses never show a Save dialog; they wait in the browser until you call this. Returns the oldest download not yet received, waiting up to timeoutMs for one to start and finish, and copies it (up to 50 MiB) into this agent's environment. Returns its environment-local path.",
    parameters: PreviewAutomationDownloadInput,
    success: Schema.Struct({ ...PreviewAutomationDownloadArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, Path.Path, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Receive browser download"),
);

export const PreviewAutofillTool = browserTool(
  Tool.make("preview_autofill", {
    description:
      "Fill the current page's login form from the user's saved browser logins. Logins are bound to the exact page origin and profile; the password is typed directly into the page and never returned. Returns filled=false with a reason when no saved login matches, several match (pass username), or the page has no login fields.",
    parameters: PreviewAutomationAutofillInput,
    success: PreviewAutomationAutofillResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Autofill saved login"),
);

export const PreviewCloseTool = safeBrowserTool(
  Tool.make("preview_close", {
    description:
      "Close the collaborative browser tab selected by tabId, or this agent session's current tab when omitted. Ends the shared session and removes the tab from every connected client, including its inline preview.",
    parameters: PreviewAutomationCloseInput,
    success: PreviewAutomationCloseResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Close browser preview"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
  PreviewUploadTool,
  PreviewDownloadTool,
  PreviewAutofillTool,
  PreviewCloseTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
  PreviewHoverTool,
  PreviewSelectTool,
  PreviewDragTool,
  PreviewPressTool,
  PreviewScrollTool,
  PreviewEvaluateTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
  PreviewUploadTool,
  PreviewDownloadTool,
  PreviewAutofillTool,
  PreviewCloseTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
