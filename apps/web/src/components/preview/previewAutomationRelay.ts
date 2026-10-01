import type {
  EnvironmentId,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
} from "@t3tools/contracts";

import { RelayedPreviewAutomationError } from "./previewAutomationErrors";
import { serializePreviewAutomationError } from "./previewAutomationRequestConsumer";
import { previewBridge } from "./previewBridge";

/**
 * Each app window hosts its own preview tabs, but the server routes an agent's
 * requests to one window. A request for a tab another window owns is relayed
 * there through the desktop process and answered by that window's host.
 */
type RelayResponse =
  | { readonly ok: true; readonly result?: unknown }
  | { readonly ok: false; readonly error: NonNullable<PreviewAutomationResponse["error"]> };

type RelayHandler = (request: PreviewAutomationRequest) => Promise<unknown>;

const handlers = new Map<string, RelayHandler>();

/** Lets the owning window answer relayed requests for one environment. */
export function registerPreviewAutomationRelayHandler(
  environmentId: EnvironmentId,
  handle: RelayHandler,
): () => void {
  handlers.set(environmentId, handle);
  return () => {
    if (handlers.get(environmentId) === handle) handlers.delete(environmentId);
  };
}

export function listenForPreviewAutomationRelays(): () => void {
  const bridge = previewBridge;
  if (!bridge) return () => undefined;
  return bridge.onAutomationRelay(({ relayId, environmentId, request }) => {
    const relayed = request as PreviewAutomationRequest;
    const handle = handlers.get(environmentId);
    const run = handle
      ? handle(relayed)
      : Promise.reject(new Error("The window that owns this tab is not connected to its server."));
    void run
      .then(
        (result): RelayResponse => ({ ok: true, ...(result === undefined ? {} : { result }) }),
        (error): RelayResponse => ({
          ok: false,
          error: serializePreviewAutomationError(error, {
            requestId: relayed.requestId,
            operation: relayed.operation,
            environmentId: environmentId as EnvironmentId,
            threadId: relayed.threadId,
            tabId: relayed.tabId ?? null,
          }),
        }),
      )
      .then((response) => bridge.respondToAutomationRelay(relayId, response))
      .catch(() => {
        // The requesting window times out on its own.
      });
  });
}

export async function relayPreviewAutomation(input: {
  readonly runtimeTabId: string;
  readonly environmentId: EnvironmentId;
  readonly request: PreviewAutomationRequest;
}): Promise<unknown> {
  const bridge = previewBridge;
  if (!bridge) throw new Error("The desktop bridge is unavailable.");
  const response = (await bridge.relayAutomation({
    tabId: input.runtimeTabId,
    environmentId: input.environmentId,
    timeoutMs: input.request.timeoutMs,
    request: input.request,
  })) as RelayResponse;
  if (response.ok) return response.result;
  throw new RelayedPreviewAutomationError(response.error);
}
