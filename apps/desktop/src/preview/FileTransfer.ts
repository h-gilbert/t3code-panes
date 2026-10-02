/**
 * File pickers and downloads in the collaborative browser.
 *
 * A tab is agent-driven from the start of an agent action until the next human
 * input in it. File pickers and downloads it starts in that window belong to
 * the agent: pickers wait for `preview_upload` and downloads wait for
 * `preview_download`, so neither shows a native dialog over the user's work.
 * Everything a human starts keeps the normal Open and Save dialogs.
 */
import type { PreviewAutomationFileActionReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const AGENT_DOWNLOAD_RETENTION = 20;

/** The control epoch an agent action ran at still matches: no human input since. */
export const isAgentDrivenTab = (
  agentEpoch: number | undefined,
  controlEpoch: number | undefined,
): boolean => agentEpoch !== undefined && agentEpoch === (controlEpoch ?? 0);

/** One directory segment per tab, so closing the tab can remove its files. */
export const tabTransferSegment = (tabId: string): string =>
  tabId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "tab";

/**
 * Open-dialog options for a picker a human opened in an agent-driven tab.
 * Interception has already swallowed Chromium's own dialog, so this stands in
 * for it. Extension filters are kept; MIME patterns such as image/* are not
 * expressible as macOS filters and fall back to any file.
 */
export const fileChooserDialogOptions = (input: {
  readonly multiple: boolean;
  readonly accept: string;
  readonly directory: boolean;
}): Electron.OpenDialogOptions => {
  const accepted = input.accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  const extensions =
    accepted.length > 0 && accepted.every((token) => /^\.[a-z0-9]+$/.test(token))
      ? accepted.map((token) => token.slice(1))
      : null;
  return {
    properties: [
      input.directory ? "openDirectory" : "openFile",
      ...(input.multiple ? (["multiSelections"] as const) : []),
    ],
    ...(extensions ? { filters: [{ name: "Accepted files", extensions }] } : {}),
  };
};

export interface PendingFileChooser {
  readonly backendNodeId: number;
  readonly multiple: boolean;
}

export interface AgentDownload {
  readonly id: string;
  readonly url: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly path: string;
  readonly totalBytes: number;
  readonly state: "progressing" | "completed" | "cancelled" | "interrupted";
}

/** Agents read the reason through the web host, which parses it from this message. */
export class PreviewFileTransferError extends Schema.TaggedError<PreviewFileTransferError>()(
  "PreviewFileTransferError",
  {
    tabId: Schema.String,
    reason: Schema.Literals([
      "no-file-chooser",
      "not-file-input",
      "single-file",
      "no-download",
      "download-failed",
      "download-too-large",
    ]),
  },
) {
  override get message(): string {
    return `Preview file transfer [${this.reason satisfies PreviewAutomationFileActionReason}] failed in tab ${this.tabId}`;
  }
}
