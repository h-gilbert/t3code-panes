function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function requestFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  const notification = recordOrNull(recordOrNull(response)?.notification);
  return recordOrNull(notification?.request);
}

/**
 * Candidate routing data for a tapped notification. Expo only exposes a remote iOS push's
 * custom keys as `content.data` when they are nested under `body`; self-hosted APNs pushes
 * put them at the top level, which Expo exposes as the push trigger's raw `payload`.
 */
function dataFromNotificationResponse(response: unknown): ReadonlyArray<Record<string, unknown>> {
  const request = requestFromNotificationResponse(response);
  const contentData = recordOrNull(recordOrNull(request?.content)?.data);
  const triggerPayload = recordOrNull(recordOrNull(request?.trigger)?.payload);
  return [contentData, triggerPayload].filter((data) => data !== null);
}

function identifierFromNotificationResponse(response: unknown): string | null {
  const identifier = requestFromNotificationResponse(response)?.identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

function deepLinkFromNotificationData(data: Record<string, unknown>): string | null {
  const deepLink = data.deepLink;
  if (typeof deepLink === "string") {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data.environmentId;
  const threadId = data.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string") {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  for (const data of dataFromNotificationResponse(response)) {
    const deepLink = deepLinkFromNotificationData(data);
    if (deepLink) {
      return deepLink;
    }
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(deepLink);
  }
}
