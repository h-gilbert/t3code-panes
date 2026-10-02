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
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationScrollInput,
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
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

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

/** Same open-world browser access, but the action does not destroy page state. */
const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

/** A safe browser action that only observes, so it is also repeatable. */
const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report whether a collaborative browser tab is automation-capable, including its URL, title, visibility, loading state, viewport mode, and measured CSS-pixel size. `available` means the tab can be driven at all, not that it is free: when another agent session is mid-interaction on it, `heldByAnotherSession` is true and an interaction now would fail until that step finishes. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewAutomationError,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Initialize a collaborative browser tab. Visibility defaults to the user’s auto-show preference, which is off by default. Use open=false for routine background automation; use open=true when the user asks to see the page or the task requires human interaction. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://t3.chat'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

export const PreviewSnapshotTool = readonlyBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Inspect a page before interacting. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab. Returns page state, semantic elements, diagnostics, action history, and a PNG screenshot. The text is capped near 20 KB and lists what it omitted; use preview_evaluate to read more. Set includeImage=false for text-only output with the same page metadata. Set save=true to also write the PNG to disk and get screenshotPath back; with includeImage=false, save=true returns only the url and screenshotPath. Embed that path in your reply as ![alt](screenshotPath) so the user sees it. This is the only way to show the user a screenshot; the image in the tool result is not saved anywhere.",
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
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewClickTool = browserTool(
  Tool.make("preview_click", {
    description:
      "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together. A file picker the click opens is held without a native dialog and reported as fileChooser; a file the click downloads is held for preview_download without a Save dialog.",
    parameters: PreviewAutomationClickInput,
    success: PreviewInputActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Click preview page"),
);

const PreviewTypeTool = browserTool(
  Tool.make("preview_type", {
    description:
      "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
    parameters: PreviewAutomationTypeInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Type into preview page"),
);

const PreviewPressTool = browserTool(
  Tool.make("preview_press", {
    description:
      "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
    parameters: PreviewAutomationPressInput,
    success: PreviewInputActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Press key in preview page"),
);

const PreviewScrollTool = safeBrowserTool(
  Tool.make("preview_scroll", {
    description:
      "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
    parameters: PreviewAutomationScrollInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Scroll preview page"),
);

/**
 * MCP `structuredContent` must be a JSON object, and Claude Code rejects the
 * whole result when it is not. Wrapping keeps arrays, strings, numbers, and
 * null valid instead of failing only for non-object expressions.
 */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
}).annotate({ description: "The evaluated expression result." });

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Returns {value} with a serializable result up to 64 KB; the expression may mutate page state. A document that runs agent JavaScript cannot receive saved-login autofill, and evaluation is unavailable after password autofill. A full navigation resets either restriction.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description:
      "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and transfer the compressed recording once (up to 50 MiB) to an evidence file readable in this agent's environment. Returns its environment-local path after transfer succeeds.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewAutomationError,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

const PreviewUploadTool = browserTool(
  Tool.make("preview_upload", {
    description:
      "Choose files for a page's file picker in the tab selected by tabId, or this agent session's current tab when omitted. No native file dialog opens. Pass absolute paths from this agent's environment; they are copied to the browser even when it runs on another machine. Target an <input type=file>, its label, or the button that opens the picker with locator or selector, or omit the target to answer the picker your last click or key press opened.",
    parameters: PreviewAutomationUploadInput,
    success: Schema.Struct({ ...PreviewAutomationUploadResult.fields, ...presentationFields }),
    failure: PreviewAutomationError,
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
    failure: PreviewAutomationError,
    dependencies: [...dependencies, FileSystem.FileSystem, Path.Path, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Receive browser download"),
);

export const PreviewAutofillTool = browserTool(
  Tool.make("preview_autofill", {
    description:
      "Fill the current page's login form from the user's saved browser logins. Logins are bound to the exact page origin and profile; the password is typed directly into the page and never returned. Returns filled=false with a reason when no saved login matches, several match (pass username), or the page has no login fields.",
    parameters: PreviewAutomationAutofillInput,
    success: PreviewAutomationAutofillResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Autofill saved login"),
);

export const PreviewCloseTool = safeBrowserTool(
  Tool.make("preview_close", {
    description:
      "Close the collaborative browser tab selected by tabId, or this agent session's current tab when omitted. Ends the shared session and removes the tab from every connected client, including its inline preview.",
    parameters: PreviewAutomationCloseInput,
    success: PreviewAutomationCloseResult,
    failure: PreviewAutomationError,
    dependencies,
  }).annotate(Tool.Title, "Close browser preview"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewClickTool,
  PreviewTypeTool,
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
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewClickTool,
  PreviewTypeTool,
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
