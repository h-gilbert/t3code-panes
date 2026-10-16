import * as Schema from "effect/Schema";

import { PreviewAutomationEvaluateInput } from "./previewAutomation.ts";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The desktop app renders browser tabs for the server it launched, and the
 * server drives them with the same engine as its headless tabs. Messages
 * travel over bootstrap file descriptors for the local server, or an
 * authenticated RPC stream for an environment that selected this desktop.
 * Remote CDP endpoints are never exposed on the network.
 *
 * Each tab carries one CDP connection, multiplexed by `tabId`. CDP frames pass
 * through untouched; the desktop answers them with `CdpRelay`.
 */

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

/** Evaluation and autofill stay in the desktop; downloads cross in bounded chunks. */
export const DesktopBrowserPrivateOperation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("readDownload"),
    guid: TrimmedNonEmptyString,
    offset: Schema.Number,
  }),
  Schema.Struct({ operation: Schema.Literal("evaluate"), input: PreviewAutomationEvaluateInput }),
  Schema.Struct({
    operation: Schema.Literal("autofill"),
    input: Schema.Struct({
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
  /** One CDP message from the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

/** Server -> desktop. */
export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("operation"),
    ...TabKey,
    requestId: Schema.String,
    request: DesktopBrowserPrivateOperation,
  }),
  /** One CDP message for the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** The server stopped driving this tab, so the relay can drop its sessions. */
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  /** Where an agent action is about to land, so the desktop draws its cursor there. */
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
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
