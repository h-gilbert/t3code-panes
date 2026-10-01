import { EnvironmentId, ThreadId, type PreviewAutomationRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// One fake desktop process connecting the requesting window to the owner.
const desktop = vi.hoisted(() => {
  let listener:
    | ((relay: { relayId: string; environmentId: string; request: unknown }) => void)
    | null = null;
  const pending = new Map<string, (response: unknown) => void>();
  return {
    bridge: {
      onAutomationRelay: (next: typeof listener) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      respondToAutomationRelay: async (relayId: string, response: unknown) => {
        pending.get(relayId)?.(response);
      },
      relayAutomation: (input: { environmentId: string; request: unknown }) =>
        new Promise<unknown>((resolve) => {
          const relayId = `relay-${pending.size}`;
          pending.set(relayId, resolve);
          listener?.({ relayId, environmentId: input.environmentId, request: input.request });
        }),
    },
  };
});

vi.mock("./previewBridge", () => ({ previewBridge: desktop.bridge }));

import {
  listenForPreviewAutomationRelays,
  registerPreviewAutomationRelayHandler,
  relayPreviewAutomation,
} from "./previewAutomationRelay";
import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import { serializePreviewAutomationError } from "./previewAutomationRequestConsumer";

const environmentId = EnvironmentId.make("relay-environment");
const request: PreviewAutomationRequest = {
  requestId: "preview-1",
  threadId: ThreadId.make("relay-thread"),
  tabId: "tab_c",
  operation: "evaluate",
  input: { expression: "document.title" },
  timeoutMs: 15_000,
};
const context = {
  requestId: request.requestId,
  operation: request.operation,
  environmentId,
  threadId: request.threadId,
  tabId: null,
};

describe("preview automation relay", () => {
  it("answers with the owning window's result and its own errors", async () => {
    const stop = listenForPreviewAutomationRelays();
    const handle = vi.fn(async () => "Trade Me");
    const unregister = registerPreviewAutomationRelayHandler(environmentId, handle);

    await expect(
      relayPreviewAutomation({ runtimeTabId: "runtime-tab", environmentId, request }),
    ).resolves.toBe("Trade Me");
    expect(handle).toHaveBeenCalledWith(request);

    const ownerError = new PreviewAutomationTargetUnavailableError({
      ...context,
      tabId: "tab_c",
      bridgeAvailable: true,
    });
    handle.mockRejectedValueOnce(ownerError);
    const failure = await relayPreviewAutomation({
      runtimeTabId: "runtime-tab",
      environmentId,
      request,
    }).catch((error: unknown) => error);
    // The requesting window reports the owner's error unchanged.
    expect(serializePreviewAutomationError(failure, context)).toEqual(
      serializePreviewAutomationError(ownerError, { ...context, tabId: "tab_c" }),
    );

    unregister();
    stop();
  });
});
