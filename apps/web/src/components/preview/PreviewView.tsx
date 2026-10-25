import { useStableCallback } from "../../hooks/useStableCallback";
import type { PreviewViewportSetting } from "@t3tools/contracts";
import { browserCredentialProfile } from "./browserCredentialProfile";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { previewStreamDownloadUrl } from "@t3tools/client-runtime/preview/server-browser-stream";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_BROWSER_PROFILE_ID,
  FILL_PREVIEW_VIEWPORT,
  type DesktopBrowserCredentialSummary,
  type PreviewAnnotationPayload,
  type ScopedThreadRef,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAdjustInput,
} from "@t3tools/contracts";
import {
  normalizePreviewUrl,
  resolveAddressBarInput,
  previewPdfAssetUrl,
  resolveSearchUrlTemplate,
} from "@t3tools/shared/preview";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  setTitleForThreadUrl,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import { capturePreviewAnnotationScreenshot } from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import { getClientSettings } from "~/hooks/useSettings";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useEnvironmentSupportsServerBrowser } from "~/state/entities";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { usePreviewStreamAccess } from "~/state/previewStream";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { closePreviewSession } from "./closePreviewSession";
import { openPreviewSession } from "./openPreviewSession";
import { showPreviewPopup } from "./showPreviewPopup";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu, type PreviewMoreMenuActions } from "./PreviewMoreMenu";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { BrowserDeviceToolbar } from "~/browser/BrowserDeviceToolbar";
import { BROWSER_DEVICE_TOOLBAR_HEIGHT } from "~/browser/browserViewportLayout";
import { useBrowserLayoutZoomFactor } from "~/browser/useBrowserLayoutZoomFactor";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { BrowserSettingsReadError } from "~/browser/openFileInPreview";
import { PreviewFileNotShown, PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { Badge } from "~/components/ui/badge";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { alternatePreviewRuntime, useRendersServerTabNatively } from "~/browser/previewRuntime";
import { ServerBrowserSurface, type ServerBrowserHandle } from "~/browser/ServerBrowserSurface";
import { cn } from "~/lib/utils";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  findActiveBrowserRecordingRuntimeTabId,
  isBrowserRecordingStartCancelledError,
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

function previewProfileName(
  profiles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  profileId: string,
): string {
  return profiles.find((profile) => profile.id === profileId)?.name ?? "Removed profile";
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

const browserCredentialOrigin = (url: string): string | null => {
  try {
    return new URL(url).origin.toLowerCase();
  } catch {
    return null;
  }
};
/** Resolves stream access only while a server tab shows a file it downloaded. */
function ServerTabFileNotShown(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly url: string;
  readonly download: { readonly id: string; readonly fileName: string };
}) {
  const access = usePreviewStreamAccess(props.threadRef.environmentId);
  return (
    <PreviewFileNotShown
      url={props.url}
      fileName={props.download.fileName}
      downloadUrl={
        access
          ? previewStreamDownloadUrl(
              { access, threadId: props.threadRef.threadId, tabId: props.tabId },
              props.download.id,
            )
          : null
      }
      onOpen={() => void localApi?.shell.openExternal(props.url).catch(() => undefined)}
    />
  );
}

export function PreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const canSendAnnotation =
    useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) &&
    Boolean(onSendAnnotation);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef<{ cancelled: boolean } | null>(null);
  const isMountedRef = useRef(true);
  const previewState = useThreadPreviewState(threadRef);
  const recentHistoryEntries = useThreadRecentHistory(
    threadRef,
    BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  );
  const miniPlayerTabId = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayerTabId(state.byThreadKey, threadRef),
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const environmentHostname = environmentHttpBaseUrl
    ? new URL(environmentHttpBaseUrl).hostname
    : null;
  const open = useAtomCommand(previewEnvironment.open);
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const environmentLabel = useEnvironment(threadRef.environmentId)?.label ?? "the environment";
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverBrowser = useEnvironmentSupportsServerBrowser(threadRef.environmentId);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");
  const adjust = useAtomCommand(previewEnvironment.adjust, "preview appearance or zoom");

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const recordingRuntimeTabId =
    tabId && runtimeTabId
      ? activeRecordingTabIds.has(runtimeTabId)
        ? runtimeTabId
        : findActiveBrowserRecordingRuntimeTabId(threadRef, tabId)
      : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const nativeServerTab = useRendersServerTabNatively(threadRef.environmentId, snapshot);
  const isServerTab = snapshot?.runtime === "server" && !nativeServerTab;
  const serverOwnsRendering = snapshot?.runtime === "server";
  const serverSurfaceRef = useRef<ServerBrowserHandle | null>(null);
  const [serverAspectRatioLocked, setServerAspectRatioLocked] = useState(false);
  const serverBodyRef = useRef<HTMLDivElement | null>(null);
  const [serverToolbarWidth, setServerToolbarWidth] = useState(0);
  const serverToolbarShown =
    snapshot?.runtime === "server" && (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT)._tag !== "fill";
  useEffect(() => {
    const element = serverBodyRef.current;
    if (!element || !serverToolbarShown) return;
    return observeResize(element, ([entry]) =>
      setServerToolbarWidth(Math.max(1, Math.round(entry?.contentRect.width ?? 0))),
    );
  }, [serverToolbarShown]);
  const [serverControlledTabId, setServerControlledTabId] = useState<string | null>(null);
  const serverInputDisabled = isServerTab && serverControlledTabId !== runtimeTabId;
  const [serverFrameTabId, setServerFrameTabId] = useState<string | null>(null);
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const layoutZoomFactor = useBrowserLayoutZoomFactor(desktopOverlay?.zoomFactor ?? 1);
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const serverStreamPending =
    isServerTab && !showEmptyState && !isUnreachable && serverFrameTabId !== runtimeTabId;
  const controller = desktopOverlay?.controller ?? "none";
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const browserDefaults = useBrowserDefaults();
  const [saveLoginOpen, setSaveLoginOpen] = useState(false);
  const [saveLoginUsername, setSaveLoginUsername] = useState("");
  const [saveLoginPassword, setSaveLoginPassword] = useState("");
  const [savedLogins, setSavedLogins] = useState<ReadonlyArray<DesktopBrowserCredentialSummary>>(
    [],
  );
  const { profile: loginProfile, profileId: loginProfileId } = browserCredentialProfile(snapshot);
  useEffect(() => {
    if (!saveLoginOpen || !previewBridge || !url) return;
    const origin = browserCredentialOrigin(url);
    if (!origin) return;
    let cancelled = false;
    void previewBridge.browserCredentials
      .list()
      .then((credentials) => {
        if (cancelled) return;
        setSavedLogins(
          credentials.filter(
            (credential) =>
              (credential.environmentId === threadRef.environmentId ||
                credential.environmentId === null) &&
              credential.origin === origin &&
              credential.profile === loginProfile &&
              credential.profileId === loginProfileId,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setSavedLogins([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loginProfile, loginProfileId, saveLoginOpen, threadRef.environmentId, url]);
  const handleFillLogin = useStableCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    void previewBridge.browserCredentials
      .autofill({
        tabId: runtimeTabId,
        environmentId: threadRef.environmentId,
        profile: loginProfile,
        ...(loginProfileId === undefined ? {} : { profileId: loginProfileId }),
      })
      .then((result) => {
        if (result.filled) return;
        toastManager.add({
          type: "info",
          title:
            result.reason === "no-credential"
              ? "No saved login for this site"
              : result.reason === "ambiguous-credential"
                ? "Several logins saved for this site"
                : result.reason === "no-fields"
                  ? "No login form on this page"
                  : "Saved logins are unavailable",
          description:
            result.reason === "no-credential"
              ? "Use “Save login for this site…” to add one."
              : result.reason === "ambiguous-credential"
                ? "Remove the ones you no longer use, or ask the agent to fill a specific username."
                : result.reason === "no-fields"
                  ? "Open the site's sign-in page first."
                  : "OS keychain encryption is not available on this machine.",
        });
      })
      .catch(() => {
        toastManager.add({ type: "error", title: "Unable to fill the login" });
      });
  });
  const handleSaveLogin = useStableCallback(() => {
    if (!previewBridge || !url) return;
    const username = saveLoginUsername.trim();
    if (username.length === 0 || saveLoginPassword.length === 0) return;
    void previewBridge.browserCredentials
      .save({
        environmentId: threadRef.environmentId,
        url,
        profile: loginProfile,
        ...(loginProfileId === undefined ? {} : { profileId: loginProfileId }),
        username,
        password: saveLoginPassword,
      })
      .then((saved) => {
        setSaveLoginUsername("");
        setSaveLoginPassword("");
        setSavedLogins((current) => [
          ...current.filter((credential) => credential.id !== saved.id),
          saved,
        ]);
        toastManager.add({
          type: "success",
          title: `Login saved for ${saved.origin}`,
          description: "Stored encrypted with the OS keychain. Agents can now autofill it here.",
        });
      })
      .catch(() => {
        toastManager.add({
          type: "error",
          title: "Unable to save the login",
          description: "OS keychain encryption may be unavailable on this machine.",
        });
      });
  });
  const handleDeleteSavedLogin = useStableCallback((id: string) => {
    if (!previewBridge) return;
    void previewBridge.browserCredentials
      .delete(id)
      .then(() => {
        setSavedLogins((current) => current.filter((credential) => credential.id !== id));
      })
      .catch(() => {
        toastManager.add({ type: "error", title: "Unable to remove the saved login" });
      });
  });
  // A tab created before profiles existed carries no profile of its own. It
  // runs in the built-in `default` partition — the scope the browser used
  // before profiles — not in whatever profile is configured as the default
  // now, so that is what its label names and its clear actions target.
  // Passing the snapshot's raw `undefined` through would reach the IPC layer
  // as "every profile".
  const activeProfileId = snapshot?.profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const activeProfileName = snapshot?.browserScope
    ? (loginProfile ?? "Temporary session")
    : previewProfileName(browserDefaults.profiles, activeProfileId);
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );

  const navUrl = navStatus._tag === "Success" ? navStatus.url : null;
  const navTitle = navStatus._tag === "Success" ? navStatus.title : null;
  const latestHistoryUrl = recentHistoryEntries[0]?.url;
  const { environmentId: threadEnvironmentId, threadId } = threadRef;
  useEffect(() => {
    if (!navUrl || !navTitle || !latestHistoryUrl) return;
    setTitleForThreadUrl(
      scopeThreadRef(threadEnvironmentId, threadId),
      navUrl,
      navTitle,
      environmentHostname,
    );
  }, [environmentHostname, latestHistoryUrl, navTitle, navUrl, threadEnvironmentId, threadId]);

  const navigateToResolvedUrl = async (resolvedUrl: string) => {
    if (isServerTab && serverSurfaceRef.current) {
      if (serverInputDisabled) return false;
      serverSurfaceRef.current.navigate(resolvedUrl);
      rememberPreviewUrl(threadRef, resolvedUrl);
      return true;
    }
    if (runtimeTabId && previewBridge) {
      await previewBridge.navigate(runtimeTabId, resolvedUrl);
      rememberPreviewUrl(threadRef, resolvedUrl);
      return true;
    }
    const result = await openPreviewSession({ openPreview: open, threadRef, url: resolvedUrl });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      if (error instanceof BrowserSettingsReadError) {
        toastManager.add({
          type: "error",
          title: "Unable to open browser",
          description: error.message,
        });
      }
    }
    return result._tag === "Success";
  };

  const handleSubmitUrl = async (next: string) => {
    try {
      const resolved = resolveAddressBarInput(next, resolveSearchUrlTemplate(getClientSettings()));
      if (await navigateToResolvedUrl(resolved)) {
        recordVisitForThread(threadRef, resolved);
      }
    } catch {}
  };

  const handleOpenServerUrl = async (next: string) => {
    try {
      const resolved =
        isServerTab || !previewBridge
          ? normalizePreviewUrl(next)
          : resolveDiscoveredServerUrl(threadRef.environmentId, next);
      if (await navigateToResolvedUrl(resolved)) {
        recordVisitForThread(threadRef, next);
      }
    } catch {}
  };

  const handleRefresh = () => {
    if (isServerTab) serverSurfaceRef.current?.reload();
    else if (previewBridge && runtimeTabId) void previewBridge.refresh(runtimeTabId);
  };

  const adjustServerTab = async (change: Omit<PreviewAdjustInput, "threadId" | "tabId">) => {
    if (!tabId) return;
    const result = await adjust({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId, ...change },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to change the browser tab",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    updatePreviewServerSnapshot(threadRef, result.value);
  };

  const serverZoomFactor = snapshot?.zoomFactor ?? DEFAULT_PREVIEW_ZOOM_FACTOR;
  const stepServerZoom = (direction: -1 | 0 | 1) => {
    const index = PREVIEW_ZOOM_LEVELS.indexOf(serverZoomFactor);
    const next =
      direction === 0
        ? DEFAULT_PREVIEW_ZOOM_FACTOR
        : PREVIEW_ZOOM_LEVELS[
            Math.min(
              Math.max((index < 0 ? 7 : index) + direction, 0),
              PREVIEW_ZOOM_LEVELS.length - 1,
            )
          ]!;
    if (next !== serverZoomFactor) void adjustServerTab({ zoomFactor: next });
  };

  const handleZoomIn = () => {
    if (serverOwnsRendering) stepServerZoom(1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomIn(runtimeTabId);
  };

  const handleZoomOut = () => {
    if (serverOwnsRendering) stepServerZoom(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.zoomOut(runtimeTabId);
  };

  const handleResetZoom = () => {
    if (serverOwnsRendering) stepServerZoom(0);
    else if (previewBridge && runtimeTabId) void previewBridge.resetZoom(runtimeTabId);
  };

  const handleViewportChange = async (nextViewport: PreviewViewportSetting) => {
    if (!tabId) return;
    const result = await resize({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        tabId,
        viewport: nextViewport,
      },
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to resize browser viewport",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      throw error;
    }
    updatePreviewServerSnapshot(threadRef, result.value);
  };

  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId) return;
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }

    void commitBrowserViewportChange(
      runtimeTabId,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect,
        zoomFactor: isServerTab ? serverZoomFactor : layoutZoomFactor,
      }),
    ).catch(() => undefined);
  };

  const onViewportChange = useEffectEvent(handleViewportChange);
  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, (nextViewport) =>
      onViewportChange(nextViewport),
    );
  }, [runtimeTabId]);

  const handleBack = () => {
    if (isServerTab) serverSurfaceRef.current?.history(-1);
    else if (previewBridge && runtimeTabId) void previewBridge.goBack(runtimeTabId);
  };

  const handleForward = () => {
    if (isServerTab) serverSurfaceRef.current?.history(1);
    else if (previewBridge && runtimeTabId) void previewBridge.goForward(runtimeTabId);
  };

  const handleOpenInBrowser = () => {
    if (!localApi || !url) return;
    void localApi.shell.openExternal(url).catch(() => undefined);
  };

  const moveTarget = alternatePreviewRuntime(
    threadRef.environmentId,
    primaryEnvironmentId,
    serverBrowser,
    snapshot,
  );
  const moveLabel =
    moveTarget === "server" ? `Open in ${environmentLabel}'s browser` : "Open on this computer";
  const handleMoveTab = async () => {
    if (!moveTarget || !tabId || !snapshot) return;
    const result = await openPreviewSession({
      openPreview: open,
      threadRef,
      ...(url
        ? {
            url:
              moveTarget === "desktop"
                ? resolveDiscoveredServerUrl(threadRef.environmentId, url)
                : url,
          }
        : {}),
      viewport,
      ...(snapshot.profileId === undefined ? {} : { profileId: snapshot.profileId }),
      runtime: moveTarget,
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to move the browser tab",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
    await closePreviewSession({ closePreview, snapshot, tabId, threadRef });
  };

  const handlePictureInPicture = () => {
    if (!tabId) return;
    if (miniPlayerTabId === tabId) {
      usePreviewMiniPlayerStore.getState().close(threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().open(threadRef, browserMiniPlayerSource(tabId));
    useRightPanelStore.getState().close(threadRef);
  };

  const desktopCall = (op: ((tabId: string) => Promise<void>) | undefined) => () => {
    if (op && runtimeTabId) void op(runtimeTabId).catch(() => undefined);
  };
  const moreMenuActions: PreviewMoreMenuActions | null = serverOwnsRendering
    ? {
        hardReload: () => void adjustServerTab({ hardReload: true }),
        setColorScheme: (colorScheme) => void adjustServerTab({ colorScheme }),
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        resetZoom: handleResetZoom,
        clearCookies: () => void adjustServerTab({ clear: "cookies" }),
        clearCache: () => void adjustServerTab({ clear: "cache" }),
        ...(nativeServerTab && previewBridge
          ? {
              openDevTools: desktopCall(previewBridge.openDevTools),
              toggleNativePictureInPicture: () => handleNativePictureInPicture(),
            }
          : {}),
      }
    : previewBridge
      ? {
          hardReload: desktopCall(previewBridge.hardReload),
          setColorScheme: (colorScheme) => {
            if (runtimeTabId)
              void previewBridge?.setColorScheme(runtimeTabId, colorScheme).catch(() => undefined);
          },
          zoomIn: handleZoomIn,
          zoomOut: handleZoomOut,
          resetZoom: handleResetZoom,
          clearCookies: () =>
            void previewBridge
              ?.clearCookies(
                threadRef.environmentId,
                activeProfileId,
                ...(snapshot?.browserScope ? [snapshot.browserScope] : []),
              )
              .catch(() => undefined),
          clearCache: () =>
            void previewBridge
              ?.clearCache(
                threadRef.environmentId,
                activeProfileId,
                ...(snapshot?.browserScope ? [snapshot.browserScope] : []),
              )
              .catch(() => undefined),
          openDevTools: desktopCall(previewBridge.openDevTools),
          toggleNativePictureInPicture: () => handleNativePictureInPicture(),
        }
      : null;

  const handleNativePictureInPicture = () => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  };

  const handleCapture = (record: boolean) => {
    if (!previewBridge || !runtimeTabId || !tabId) return;
    const bridge = previewBridge;
    if (recordingRuntimeTabId) {
      void stopBrowserRecording(recordingRuntimeTabId).then(
        (artifact) => {
          if (!artifact) return;
          let pathCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const copyPath = () => {
            if (!navigator.clipboard?.writeText) {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "error",
                  title: "Unable to copy recording path",
                  description: "Clipboard API unavailable.",
                  actionProps: revealAction,
                }),
              );
              return;
            }

            void navigator.clipboard.writeText(artifact.path).then(
              () => {
                pathCopied = true;
                updateRecordingToast();
                window.setTimeout(() => {
                  pathCopied = false;
                  updateRecordingToast();
                }, 2_000);
              },
              (error) => {
                toastManager.update(
                  toastId,
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to copy recording path",
                    description: error instanceof Error ? error.message : "An error occurred.",
                    actionProps: revealAction,
                  }),
                );
              },
            );
          };

          const revealAction = {
            children: revealInFileExplorerLabel(navigator.platform),
            onClick: () => void bridge.revealArtifact(artifact.path),
          };
          const updateRecordingToast = () => {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: pathCopied ? "Copied!" : "Copy path",
                    disabled: pathCopied,
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          };

          toastId = toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Recording saved",
              actionProps: revealAction,
              data: {
                secondaryActionProps: {
                  children: "Copy path",
                  onClick: copyPath,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to stop recording",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
      return;
    }
    if (record) {
      void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
        const description = error instanceof Error ? error.message : "An error occurred.";
        if (isBrowserRecordingStartCancelledError(error)) return;
        toastManager.add({
          type: "error",
          title: "Unable to start recording",
          description,
        });
      });
      return;
    }
    void bridge.captureScreenshot(runtimeTabId).then(
      (artifact) => {
        const revealAction = {
          children: revealInFileExplorerLabel(navigator.platform),
          onClick: () => void bridge.revealArtifact(artifact.path),
        };
        let pathCopied = false;
        let imageCopied = false;
        let toastId: ReturnType<typeof toastManager.add>;

        const updateScreenshotToast = (
          type: "success" | "error" = "success",
          title = "Screenshot saved",
          description?: string,
        ) => {
          toastManager.update(
            toastId,
            stackedThreadToast({
              type,
              title,
              description,
              actionProps: {
                children: imageCopied ? "Copied!" : "Copy image",
                disabled: imageCopied,
                onClick: copyImage,
              },
              data: {
                additionalActions: [
                  {
                    id: "copy-path",
                    props: {
                      children: pathCopied ? "Copied!" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                  },
                ],
                secondaryActionProps: {
                  ...revealAction,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        };

        const copyPath = () => {
          if (!navigator.clipboard?.writeText) {
            updateScreenshotToast(
              "error",
              "Unable to copy screenshot path",
              "Clipboard API unavailable.",
            );
            return;
          }

          void navigator.clipboard.writeText(artifact.path).then(
            () => {
              pathCopied = true;
              updateScreenshotToast();
              window.setTimeout(() => {
                pathCopied = false;
                updateScreenshotToast();
              }, 2_000);
            },
            (error) => {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot path",
                error instanceof Error ? error.message : "An error occurred.",
              );
            },
          );
        };

        const copyImage = () => {
          void bridge.copyArtifactToClipboard(artifact.path).then(
            () => {
              imageCopied = true;
              updateScreenshotToast();
              window.setTimeout(() => {
                imageCopied = false;
                updateScreenshotToast();
              }, 2_000);
            },
            (error) => {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot",
                error instanceof Error ? error.message : "An error occurred.",
              );
            },
          );
        };

        toastId = toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Screenshot saved",
            actionProps: {
              children: "Copy image",
              onClick: copyImage,
            },
            data: {
              additionalActions: [
                {
                  id: "copy-path",
                  props: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                },
              ],
              secondaryActionProps: {
                ...revealAction,
              },
              secondaryActionVariant: "outline",
            },
          }),
        );
      },
      (error) => {
        toastManager.add({
          type: "error",
          title: "Unable to capture screenshot",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      },
    );
  };

  const handlePickElement = () => {
    if (!previewBridge || !runtimeTabId) return;
    if (pickActiveRef.current) {
      pickActiveRef.current.cancelled = true;
      void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      return;
    }
    // Capture app focus before main moves it into guest webContents.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const pickRequest = { cancelled: false };
    let submitted = false;
    pickActiveRef.current = pickRequest;
    setPickActive(true);
    const finishPick = () => {
      const isCurrentPick = pickActiveRef.current === pickRequest;
      if (isCurrentPick) {
        pickActiveRef.current = null;
        if (isMountedRef.current) setPickActive(false);
      }
      if (
        (isCurrentPick || submitted) &&
        previouslyFocused &&
        previouslyFocused.isConnected &&
        typeof previouslyFocused.focus === "function"
      ) {
        try {
          previouslyFocused.focus({ preventScroll: true });
        } catch {}
      }
    };
    const bridge = previewBridge;
    void settlePromise(async () => {
      await bridge.setAnnotationSendEnabled?.(
        runtimeTabId,
        Boolean(onSendAnnotation) &&
          readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
      );
      if (pickRequest.cancelled) return;
      const result = await bridge.pickElement(runtimeTabId);
      if (!result || pickRequest.cancelled) return;
      // The accepted pick must survive further clicks, tab changes, and unmount; stop cancellation here.
      if (pickActiveRef.current === pickRequest) {
        pickActiveRef.current = null;
        if (isMountedRef.current) setPickActive(false);
        submitted = true;
      }
      const { annotation: picked, submission, screenshotFailed = false } = result;
      // Send annotations even if the optional crop fails or stalls; drop failed screenshots so prompts cannot
      // claim an attachment.
      const capture = capturePreviewAnnotationScreenshot(picked);
      const cropDropped = screenshotFailed || capture.status === "failed";
      const annotation = capture.status === "failed" ? { ...picked, screenshot: null } : picked;
      addPreviewAnnotation(threadRef, annotation);
      if (cropDropped) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not capture the picked element",
            description: "The annotation was kept without the screenshot.",
          }),
        );
      }
      const screenshotFile = capture.status === "captured" ? capture.file : null;
      const image =
        screenshotFile && annotation.screenshot
          ? ({
              type: "image",
              id: annotation.id,
              name: screenshotFile.name,
              mimeType: screenshotFile.type,
              sizeBytes: screenshotFile.size,
              previewUrl: annotation.screenshot.dataUrl,
              file: screenshotFile,
            } satisfies ComposerImageAttachment)
          : null;
      if (image) {
        addImage(threadRef, image);
      }
      if (
        submission === "send" &&
        readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        onSendAnnotation?.(annotation, image);
      }
    }).then(finishPick);
  };

  useEffect(() => {
    if (!pickActive || !previewBridge || !runtimeTabId) return;
    void previewBridge
      .setAnnotationSendEnabled?.(runtimeTabId, canSendAnnotation)
      .catch(() => undefined);
  }, [canSendAnnotation, pickActive, runtimeTabId]);

  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current.cancelled = true;
      pickActiveRef.current = null;
      if (previewBridge && runtimeTabId) {
        void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [runtimeTabId]);

  // Subscribe only while visible; ChatView always owns URL-aware toggle-panel handling.
  const onPreviewAction = useEffectEvent(
    (action: Parameters<Parameters<typeof subscribePreviewAction>[0]>[0]) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => (value ?? 0) + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    },
  );
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => onPreviewAction(action));
  }, [visible]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        loading={loading || serverStreamPending}
        canGoBack={canGoBack && !serverInputDisabled}
        canGoForward={canGoForward && !serverInputDisabled}
        refreshDisabled={refreshDisabled || serverInputDisabled}
        inputDisabled={serverInputDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        onCapture={previewBridge && tabId && !isServerTab ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={recordingRuntimeTabId !== null}
        onPictureInPicture={
          tabId && (isServerTab || previewBridge) ? handlePictureInPicture : undefined
        }
        pictureInPicture={miniPlayerTabId === tabId}
        pictureInPictureDisabled={
          isUnreachable || (!isServerTab && !desktopOverlay?.hasWebContents)
        }
        onPickElement={previewBridge && tabId && !isServerTab ? handlePickElement : undefined}
        pickActive={pickActive}
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load. Pick is unavailable until the page renders" : undefined
        }
        leadingActions={
          activeProfileId !== browserDefaults.profileId ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" className="max-w-28 shrink-0" />}>
                <span className="truncate">{activeProfileName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">{activeProfileName}</TooltipPopup>
            </Tooltip>
          ) : null
        }
        trailingActions={
          moreMenuActions ? (
            <PreviewMoreMenu
              enabled={
                runtimeTabId !== null &&
                (serverOwnsRendering || (desktopOverlay?.hasWebContents ?? false))
              }
              actions={moreMenuActions}
              {...(moveTarget
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
              profileName={activeProfileName}
              zoomFactor={
                serverOwnsRendering ? serverZoomFactor : (desktopOverlay?.zoomFactor ?? 1)
              }
              colorScheme={
                serverOwnsRendering
                  ? (snapshot?.colorScheme ?? "system")
                  : (desktopOverlay?.colorScheme ?? "system")
              }
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
              nativePictureInPicture={desktopOverlay?.pictureInPicture ?? false}
              onFillLogin={handleFillLogin}
              onSaveLogin={url ? () => setSaveLoginOpen(true) : undefined}
            />
          ) : null
        }
      />

      <div ref={serverBodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && isServerTab ? (
          <>
            {viewport._tag !== "fill" && !showEmptyState && !isUnreachable ? (
              <div className="absolute inset-x-0 top-0 z-10">
                <BrowserDeviceToolbar
                  setting={viewport}
                  width={serverToolbarWidth}
                  aspectRatio={serverAspectRatioLocked ? viewport.width / viewport.height : null}
                  onAspectRatioChange={(ratio) => setServerAspectRatioLocked(ratio !== null)}
                  onChange={(setting) => commitBrowserViewportChange(runtimeTabId, setting)}
                />
              </div>
            ) : null}
            <div
              className="absolute inset-x-0 bottom-0"
              style={{ top: viewport._tag !== "fill" ? BROWSER_DEVICE_TOOLBAR_HEIGHT : 0 }}
            >
              <ServerBrowserSurface
                key={runtimeTabId}
                ref={serverSurfaceRef}
                environmentId={threadRef.environmentId}
                threadId={threadRef.threadId}
                tabId={snapshot.tabId}
                pdfUrl={
                  navStatus._tag === "Success"
                    ? previewPdfAssetUrl(url, environmentHttpBaseUrl)
                    : null
                }
                visible={visible}
                onFirstFrame={() => setServerFrameTabId(runtimeTabId)}
                onControl={(control) =>
                  setServerControlledTabId(control?.controller === "you" ? runtimeTabId : null)
                }
                onPopup={(popupTabId) => showPreviewPopup(threadRef, popupTabId, "panel")}
                // Stays connected under the empty state so a URL picked there reaches the page.
                className={cn(
                  "absolute inset-0 h-full w-full",
                  (showEmptyState || isUnreachable) && "invisible",
                )}
              />
            </div>
          </>
        ) : runtimeTabId && snapshot && !showEmptyState ? (
          previewBridge ? (
            <BrowserSurfaceSlot
              key={runtimeTabId}
              tabId={runtimeTabId}
              visible={visible && !isUnreachable}
              className="absolute inset-0 h-full w-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">
                This tab is open in the T3 Code desktop app.
              </p>
            </div>
          )
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentHistoryEntries}
            onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {desktopOverlay?.hostedElsewhere && !showEmptyState && !isUnreachable ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-muted text-xs text-muted-foreground">
            Showing in another window…
          </div>
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {runtimeTabId &&
        desktopOverlay &&
        !showEmptyState &&
        !isUnreachable &&
        !activeRecordingTabIds.has(runtimeTabId) ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={layoutZoomFactor}
            controller={controller}
          />
        ) : null}
        {navStatus._tag === "LoadFailed" && navStatus.download ? (
          <div className="absolute inset-0 z-10 bg-background">
            <ServerTabFileNotShown
              threadRef={threadRef}
              tabId={snapshot?.tabId ?? ""}
              url={navStatus.url}
              download={navStatus.download}
            />
          </div>
        ) : navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
              {...(moveTarget === "server"
                ? { move: { label: moveLabel, onMove: () => void handleMoveTab() } }
                : {})}
            />
          </div>
        ) : null}
      </div>

      <Dialog
        open={saveLoginOpen}
        onOpenChange={(open) => {
          setSaveLoginOpen(open);
          if (!open) setSavedLogins([]);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save login for this site</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              handleSaveLogin();
            }}
          >
            <p className="text-xs text-muted-foreground">
              Stored encrypted with the OS keychain and bound to this site
              {loginProfile ? ` in the “${loginProfile}” profile` : ""}. Agents can autofill it here
              without seeing the password.
            </p>
            {savedLogins.length > 0 ? (
              <div className="flex flex-col gap-1.5 rounded-md border p-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  Saved for this environment
                </p>
                {savedLogins.map((credential) => (
                  <div
                    key={credential.id}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-sm px-1 py-0.5"
                  >
                    <span className="truncate text-sm">{credential.username}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      type="button"
                      aria-label={`Remove saved login for ${credential.username}`}
                      onClick={() => handleDeleteSavedLogin(credential.id)}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-save-login-username">Username or email</Label>
              <Input
                id="preview-save-login-username"
                autoComplete="off"
                value={saveLoginUsername}
                onChange={(event) => setSaveLoginUsername(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-save-login-password">Password</Label>
              <Input
                id="preview-save-login-password"
                type="password"
                autoComplete="off"
                value={saveLoginPassword}
                onChange={(event) => setSaveLoginPassword(event.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
              <Button
                type="submit"
                disabled={saveLoginUsername.trim().length === 0 || saveLoginPassword.length === 0}
              >
                Save login
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
