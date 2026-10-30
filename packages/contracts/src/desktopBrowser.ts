import * as Schema from "effect/Schema";

import {
  PreviewAutomationEvaluateInput,
  PREVIEW_UPLOAD_CHUNK_BYTES,
  PREVIEW_UPLOAD_MAX_FILE_BYTES,
} from "./previewAutomation.ts";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// CDP stays behind the desktop’s bootstrap pipes or authenticated host stream; no public endpoint.

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

/** Evaluation and autofill stay in the desktop; files cross in bounded chunks. */
export const DesktopBrowserPrivateOperation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("stageUpload"),
    id: TrimmedNonEmptyString,
    sourcePath: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString,
    sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(PREVIEW_UPLOAD_MAX_FILE_BYTES),
    ),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.String.check(Schema.isMaxLength(Math.ceil(PREVIEW_UPLOAD_CHUNK_BYTES / 3) * 4)),
    done: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("discardUpload"), id: TrimmedNonEmptyString }),
  Schema.Struct({
    operation: Schema.Literal("readDownload"),
    guid: TrimmedNonEmptyString,
    offset: Schema.Number,
  }),
  Schema.Struct({ operation: Schema.Literal("evaluate"), input: PreviewAutomationEvaluateInput }),
  Schema.Struct({
    operation: Schema.Literal("autofill"),
    input: Schema.Struct({
      credential: Schema.optional(
        Schema.Struct({ origin: Schema.String, username: Schema.String, password: Schema.String }),
      ),
      environmentId: Schema.String,
      profile: Schema.NullOr(Schema.String),
      profileId: Schema.optional(Schema.String),
      username: Schema.optional(Schema.String),
    }),
  }),
]);
export type DesktopBrowserPrivateOperation = typeof DesktopBrowserPrivateOperation.Type;

/** Desktop -> server. */
export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("operationResult"),
    ...TabKey,
    requestId: Schema.String,
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.String),
  }),
  /** A desktop `<webview>` for this server tab is attached and can be driven. */
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("operation"),
    ...TabKey,
    requestId: Schema.String,
    request: DesktopBrowserPrivateOperation,
  }),
  /** One CDP message for the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Whether an agent turn runs on the thread, so the tabs it uses stay focused between steps. */
  Schema.Struct({
    type: Schema.Literal("turn"),
    threadId: TrimmedNonEmptyString,
    active: Schema.Boolean,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

/** One authenticated desktop connection can host this environment's browser tabs. */
export const DesktopBrowserHostConnectInput = Schema.Struct({
  hostEnvironmentId: TrimmedNonEmptyString,
});
export const DesktopBrowserHostStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("command"), commandId: Schema.String }),
]);
export type DesktopBrowserHostStreamEvent = typeof DesktopBrowserHostStreamEvent.Type;
export class DesktopBrowserHostError extends Schema.TaggedError<DesktopBrowserHostError>()(
  "DesktopBrowserHostError",
  { reason: Schema.Literals(["not-selected", "already-connected", "disconnected"]) },
) {
  override get message() {
    return `Desktop browser host is unavailable (${this.reason}).`;
  }
}
