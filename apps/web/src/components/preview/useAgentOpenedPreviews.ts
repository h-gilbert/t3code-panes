import { showDevicePreview } from "./showDevicePreview";
import { showBrowserInset } from "./showBrowserInset";
import type { DeviceServiceState, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerState,
} from "../../previewMiniPlayerStore";
import type { ThreadPreviewState } from "../../previewStateStore";

const selectAutoShowFloatingPreview = (settings: { browserAutoShowFloatingPreview: boolean }) =>
  settings.browserAutoShowFloatingPreview;

export function useAgentOpenedPreviews(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly deviceState: DeviceServiceState;
  readonly deviceStateLoaded: boolean;
  readonly previewState: ThreadPreviewState;
  readonly serverBrowserAvailable: boolean;
  readonly miniPlayerSource: PreviewMiniPlayerState["source"] | null;
}) {
  const {
    threadRef,
    deviceState,
    deviceStateLoaded,
    previewState,
    serverBrowserAvailable,
    miniPlayerSource,
  } = input;
  const autoShowFloatingPreview = useClientSettings(selectAutoShowFloatingPreview);
  // Baseline sessions to preserve dismissals on reload; missing device summaries must remain eligible to open
  // later.
  const previousDeviceSessions = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const threadKey = `${threadRef.environmentId}:${threadRef.threadId}`;
    const sessions = deviceState.sessions.filter(
      (session) => session.threadId === threadRef.threadId,
    );
    const key = (session: (typeof sessions)[number]) => `${session.hostId}:${session.deviceId}`;
    const deviceFor = (session: (typeof sessions)[number]) =>
      deviceState.devices.find(
        (entry) => entry.hostId === session.hostId && entry.id === session.deviceId,
      );
    const previous = previousDeviceSessions.current.get(threadKey);
    previousDeviceSessions.current.set(
      threadKey,
      new Map(
        sessions
          .filter((session) => deviceFor(session) !== undefined)
          .map((session) => [key(session), session.revealRequest?.id]),
      ),
    );
    if (!previous) return;
    for (const session of sessions) {
      const request = session.revealRequest;
      if (request ? previous.get(key(session)) === request.id : previous.has(key(session)))
        continue;
      const device = deviceFor(session);
      if (!device) continue;
      const target = {
        hostId: session.hostId,
        deviceId: session.deviceId,
        platform: device.platform,
        name: device.name,
      };
      const presentation = request?.presentation ?? "inset";
      showDevicePreview(threadRef, target, presentation);
    }
  }, [threadRef, deviceStateLoaded, deviceState.sessions, deviceState.devices]);
  // Baseline loaded tabs so reloads never reopen previews the user dismissed.
  const previousServerPreviewTabs = useRef(new Map<string, Map<string, string | undefined>>());
  useEffect(() => {
    if (!threadRef || !serverBrowserAvailable || !previewState.listLoaded) return;
    const threadKey = scopedThreadKey(threadRef);
    const serverSessions = Object.values(previewState.sessions).filter(
      (session) => session.runtime === "server",
    );
    const previous = previousServerPreviewTabs.current.get(threadKey);
    previousServerPreviewTabs.current.set(
      threadKey,
      new Map(serverSessions.map((session) => [session.tabId, session.revealRequest?.id])),
    );
    if (!previous) return;
    for (const session of serverSessions) {
      const requested = session.revealRequest;
      const fresh = requested
        ? previous.get(session.tabId) !== requested.id
        : !previous.has(session.tabId);
      if (!fresh || session.reveal !== true) continue;
      if (!autoShowFloatingPreview && requested?.force !== true) continue;
      showBrowserInset(threadRef, session.tabId);
    }
  }, [
    serverBrowserAvailable,
    previewState.listLoaded,
    previewState.sessions,
    threadRef,
    autoShowFloatingPreview,
  ]);
  useEffect(() => {
    if (!threadRef || !deviceStateLoaded) return;
    const source = miniPlayerSource;
    if (source?.kind !== "device") return;
    const sessionStillExists = deviceState.sessions.some(
      (session) =>
        session.threadId === threadRef.threadId &&
        session.hostId === source.hostId &&
        session.deviceId === source.deviceId,
    );
    if (!sessionStillExists) usePreviewMiniPlayerStore.getState().close(threadRef);
  }, [miniPlayerSource, threadRef, deviceState.sessions, deviceStateLoaded]);
}
