import type { ScopedThreadRef } from "@t3tools/contracts";
import { useProjects } from "../state/entities";

import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import {
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoLatestThreadAction,
} from "../hooks/showThreadUndoNotice";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { ThreadLinkPrompt } from "./promptLinks/ThreadLinkPrompt";
import { ChatRouteGlobalShortcuts } from "../routes/_chat";
import { Sheet, SheetPopup, SheetTitle } from "./ui/sheet";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  DEFAULT_WORKSPACE_KEY,
  selectProjectWorkspaceLayout,
  useWorkspacePaneStore,
  isWorkspacePath,
} from "../workspacePaneStore";
import { resolveRetainedWorkspaceKey } from "../workspaceRouteRetention";
import { ProjectPaneWorkspace } from "../routes/_chat.workspace";
import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../hooks/useSettings";
import { useCurrentThreadTarget } from "../hooks/useCurrentThreadTarget";
import { useDesktopFullscreen } from "../hooks/useDesktopFullscreen";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import { BackgroundThreadAnnouncer } from "./BackgroundThreadAnnouncer";
import LegacyThreadSidebar from "./LegacySidebar";
import { useThreadVisitedMigration } from "../hooks/useThreadVisitedMigration";
import ThreadSidebar from "./Sidebar";
import { SidebarBrandWidthProbe } from "./sidebar/SidebarChrome";
import { isAppModalPage, MainAppLocationTracker } from "./sidebar/mainAppLocation";
import type { SidebarRouteReveal } from "./sidebar/routeReveal";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl({ hidden }: { readonly hidden: boolean }) {
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile, mobileSheetMounted } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event, window.getSelection()) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B only to bold selected text;
        // the toggle stays available everywhere else.
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle") toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, toggleSidebar, usagePageOpen]);

  if (hidden) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              variant={isSidebarVisible && stageBackdropVariant ? "media-navigation" : "ghost"}
              className={cn(
                "pointer-events-auto",
                isSidebarVisible && stageBackdropVariant && "relative top-auto translate-y-0",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function routePanelsOpen(routeThreadRef: ScopedThreadRef | null) {
  if (!routeThreadRef) return { terminalOpen: false, previewOpen: false };
  return {
    terminalOpen: selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      routeThreadRef,
    ).terminalOpen,
    previewOpen:
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
      "preview",
  };
}

export function NavigationHistoryShortcuts() {
  const location = useLocation();
  const usagePageOpen = location.pathname === "/usage";
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const currentTarget = useCurrentThreadTarget();
  const routeThreadRef = currentTarget?.kind === "server" ? currentTarget.threadRef : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          ...routePanelsOpen(routeThreadRef),
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
          usagePageOpen,
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (command === "navigation.back" && isWorkspacePath(location.pathname)) {
        const workspace = location.search.workspace ?? DEFAULT_WORKSPACE_KEY;
        const store = useWorkspacePaneStore.getState();
        const layout = selectProjectWorkspaceLayout(store, workspace);
        if ((layout.backStacks?.[layout.focusedPaneIndex]?.length ?? 0) > 0) {
          store.goBack(workspace, layout.focusedPaneIndex);
          return;
        }
      }
      if (command === "navigation.back") window.history.back();
      else window.history.forward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef, usagePageOpen, location.pathname, location.search.workspace]);

  return null;
}

// Keep projects subscribed while the navigation overlay is closed.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

// Undoes the thread actions in the sidebar's notice. Settings and Usage own
// mod+z while open. Listens in the capture phase
// so mod+z reaches it before the composer's own undo handler consumes the key.
function ThreadUndoShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const currentTarget = useCurrentThreadTarget();
  const routeThreadRef = currentTarget?.kind === "server" ? currentTarget.threadRef : null;
  // A collapsed sidebar hides the notice, so text fields keep their own undo.
  const noticeVisible = useSidebarVisibility();
  // Outlives the effect: undoing an archive navigates, which re-runs it mid-hold.
  const heldUndoKey = useRef<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A held key undoes once. Cancel its repeats so they cannot fall through
      // to the editor's own undo, even after the last notice is gone.
      if (event.repeat) {
        if (event.code === heldUndoKey.current) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      // A modifier tapped mid-hold leaves the held key repeating.
      if (!MODIFIER_KEYS.has(event.key)) heldUndoKey.current = null;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          previewFocus: isPreviewFocused(),
          ...routePanelsOpen(routeThreadRef),
          editableFocus:
            isEditableFocused(event.target) && !(noticeVisible && threadUndoClaimsShortcut()),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "thread.undo") {
        if (!MODIFIER_KEYS.has(event.key)) releaseThreadUndoShortcut();
        return;
      }
      if (isCommandPaletteOpen() || isModelPickerOpen()) return;
      if (undoLatestThreadAction()) {
        heldUndoKey.current = event.code;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    // Pastes from a menu, dictation and drops edit text without a keypress.
    const onInput = () => releaseThreadUndoShortcut();

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("input", onInput, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("input", onInput, true);
    };
  }, [keybindings, noticeVisible, routeThreadRef]);

  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const location = useLocation();
  const pathname = location.pathname;
  const isOnWorkspace = isWorkspacePath(pathname);
  const [previousWorkspaceKey, setPreviousWorkspaceKey] = useState<string | null>(
    DEFAULT_WORKSPACE_KEY,
  );
  const search = location.search as Record<string, unknown>;
  const nextWorkspaceKey = resolveRetainedWorkspaceKey({
    pathname,
    workspaceSearch: search.workspace,
    previousWorkspaceKey,
  });
  if (nextWorkspaceKey !== previousWorkspaceKey) setPreviousWorkspaceKey(nextWorkspaceKey);
  const retainedWorkspaceKey = nextWorkspaceKey ?? DEFAULT_WORKSPACE_KEY;
  const threadTarget = useParams({ strict: false, select: resolveThreadRouteTarget });
  const isUtility =
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/usage" ||
    pathname === "/pull-requests";
  const closeUtility = () =>
    void navigate({ to: "/workspace", search: { workspace: retainedWorkspaceKey } });
  const [sidebarState, setSidebarState] = useState({ pathname, open: false });
  const sidebarOpen = sidebarState.pathname === pathname && sidebarState.open;
  const setSidebarOpen = (open: boolean) => setSidebarState({ pathname, open });
  const handledRouteRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (pathname !== "/" && !threadTarget) {
      handledRouteRef.current = null;
      return;
    }
    if (new URLSearchParams(location.searchStr).has("prompt")) return;
    const routeKey = `${location.state.__TSR_key}:${location.href}`;
    if (handledRouteRef.current === routeKey) return;
    handledRouteRef.current = routeKey;
    if (pathname === "/") {
      void navigate({
        to: "/workspace",
        search: { workspace: retainedWorkspaceKey },
        replace: true,
      });
      return;
    }
    if (!threadTarget) return;
    const store = useWorkspacePaneStore.getState();
    if (threadTarget.kind === "server")
      store.assignThread(retainedWorkspaceKey, threadTarget.threadRef);
    else store.assignDraft(retainedWorkspaceKey, threadTarget.draftId);
    void navigate({
      to: "/workspace",
      search: { ...location.search, workspace: retainedWorkspaceKey },
      replace: true,
    });
  }, [threadTarget, retainedWorkspaceKey, navigate, location, pathname]);
  const { isMacosDesktop, isWindowFullscreen } = useDesktopFullscreen();
  const [sidebarRouteReveal] = useState<SidebarRouteReveal>(() => ({
    observedKey: null,
    pendingKey: null,
  }));
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  useThreadVisitedMigration();
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const appModalOpen = isAppModalPage(pathname);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // A clamped drag may not change width, so viewport changes need a separate subscription.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  const sidebarMinimumWidth = resolveThreadSidebarMinimumWidth(brandWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth, sidebarMinimumWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...windowControlsInsetStyle,
  } as CSSProperties;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        style={sidebarProviderStyle}
      >
        <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
        <Sidebar
          overlay
          side="left"
          collapsible="offcanvas"
          data-app-sidebar=""
          role="navigation"
          aria-label="Threads"
          resizable={{
            maxWidth: sidebarMaximumWidth,
            minWidth: sidebarMinimumWidth,
            shouldAcceptWidth: ({ currentWidth, nextWidth }) =>
              nextWidth <= currentWidth ||
              viewportWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
            onResize: setSidebarWidth,
          }}
          // The narrow-window sidebar is a sheet, portaled outside the provider's styles.
          style={sidebarProviderStyle}
        >
          {legacySidebarEnabled ? (
            <LegacyThreadSidebar routeReveal={sidebarRouteReveal} />
          ) : (
            <ThreadSidebar routeReveal={sidebarRouteReveal} />
          )}
          <SidebarRail onDoubleClick={resetSidebarWidth} />
        </Sidebar>
        <div className="flex min-h-0 min-w-0 flex-1">
          <ProjectPaneWorkspace workspaceKey={retainedWorkspaceKey} active={!isUtility} />
        </div>
        {threadTarget?.kind === "server" ? (
          <ThreadLinkPrompt threadRef={threadTarget.threadRef} />
        ) : null}
        {appModalOpen ? children : null}
        {pathname === "/pull-requests" ? (
          <Sheet
            open
            onOpenChange={(open) => {
              if (!open) closeUtility();
            }}
          >
            <SheetPopup size="wide" side="right">
              <SheetTitle className="sr-only">Pull requests</SheetTitle>
              <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
            </SheetPopup>
          </Sheet>
        ) : null}
        {!isUtility && !threadTarget && !isOnWorkspace && pathname !== "/" ? children : null}
        <BackgroundThreadAnnouncer />
        <ProjectProjectionRetention />
        <SidebarControl
          hidden={
            sidebarOpen || isUtility || (isOnWorkspace && isMacosDesktop && isWindowFullscreen)
          }
        />
        {!isUtility ? <ChatRouteGlobalShortcuts /> : null}
        <NavigationHistoryShortcuts />
        {appModalOpen ? null : <ThreadUndoShortcut />}
        <MainAppLocationTracker />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
