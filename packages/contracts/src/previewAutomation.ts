import { Schema } from "effect";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
  PreviewBrowserProfileName,
} from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { BrowserProfileId } from "./browserProfile.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(2048));
const URL_GUIDANCE =
  "Absolute http(s) URL or a host such as t3.chat or localhost:5173. Hosts without a scheme use https, or http for loopback.";
const PROFILE_GUIDANCE =
  "Browser profile for a new tab, by id or name from preview_status profiles. Names are case-insensitive. Omit for the user's default profile. A tab keeps its profile.";
// Field annotations survive JSON Schema export through validation and optional wrappers.
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60_000)),
).annotateKey({
  description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000.",
});

export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

/** Advertised by current desktop hosts for mixed-version routing. */
export const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
  "close",
  "autofill",
  "upload",
  "download",
] as const;

export const PREVIEW_AUTOMATION_SERVER_OPERATIONS = [
  ...PREVIEW_AUTOMATION_OPERATIONS,
  "dialog",
  "close",
  "upload",
  "hover",
  "select",
  "drag",
] as const;
export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_SERVER_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(PreviewTabId).annotateKey({
    description:
      "Exact browser tab from preview_status tabs, including a tab the user opened. Omit for this agent session's current tab, or the user's visible tab when this session has none.",
  }),
};

export const PreviewAutomationTabTargetInput = Schema.Struct(PreviewAutomationTabTargetFields);
export type PreviewAutomationTabTargetInput = typeof PreviewAutomationTabTargetInput.Type;

export const PreviewAutomationCloseInput = Schema.Struct(PreviewAutomationTabTargetFields);
export type PreviewAutomationCloseInput = typeof PreviewAutomationCloseInput.Type;

export const PreviewAutomationCloseResult = Schema.Struct({
  tabId: PreviewTabId,
  closed: Schema.Boolean,
});
export type PreviewAutomationCloseResult = typeof PreviewAutomationCloseResult.Type;

export const PreviewAutomationAutofillInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  username: Schema.optional(TrimmedNonEmptyString).annotateKey({
    description:
      "Username selecting between multiple saved logins for the page's origin. Omit when the origin has only one saved login.",
  }),
}).annotate({
  description:
    "Fills the current page's login form from the user's saved browser logins. Credentials are bound to the exact page origin and typed directly into the page. The password is never returned.",
});
export type PreviewAutomationAutofillInput = typeof PreviewAutomationAutofillInput.Type;

export const PreviewAutomationAutofillResult = Schema.Struct({
  filled: Schema.Boolean,
  origin: Schema.NullOr(Schema.String),
  username: Schema.optional(Schema.String),
  reason: Schema.optional(
    Schema.Literals(["no-credential", "ambiguous-credential", "no-fields", "unavailable"]),
  ),
});
export type PreviewAutomationAutofillResult = typeof PreviewAutomationAutofillResult.Type;
/** `human`: a person controls the tab now; `agent`: an agent session opened it; `unclaimed`: neither. */
export const PreviewAutomationTabOwner = Schema.Literals(["agent", "human", "unclaimed"]);

export const PreviewAutomationProfile = Schema.Struct({
  id: BrowserProfileId,
  name: Schema.String,
  incognito: Schema.optional(Schema.Boolean),
});
export type PreviewAutomationProfile = typeof PreviewAutomationProfile.Type;

export const PreviewAutomationStatus = Schema.Struct({
  /**
   * Whether this tab can be driven at all: a live host with an attachable
   * webContents. It never means the caller may drive it right now — that is
   * `heldByAnotherSession`, which only `preview_status` fills in.
   */
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  control: Schema.optional(
    Schema.Struct({
      owner: PreviewAutomationTabOwner,
      ownedByCaller: Schema.Boolean,
      generation: Schema.Number,
    }),
  ),
  dialog: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.String,
        message: Schema.String,
        defaultValue: Schema.String,
      }),
    ),
  ),
  viewportSetting: Schema.optional(PreviewViewportSetting),
  viewport: Schema.optional(PreviewRenderedViewportSize),
  /**
   * Set by the server, not the host: another provider session is driving this
   * exact tab as of this read, so an interaction would fail with
   * `PreviewAutomationBusyError`. Absent when nothing holds the tab, and on
   * results other than `preview_status`.
   */
  heldByAnotherSession: Schema.optional(Schema.Boolean),
  /** The thread driving this tab when `heldByAnotherSession` is set. */
  heldByThreadId: Schema.optional(ThreadId),
  /** Server hosts: a file picker the page opened, answered with preview_upload. */
  fileChooser: Schema.optional(
    Schema.NullOr(Schema.Struct({ multiple: Schema.Boolean, accept: Schema.String })),
  ),
  downloads: Schema.optional(
    Schema.Array(
      Schema.Struct({
        fileName: Schema.String,
        path: Schema.String,
        sizeBytes: Schema.Number,
        url: Schema.String,
        completedAt: Schema.String,
      }),
    ),
  ),
  /** Server hosts: all thread tabs are readable; actions require ownedByCaller or an unclaimed tab without human control. */
  tabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tabId: PreviewTabId,
        url: Schema.NullOr(Schema.String),
        openerTabId: Schema.optional(PreviewTabId),
        owner: Schema.optional(PreviewAutomationTabOwner),
        ownedByCaller: Schema.optional(Schema.Boolean),
        visible: Schema.optional(Schema.Boolean),
        profileId: Schema.optional(BrowserProfileId),
      }),
    ),
  ),
  profiles: Schema.optional(Schema.Array(PreviewAutomationProfile)),
  defaultProfileId: Schema.optional(BrowserProfileId),
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationDialogInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  accept: Schema.Boolean.annotate({
    description: "Accept the dialog when true; dismiss it when false.",
  }),
  promptText: Schema.optional(Schema.String).annotate({
    description: "Text to submit to a prompt dialog.",
  }),
});
export type PreviewAutomationDialogInput = typeof PreviewAutomationDialogInput.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotateKey({
    description: `First page URL. ${URL_GUIDANCE} Omit to open a blank tab.`,
  }),
  open: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Whether to open the thread-bound inline preview for the human. Defaults to the user’s auto-show preference, which is off by default. Set false for background automation; set true when the user requests visibility or the task requires human interaction.",
    }),
  ),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description: "Deprecated alias for open. Whether to show the preview to the human.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Reuse tabId when supplied, otherwise this agent session's current tab. Defaults to true; set false to create a new tab.",
    }),
  ),
  profile: Schema.optional(
    PreviewBrowserProfileName.annotate({
      description:
        "Named persistent browser profile for a NEW tab's cookies and logins (letters, digits, - or _). Sites the user signs into under a profile stay signed in for later sessions. Omit for the environment's shared profile. Only applies when a new tab is created.",
    }),
  ),
  ephemeral: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Open a NEW tab with a fresh in-memory browser session, without cookies or storage from any profile. Discarded when the app quits. Only applies when a new tab is created.",
    }),
  ),
  profileId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).annotateKey({
    description: PROFILE_GUIDANCE,
  }),
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.tabId !== undefined && input.reuseExistingTab === false) ||
        "tabId cannot be combined with reuseExistingTab=false.",
    ),
  )
  .annotate({
    description:
      "Opens the collaborative browser for the current thread. Use preview_navigate afterward when readiness waiting matters.",
  });
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url").annotateKey({
      description: "Navigate directly to a website URL.",
    }),
    url: BoundedUrl.annotateKey({
      description: `Website URL. ${URL_GUIDANCE}`,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port").annotateKey({
      description: "Navigate to a dev-server port in this agent's execution environment.",
    }),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotateKey({ description: "Dev-server TCP port in this agent's execution environment." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Dev-server protocol. Defaults to http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Path, query, and fragment, such as /settings?tab=account.",
      }),
    ),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotateKey({
    description: `Website URL. ${URL_GUIDANCE} Use for public pages and directly reachable URLs.`,
  }),
  target: Schema.optional(BrowserNavigationTarget).annotateKey({
    description:
      "Navigation target with kind=url and url, or kind=environment-port and port, plus optional protocol and path. Provide exactly one of url or target.",
  }),
  readiness: Schema.optional(Schema.Literals(["load", "domContentLoaded", "none"])).annotateKey({
    description:
      "Navigation milestone to wait for. Defaults to load; domContentLoaded waits for the DOM; none returns immediately.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
      "Provide exactly one of url or target.",
  ),
);
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  mode: Schema.Literals(["fill", "freeform", "preset"]).annotate({
    description:
      "Viewport sizing mode. Fill follows the panel, freeform uses width and height, and preset uses a named device size.",
  }),
  preset: Schema.optional(PreviewViewportPresetId).annotate({
    description: "Named device size from the viewport preset catalog. Required in preset mode.",
  }),
  width: Schema.optional(PreviewViewportSize.fields.width).annotate({
    description: "Viewport width in CSS pixels for freeform mode.",
  }),
  height: Schema.optional(PreviewViewportSize.fields.height).annotate({
    description: "Viewport height in CSS pixels for freeform mode.",
  }),
  orientation: Schema.optional(Schema.Literals(["portrait", "landscape"])).annotate({
    description: "Orientation in preset mode. Defaults to the preset's native orientation.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    const hasPreset = input.preset !== undefined;
    const hasWidth = input.width !== undefined;
    const hasHeight = input.height !== undefined;
    if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
    if (input.mode === "fill") {
      return !hasPreset && !hasWidth && input.orientation === undefined
        ? true
        : "Fill mode does not accept a preset, dimensions, or orientation.";
    }
    if (input.mode === "freeform") {
      if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
        return "Freeform mode requires width and height and does not accept a preset or orientation.";
      }
    } else if (!hasPreset || hasWidth || hasHeight) {
      return "Preset mode requires a preset and does not accept custom dimensions.";
    }
    if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
      return `Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;
    }
    return true;
  }),
);
export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});
export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

// Mirrors DesktopPreviewColorScheme without importing ipc.ts.
export const PreviewAutomationColorScheme = Schema.Literals(["system", "light", "dark"]);
export type PreviewAutomationColorScheme = typeof PreviewAutomationColorScheme.Type;

export const PreviewAutomationSetColorSchemeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: PreviewAutomationColorScheme.annotate({
    description: "Emulated page color scheme; system follows the host.",
  }),
});
export type PreviewAutomationSetColorSchemeInput = typeof PreviewAutomationSetColorSchemeInput.Type;

export const PreviewAutomationSetColorSchemeResult = Schema.Struct({
  tabId: PreviewTabId,
  colorScheme: PreviewAutomationColorScheme.annotate({
    description: "Emulated page color scheme; system follows the host.",
  }),
});
export type PreviewAutomationSetColorSchemeResult =
  typeof PreviewAutomationSetColorSchemeResult.Type;

const Locator = TrimmedNonEmptyString.annotate({
  description:
    "Unique Playwright role/text selector or aria-ref=<ref> from the latest snapshot, including iframe elements. Refresh refs after navigation, another snapshot, or control handoff.",
});
const LegacySelector = TrimmedNonEmptyString.annotate({
  description:
    "Legacy CSS selector such as button[type='submit']. Prefer locator for role/text targeting.",
});

const PointerTargetFields = {
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotateKey({
    description:
      "Legacy CSS selector for one element. Prefer locator. Use exactly one target method.",
  }),
  locator: Schema.optional(Locator).annotateKey({
    description:
      "Unique Playwright role/text selector or aria-ref=<ref> from the latest snapshot. Use exactly one target method; refresh stale refs with a new snapshot.",
  }),
  x: Schema.optional(Schema.Finite).annotate({
    description: "Horizontal viewport coordinate in CSS pixels; requires y.",
  }),
  y: Schema.optional(Schema.Finite).annotate({
    description: "Vertical viewport coordinate in CSS pixels; requires x.",
  }),
  timeoutMs: OptionalTimeoutMs,
};

const singlePointerTarget = Schema.makeFilter(
  (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
  }) => {
    const selectorModes =
      Number(input.selector !== undefined) + Number(input.locator !== undefined);
    const hasX = input.x !== undefined;
    const hasY = input.y !== undefined;
    if (hasX !== hasY) return "Coordinates require both x and y.";
    const coordinateModes = hasX && hasY ? 1 : 0;
    return selectorModes + coordinateModes === 1 || "Provide exactly one target.";
  },
);

export const PreviewAutomationClickInput = Schema.Struct({
  ...PointerTargetFields,
  button: Schema.optional(
    Schema.Literals(["left", "right", "middle"]).annotate({
      description: "Mouse button. Defaults to left; right opens the page's context menu.",
    }),
  ),
  clickCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
      description: "1 for a click, 2 for a double-click, 3 for a triple-click. Defaults to 1.",
    }),
  ),
}).check(singlePointerTarget);
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationHoverInput =
  Schema.Struct(PointerTargetFields).check(singlePointerTarget);
export type PreviewAutomationHoverInput = typeof PreviewAutomationHoverInput.Type;

export const PreviewAutomationSelectInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotateKey({
    description: "Legacy CSS selector for a native <select>. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotateKey({
    description:
      "Native <select> element, such as aria-ref=<ref> from the latest snapshot or role=combobox[name='Size'].",
  }),
  values: Schema.Array(Schema.String).check(Schema.isMaxLength(100)).annotate({
    description:
      "Option values or visible labels to select. Pass several for a multiple select, or an empty list to clear it.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.selector !== undefined) + Number(input.locator !== undefined) === 1 ||
      "Provide exactly one of selector or locator.",
  ),
);
export type PreviewAutomationSelectInput = typeof PreviewAutomationSelectInput.Type;

export const PreviewAutomationSelectResult = Schema.Struct({
  selected: Schema.Array(Schema.String).annotate({
    description: "The values of the options now selected.",
  }),
});
export type PreviewAutomationSelectResult = typeof PreviewAutomationSelectResult.Type;

// Required transformed strings lose field descriptions during provider JSON Schema export.
const DescribedLocator = (description: string) =>
  Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty({ description }))
    .annotateKey({ description });

export const PreviewAutomationDragInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  source: DescribedLocator(
    "Locator of the element to drag, such as aria-ref=<ref> from the latest snapshot.",
  ),
  target: DescribedLocator(
    "Locator of the element to drop onto, such as aria-ref=<ref> from the latest snapshot.",
  ),
  timeoutMs: OptionalTimeoutMs,
});
export type PreviewAutomationDragInput = typeof PreviewAutomationDragInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  text: Schema.String.annotate({ description: "Literal text to insert." }),
  selector: Schema.optional(LegacySelector).annotateKey({
    description:
      "Legacy CSS selector for the input. Omit both targets to type into the focused element.",
  }),
  locator: Schema.optional(Locator).annotateKey({
    description:
      "Input locator, such as aria-ref=<ref> from the latest snapshot or role=textbox[name='Message']. Omit both targets to type into the focused element.",
  }),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the input first. Default false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.selector !== undefined && input.locator !== undefined) ||
      "Provide at most one of selector or locator.",
  ),
);
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()).annotateKey({
    description:
      "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
  }),
  modifiers: Schema.optional(
    Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"])),
  ).annotate({ description: "Modifier keys held during the key press." }),
});
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  deltaX: Schema.optional(Schema.Finite).annotate({
    description: "Horizontal scroll distance in CSS pixels; positive scrolls right.",
  }),
  deltaY: Schema.optional(Schema.Finite).annotate({
    description: "Vertical scroll distance in CSS pixels; positive scrolls down.",
  }),
  selector: Schema.optional(LegacySelector).annotateKey({
    description:
      "Legacy CSS selector for a scrollable container. Omit both targets to scroll the viewport.",
  }),
  locator: Schema.optional(Locator).annotateKey({
    description:
      "Scrollable container locator, such as aria-ref=<ref> from the latest snapshot. Omit both targets to scroll the viewport.",
  }),
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    return input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY.";
  }),
);
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export type PreviewAutomationAction = keyof typeof PreviewAutomationActInputs;

/** One flat shape for every page action. The server decodes it with the action's strict input. */
export const PreviewAutomationActInput = Schema.Struct({
  action: Schema.Literals([
    "click",
    "type",
    "hover",
    "select",
    "drag",
    "upload",
    "press",
    "scroll",
  ]).annotateKey({ description: "Page action to perform. Other arguments depend on the action." }),
  ...PreviewAutomationTabTargetFields,
  locator: Schema.optional(Locator).annotateKey({
    description: "Playwright locator, including aria-ref=<ref> from the latest snapshot.",
  }),
  selector: Schema.optional(LegacySelector).annotateKey({
    description: "Legacy CSS selector. Prefer locator.",
  }),
  x: Schema.optional(Schema.Finite).annotateKey({
    description: "Horizontal CSS pixel coordinate; supply y too.",
  }),
  y: Schema.optional(Schema.Finite).annotateKey({
    description: "Vertical CSS pixel coordinate; supply x too.",
  }),
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])).annotateKey({
    description: "Mouse button for click. Default left.",
  }),
  clickCount: Schema.optional(Schema.Int).annotateKey({
    description: "Number of clicks, from 1 to 3.",
  }),
  text: Schema.optional(Schema.String).annotateKey({
    description: "Literal text to insert for type.",
  }),
  clear: Schema.optional(Schema.Boolean).annotateKey({
    description: "Replace existing text before typing.",
  }),
  values: Schema.optional(Schema.Array(Schema.String)).annotateKey({
    description: "Option values or labels to select.",
  }),
  source: Schema.optional(Locator).annotateKey({ description: "Locator of the element to drag." }),
  target: Schema.optional(Locator).annotateKey({ description: "Locator of the drop target." }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotateKey({
    description: "Absolute paths in the agent environment to upload without a native dialog.",
  }),
  key: Schema.optional(Schema.String).annotateKey({
    description: "Keyboard key such as Enter, Escape, or a single character.",
  }),
  modifiers: PreviewAutomationPressInput.fields.modifiers,
  deltaX: Schema.optional(Schema.Finite).annotateKey({
    description: "Horizontal CSS pixel scroll distance; positive scrolls right.",
  }),
  deltaY: Schema.optional(Schema.Finite).annotateKey({
    description: "Vertical CSS pixel scroll distance; positive scrolls down.",
  }),
  timeoutMs: Schema.optional(Schema.Int).annotateKey({
    description: "Maximum wait in milliseconds. Default 15000.",
  }),
});
export type PreviewAutomationActInput = typeof PreviewAutomationActInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  expression: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(64_000))
    .annotateKey({
      description:
        "JavaScript expression evaluated in the page's main frame, such as document.title or location.href.",
    }),
  awaitPromise: Schema.optional(
    Schema.Boolean.annotate({ description: "Await a returned Promise. Defaults to true." }),
  ),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Serialize the result by value instead of returning a remote object reference. Defaults to true.",
    }),
  ),
}).annotate({
  description:
    "Evaluates JavaScript in the page. Prefer snapshot and semantic actions; use evaluate for inspection or unsupported interactions. A document that runs agent JavaScript cannot receive saved-login autofill, and evaluation is unavailable after password autofill. A full navigation resets either restriction.",
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector).annotateKey({
    description: "Legacy CSS selector that must match an element. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotateKey({
    description:
      "Locator that must match an element, such as aria-ref=<ref> from the latest snapshot or role=button[name='Send'].",
  }),
  text: Schema.optional(TrimmedNonEmptyString).annotateKey({
    description: "Case-sensitive substring that must appear in visible document text.",
  }),
  urlIncludes: Schema.optional(TrimmedNonEmptyString).annotateKey({
    description: "Substring that must appear in the current absolute URL.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    return (
      input.selector !== undefined ||
      input.locator !== undefined ||
      input.text !== undefined ||
      input.urlIncludes !== undefined ||
      "Provide at least one wait condition."
    );
  }),
);
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

/**
 * Returned by click and key press. `fileChooser` reports a file picker the
 * action opened; it waits, without a native dialog, for `preview_upload`.
 */
export const PreviewAutomationInputResult = Schema.Struct({
  fileChooser: Schema.optional(Schema.Struct({ multiple: Schema.Boolean })),
});
export type PreviewAutomationInputResult = typeof PreviewAutomationInputResult.Type;

export const PREVIEW_FILE_TRANSFER_MAX_FILES = 10;
export const PREVIEW_FILE_TRANSFER_TIMEOUT_MS = 120_000;
// Browser uploads use disk-backed files, independently of chat attachment limits.
export const PREVIEW_UPLOAD_MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const PREVIEW_UPLOAD_CHUNK_BYTES = 256 * 1024;
export const PREVIEW_UPLOAD_TIMEOUT_MS = 600_000;

const AbsoluteEnvironmentPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096)).annotate({
  description: "Absolute path to a file in this agent's environment.",
});

export const PreviewAutomationUploadInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  timeoutMs: OptionalTimeoutMs,
  paths: Schema.Array(AbsoluteEnvironmentPath)
    .check(Schema.isMaxLength(PREVIEW_FILE_TRANSFER_MAX_FILES))
    .annotate({
      description: `Absolute paths of the files to choose, read from this agent's environment. At most ${PREVIEW_FILE_TRANSFER_MAX_FILES} files of up to 1 GiB each.`,
    }),
  selector: Schema.optional(LegacySelector).annotateKey({
    description: "Legacy CSS selector for the file input or upload control. Prefer locator.",
  }),
  locator: Schema.optional(Locator).annotateKey({
    description:
      "Playwright selector for an <input type=file>, its label, or the button that opens a file picker. Omit to answer the picker your last action opened.",
  }),
})
  .check(
    Schema.makeFilter(
      (input) =>
        !(input.selector !== undefined && input.locator !== undefined) ||
        "Provide at most one of selector or locator.",
    ),
  )
  .annotate({
    description:
      "Chooses files for a page's file picker without showing a native dialog. Target the file input or the control that opens the picker; omit the target to answer a picker an earlier action already opened.",
  });
export type PreviewAutomationUploadInput = typeof PreviewAutomationUploadInput.Type;

/** Strict input for each `preview_act` action. */
export const PreviewAutomationActInputs = {
  click: PreviewAutomationClickInput,
  type: PreviewAutomationTypeInput,
  hover: PreviewAutomationHoverInput,
  select: PreviewAutomationSelectInput,
  drag: PreviewAutomationDragInput,
  upload: PreviewAutomationUploadInput,
  press: PreviewAutomationPressInput,
  scroll: PreviewAutomationScrollInput,
} as const;

/** One file the server staged for the desktop host to fetch. */
export const PreviewAutomationUploadFile = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  /** Signed, relative asset URL on the environment's HTTP origin. */
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PreviewAutomationUploadFile = typeof PreviewAutomationUploadFile.Type;

/** What the server sends the host for `upload`: paths are replaced by fetchable files. */
export const PreviewAutomationUploadRequestInput = Schema.Struct({
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  files: Schema.Array(PreviewAutomationUploadFile),
});
export type PreviewAutomationUploadRequestInput = typeof PreviewAutomationUploadRequestInput.Type;

export const PreviewAutomationUploadResult = Schema.Struct({
  tabId: PreviewTabId,
  fileNames: Schema.Array(Schema.String),
});
export type PreviewAutomationUploadResult = typeof PreviewAutomationUploadResult.Type;

export const PreviewAutomationDownloadInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  timeoutMs: OptionalTimeoutMs,
}).annotate({
  description:
    "Receives the oldest file your actions downloaded in the tab that has not been received yet, waiting for one to start and finish.",
});
export type PreviewAutomationDownloadInput = typeof PreviewAutomationDownloadInput.Type;

export const PreviewAutomationDownloadArtifact = Schema.Struct({
  tabId: PreviewTabId,
  fileName: Schema.String,
  /** Environment-local path of the received file. */
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  /** The URL the page downloaded from. */
  url: Schema.String,
});
export type PreviewAutomationDownloadArtifact = typeof PreviewAutomationDownloadArtifact.Type;

export const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

export const PreviewAutomationConsoleEntry = Schema.Struct({
  level: Schema.String,
  text: Schema.String.annotate({ description: "Literal text to insert." }),
  timestamp: Schema.String,
  source: Schema.optional(Schema.String),
});
export type PreviewAutomationConsoleEntry = typeof PreviewAutomationConsoleEntry.Type;

export const PreviewAutomationNetworkEntry = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  timestamp: Schema.String,
});
export type PreviewAutomationNetworkEntry = typeof PreviewAutomationNetworkEntry.Type;

export const PreviewAutomationActionEvent = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewAutomationActionEvent = typeof PreviewAutomationActionEvent.Type;

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  consoleEntries: Schema.Array(PreviewAutomationConsoleEntry),
  networkEntries: Schema.Array(PreviewAutomationNetworkEntry),
  actionTimeline: Schema.Array(PreviewAutomationActionEvent),
  screenshot: Schema.optional(
    Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  ),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;

export const PreviewAutomationRecordingStatus = Schema.Struct({
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
});
export type PreviewAutomationRecordingStatus = typeof PreviewAutomationRecordingStatus.Type;

export const PREVIEW_RECORDING_STOP_TIMEOUT_MS = 120_000;

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;
export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

export const PreviewAutomationHostIdentity = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
});
export type PreviewAutomationHostIdentity = typeof PreviewAutomationHostIdentity.Type;

export const PreviewAutomationHost = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  /** Missing means the V1 operation set from before capability negotiation. */
  supportedOperations: Schema.optional(Schema.Array(PreviewAutomationOperation)),
});
export type PreviewAutomationHost = typeof PreviewAutomationHost.Type;

export const PreviewAutomationHostFocus = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
  liveTabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        tabId: PreviewTabId,
        visible: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type PreviewAutomationHostFocus = typeof PreviewAutomationHostFocus.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId).annotate({
    description: "Tab from preview_status. Omit to use the current tab.",
  }),
  tabIdExplicit: Schema.optional(Schema.Boolean),
  /** Supplied by the broker from authenticated scope, never from tool input. */
  agentSessionId: Schema.optional(Schema.String),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: PreviewAutomationConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: PreviewAutomationRequest,
  }),
]);
export type PreviewAutomationStreamEvent = typeof PreviewAutomationStreamEvent.Type;

export const PreviewAutomationResponse = Schema.Struct({
  clientId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponse.Type;

const McpCapabilityErrorFields = {
  environmentId: EnvironmentId,
  threadId: Schema.optional(ThreadId),
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
};

export class PreviewAutomationUnavailableError extends Schema.TaggedError<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability: browser preview tools are off for this thread. Do not retry them. To check a page, use a headless browser from the shell, such as Playwright, or curl. The user can turn on "Agent browser access" in Settings; it applies when the agent session next starts.`;
  }
}

export class McpCapabilityUnavailableError extends Schema.TaggedError<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: TrimmedNonEmptyString,
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

const PreviewAutomationScopeErrorFields = {
  operation: PreviewAutomationOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

export const SERVER_BROWSER_AUTOMATION_CLIENT_ID = "server-browser";

const PreviewAutomationRequestErrorFields = {
  ...PreviewAutomationScopeErrorFields,
  clientId: TrimmedNonEmptyString,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  tabId: Schema.optional(PreviewTabId).annotate({
    description: "Tab from preview_status. Omit to use the current tab.",
  }),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
};

const PreviewAutomationRemoteDiagnosticFields = {
  remoteTag: TrimmedNonEmptyString,
  remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.Defect(),
};

const PreviewAutomationOptionalRemoteDiagnosticFields = {
  remoteTag: Schema.optional(TrimmedNonEmptyString),
  remoteMessageLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.optional(Schema.Defect()),
};

export class PreviewAutomationNoAvailableHostError extends Schema.TaggedError<PreviewAutomationNoAvailableHostError>()(
  "PreviewAutomationNoAvailableHostError",
  {
    ...PreviewAutomationScopeErrorFields,
    clientId: Schema.optional(TrimmedNonEmptyString),
    connectionId: Schema.optional(PreviewAutomationConnectionId),
    requestId: Schema.optional(TrimmedNonEmptyString),
    tabId: Schema.optional(PreviewTabId).annotate({
      description: "Tab from preview_status. Omit to use the current tab.",
    }),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `No preview automation host is available for ${this.operation} in environment ${this.environmentId}. The server-owned browser may be starting or reconnecting. Retry preview_status, then call preview_open if no tab is available. If it remains unavailable, report the browser connection failure.`;
  }
}

export class PreviewAutomationBusyError extends Schema.TaggedError<PreviewAutomationBusyError>()(
  "PreviewAutomationBusyError",
  {
    ...PreviewAutomationScopeErrorFields,
    tabId: Schema.optional(PreviewTabId).annotate({
      description: "Tab from preview_status. Omit to use the current tab.",
    }),
    holderProviderSessionId: TrimmedNonEmptyString,
    holderThreadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    // Exclusivity is per tab, so name the tab and the holder: the caller's own
    // other tabs are unaffected and a competing session only blocks the step it
    // is mid-flight with.
    const holder = this.holderThreadId
      ? `thread ${this.holderThreadId}`
      : `provider session ${this.holderProviderSessionId}`;
    const target = this.tabId
      ? `Collaborative browser tab ${this.tabId}`
      : `The collaborative browser tab for environment ${this.environmentId}`;
    return `${target} is being driven by ${holder} right now; retry once that step finishes, or target another tab.`;
  }
}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedError<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} does not support ${this.operation}.`;
  }
}

export class PreviewAutomationTabNotFoundError extends Schema.TaggedError<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return this.tabId
      ? `Preview tab ${this.tabId} was not found for ${this.operation}. Omit tabId to use the current tab, or call preview_open.`
      : `No active preview tab was found for ${this.operation}. Call preview_open first.`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedError<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
    stages: Schema.optional(Schema.Array(Schema.Literals(["text", "accessibility", "screenshot"]))),
  },
) {
  override get message(): string {
    const summary = `Preview automation ${this.operation} timed out after ${this.timeoutMs}ms.`;
    return this.stages?.length ? `${summary} Waiting for: ${this.stages.join(", ")}.` : summary;
  }
}

export const PreviewAutomationControlReason = Schema.Literals([
  "agentMismatch",
  "humanControl",
  "tabRequired",
  "closed",
  "interrupted",
  "dialogPending",
  "tabLimit",
]);
export type PreviewAutomationControlReason = typeof PreviewAutomationControlReason.Type;

export class PreviewAutomationControlInterruptedError extends Schema.TaggedError<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    reason: Schema.optional(PreviewAutomationControlReason),
  },
) {
  override get message(): string {
    if (this.reason === "agentMismatch")
      return "This browser tab belongs to another agent session or a human. Open your own tab.";
    if (this.reason === "humanControl")
      return "A human controls this browser tab. Wait until they release control.";
    if (this.reason === "tabRequired")
      return "Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.";
    if (this.reason === "dialogPending")
      return "A browser dialog is pending. Read preview_status and resolve it with preview_dialog.";
    if (this.reason === "tabLimit")
      return "Too many server browser tabs are open. Close one with t3_preview_close, or reuse a tabId from preview_status tabs.";
    if (this.reason === "closed") return "This browser tab is closed. Call preview_open.";
    if (this.reason === "interrupted")
      return "Browser control changed. Take a fresh snapshot before trying again.";
    return `Preview automation ${this.operation} was interrupted on client ${this.clientId}.`;
  }
}

export class PreviewAutomationExecutionError extends Schema.TaggedError<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    reason: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === undefined
      ? `Preview automation ${this.operation} failed on client ${this.clientId}.`
      : `Preview automation ${this.operation} failed: ${this.reason}`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedError<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    matchCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2))),
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    staleRef: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    if (this.matchCount !== undefined) {
      return `Preview automation ${this.operation} matched ${this.matchCount} elements. Use a more specific selector from preview_snapshot.`;
    }
    if (this.staleRef)
      return "This element ref is stale. Navigation, dialogs, and new snapshots replace refs; take a fresh snapshot and use its refs.";
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} received an invalid ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} received an invalid selector. Use a valid, unique selector from preview_snapshot.`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedError<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind === "focused-element") {
      return `Preview automation ${this.operation} requires an editable focused element.`;
    }
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} requires an editable ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} requires an editable target.`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedError<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    maximumBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  },
) {
  override get message(): string {
    const summary =
      this.maximumBytes === undefined
        ? `Preview automation ${this.operation} produced a result that is too large.`
        : `Preview automation ${this.operation} produced a result larger than ${this.maximumBytes} bytes.`;
    return summary;
  }
}

export class PreviewAutomationClientDisconnectedError extends Schema.TaggedError<PreviewAutomationClientDisconnectedError>()(
  "PreviewAutomationClientDisconnectedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} disconnected during ${this.operation}.`;
  }
}

export class PreviewAutomationRequestQueueClosedError extends Schema.TaggedError<PreviewAutomationRequestQueueClosedError>()(
  "PreviewAutomationRequestQueueClosedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} stopped accepting ${this.operation} requests.`;
  }
}

export class PreviewAutomationRemoteUnavailableError extends Schema.TaggedError<PreviewAutomationRemoteUnavailableError>()(
  "PreviewAutomationRemoteUnavailableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} is unavailable on client ${this.clientId}.`;
  }
}

export class PreviewAutomationMalformedResponseError extends Schema.TaggedError<PreviewAutomationMalformedResponseError>()(
  "PreviewAutomationMalformedResponseError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} returned a malformed response for ${this.operation}.`;
  }
}

export class PreviewAutomationRecordingTransferError extends Schema.TaggedError<PreviewAutomationRecordingTransferError>()(
  "PreviewAutomationRecordingTransferError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Preview recording could not be saved to the agent environment.";
  }
}

export class PreviewAutomationRecordingDesktopUpdateRequiredError extends Schema.TaggedError<PreviewAutomationRecordingDesktopUpdateRequiredError>()(
  "PreviewAutomationRecordingDesktopUpdateRequiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Update the desktop app to transfer recordings. The recording remains on the desktop.";
  }
}

export class PreviewAutomationRecordingTooLargeError extends Schema.TaggedError<PreviewAutomationRecordingTooLargeError>()(
  "PreviewAutomationRecordingTooLargeError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The recording exceeds 50 MiB. Make a shorter recording.";
  }
}

export class PreviewAutomationRecordingDeadlineExpiredError extends Schema.TaggedError<PreviewAutomationRecordingDeadlineExpiredError>()(
  "PreviewAutomationRecordingDeadlineExpiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The recording transfer deadline expired.";
  }
}

export const PreviewAutomationFileActionReason = Schema.Literals([
  "no-file-chooser",
  "not-file-input",
  "single-file",
  "no-download",
  "download-failed",
  "download-too-large",
]);
export type PreviewAutomationFileActionReason = typeof PreviewAutomationFileActionReason.Type;

/** Agents read this message, so each reason names the next step. */
export class PreviewAutomationFileActionError extends Schema.TaggedError<PreviewAutomationFileActionError>()(
  "PreviewAutomationFileActionError",
  {
    threadId: ThreadId,
    reason: PreviewAutomationFileActionReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-file-chooser":
        return "No file picker is waiting in this tab. Pass the locator of the file input or of the control that opens the picker.";
      case "not-file-input":
        return "The target is not a file input, and clicking it did not open a file picker. Target the <input type=file>, its label, or the upload button from preview_snapshot.";
      case "single-file":
        return "This file picker accepts one file. Pass a single path.";
      case "no-download":
        return "No download from your actions arrived in this tab before the timeout. Trigger it with preview_click or preview_navigate, then call preview_download again.";
      case "download-failed":
        return "The browser cancelled or interrupted the download. Trigger it again.";
      case "download-too-large":
        return "The download is larger than the 50 MiB transfer limit, so it was discarded.";
    }
  }
}

export class PreviewAutomationFileUnreadableError extends Schema.TaggedError<PreviewAutomationFileUnreadableError>()(
  "PreviewAutomationFileUnreadableError",
  { path: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `${this.path} is not a readable file in this environment. Pass absolute paths to existing files.`;
  }
}

export class PreviewAutomationFileTooLargeError extends Schema.TaggedError<PreviewAutomationFileTooLargeError>()(
  "PreviewAutomationFileTooLargeError",
  { fileName: Schema.String, maximumBytes: Schema.Int },
) {
  override get message(): string {
    return `${this.fileName} is larger than the ${this.maximumBytes}-byte browser transfer limit.`;
  }
}

export class PreviewAutomationFileTransferError extends Schema.TaggedError<PreviewAutomationFileTransferError>()(
  "PreviewAutomationFileTransferError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The file could not be transferred between the browser and this agent's environment.";
  }
}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationFileActionError,
  PreviewAutomationFileUnreadableError,
  PreviewAutomationFileTooLargeError,
  PreviewAutomationFileTransferError,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationUnavailableError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationBusyError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationMalformedResponseError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;

export const PreviewUrlResolution = Schema.Struct({
  requestedUrl: Schema.String,
  resolvedUrl: Schema.String,
  resolutionKind: Schema.Literals(["direct", "direct-private-network"]),
  environmentId: EnvironmentId,
});
export type PreviewUrlResolution = typeof PreviewUrlResolution.Type;
