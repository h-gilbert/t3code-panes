"use client";

import { FILL_PREVIEW_VIEWPORT, type ScopedThreadRef } from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS, resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import {
  Maximize2Icon,
  Minimize2Icon,
  MonitorSmartphoneIcon,
  PanelRightIcon,
  PictureInPicture2,
  SmartphoneIcon,
  XIcon,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { commitBrowserViewportChange } from "~/browser/browserViewportActions";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadPreviewState } from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { closePreviewSession } from "./closePreviewSession";
import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
} from "./previewMiniPlayerLayout";

interface DragState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly playerX: number;
  readonly playerY: number;
}

interface ResizeState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly playerX: number;
  readonly playerY: number;
  readonly width: number;
  readonly height: number;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly bottomInset: number;
}

export function ThreadPreviewMiniPlayer({ threadRef, tabId, bottomInset }: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [defaultLayoutVersion, setDefaultLayoutVersion] = useState("");
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const browserDefaults = useBrowserDefaults();
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const mobileViewport =
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some(
      (preset) => preset.id === viewport.presetId && preset.category === "Phone",
    );
  const position = miniPlayer?.tabId === tabId ? miniPlayer.position : null;
  const size =
    miniPlayer?.tabId === tabId && miniPlayer.size
      ? miniPlayer.size
      : PREVIEW_MINI_PLAYER_DEFAULT_SIZE;
  const maximized = miniPlayer?.tabId === tabId && miniPlayer.maximized;
  const closePreview = useAtomCommand(previewEnvironment.close, {
    reportFailure: false,
  });
  const closeBrowser = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    void closePreviewSession({
      closePreview,
      snapshot,
      tabId,
      threadRef,
    }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Unable to close the browser",
          description: "The preview session could not be closed. It may already be gone.",
        });
      }
    });
  };

  const toggleMaximized = () => {
    usePreviewMiniPlayerStore.getState().setMaximized(threadRef, tabId, !maximized);
  };

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = () => {
    if (!previewBridge) return;
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

  const toggleViewportSizing = () => {
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }
    const root = rootRef.current;
    void commitBrowserViewportChange(
      runtimeTabId,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect: root
          ? { width: root.clientWidth, height: Math.max(1, root.clientHeight - 32) }
          : null,
        zoomFactor: desktopOverlay?.zoomFactor,
      }),
    ).catch(() => undefined);
  };

  const toggleMobileViewport = () => {
    void commitBrowserViewportChange(
      runtimeTabId,
      mobileViewport
        ? FILL_PREVIEW_VIEWPORT
        : resolvePreviewViewport({ mode: "preset", preset: "iphone-12-pro" }),
    ).catch(() => undefined);
  };

  useLayoutEffect(() => {
    if (maximized) return;
    const clampAndMove = () => {
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const nextSize = clampPreviewMiniPlayerSize(
        { width: root.offsetWidth, height: root.offsetHeight },
        { width: parent.clientWidth, height: parent.clientHeight },
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
      if (!position) {
        setDefaultLayoutVersion(`${parent.clientWidth}:${parent.clientHeight}`);
        return;
      }
      const next = clampPreviewMiniPlayerPosition(
        position,
        { width: parent.clientWidth, height: parent.clientHeight },
        nextSize,
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next);
    };
    clampAndMove();
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(clampAndMove);
    observer.observe(root);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [bottomInset, maximized, position, tabId, threadRef]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || maximized) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!drag || drag.pointerId !== event.pointerId || !root || !(parent instanceof HTMLElement)) {
      return;
    }
    const next = clampPreviewMiniPlayerPosition(
      {
        x: drag.playerX + event.clientX - drag.pointerX,
        y: drag.playerY + event.clientY - drag.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      { width: root.offsetWidth, height: root.offsetHeight },
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || maximized) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    resizeRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
      width: root.offsetWidth,
      height: root.offsetHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !resize ||
      resize.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    const nextSize = clampPreviewMiniPlayerSize(
      {
        width: resize.width + event.clientX - resize.pointerX,
        height: resize.height + event.clientY - resize.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
    const nextPosition = clampPreviewMiniPlayerPosition(
      { x: resize.playerX, y: resize.playerY },
      { width: parent.clientWidth, height: parent.clientHeight },
      nextSize,
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().move(threadRef, tabId, nextPosition);
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!snapshot || miniPlayer?.tabId !== tabId) return null;

  const player = (
    <section
      ref={rootRef}
      aria-label="Floating browser preview"
      data-preview-mini-player={tabId}
      className={
        maximized
          ? "pointer-events-none fixed z-100 flex select-none flex-col bg-background"
          : "pointer-events-none absolute flex select-none flex-col"
      }
      style={
        maximized
          ? {
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
            }
          : position
            ? { left: position.x, top: position.y, width: size.width, height: size.height }
            : {
                right: PREVIEW_MINI_PLAYER_EDGE_GAP,
                top: PREVIEW_MINI_PLAYER_EDGE_GAP,
                width: size.width,
                height: size.height,
              }
      }
    >
      {/* Always-visible chrome. Sits ABOVE the surface slot rather than over
          it: on desktop the guest page is a native view composited above the
          DOM, so any control overlapping that rect can never be hovered or
          clicked. */}
      <div
        className={
          "pointer-events-auto flex h-8 shrink-0 items-center gap-0.5 border border-b-0 border-border/80 bg-popover/92 px-1.5 shadow-lg/20 backdrop-blur-xl " +
          (maximized ? "" : "rounded-t-xl ") +
          (maximized ? "" : "cursor-grab active:cursor-grabbing")
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="min-w-0 flex-1 truncate pl-1 text-[11px] text-muted-foreground">
          {snapshot.navStatus._tag === "Idle"
            ? "Browser"
            : snapshot.navStatus.title.trim() || snapshot.navStatus.url.trim() || "Browser"}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={viewport._tag === "fill" ? "ghost" : "secondary"}
                size="icon-xs"
                aria-label={
                  viewport._tag === "fill" ? "Set viewport dimensions" : "Fill available space"
                }
                aria-pressed={viewport._tag !== "fill"}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={toggleViewportSizing}
              />
            }
          >
            <MonitorSmartphoneIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {viewport._tag === "fill" ? "Set viewport dimensions" : "Fill available space"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={mobileViewport ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={mobileViewport ? "Leave mobile viewport" : "Use mobile viewport"}
                aria-pressed={mobileViewport}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={toggleMobileViewport}
              />
            }
          >
            <SmartphoneIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {mobileViewport ? "Leave mobile viewport" : "Use mobile viewport"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Open preview in right panel"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={openInPanel}
              />
            }
          >
            <PanelRightIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open in right panel</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={
                  desktopOverlay?.pictureInPicture
                    ? "Close popped-out preview"
                    : "Pop preview into separate window"
                }
                disabled={!desktopOverlay?.hasWebContents}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={toggleNativePictureInPicture}
              />
            }
          >
            <PictureInPicture2 />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {desktopOverlay?.pictureInPicture
              ? "Close separate window"
              : "Pop into separate window"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={maximized ? "Exit full screen" : "Expand preview to full screen"}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={toggleMaximized}
              />
            }
          >
            {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {maximized ? "Exit full screen" : "Full screen"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close browser"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={closeBrowser}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Close browser</TooltipPopup>
        </Tooltip>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          className={
            "absolute inset-0 z-[29] bg-muted shadow-2xl/35 " + (maximized ? "" : "rounded-b-xl")
          }
        />
        <BrowserSurfaceSlot
          tabId={runtimeTabId}
          visible={Boolean(desktopOverlay?.hasWebContents)}
          cornerRadius={maximized ? 0 : 12}
          fitSourceContent={!maximized}
          zIndex={maximized ? 110 : 30}
          layoutVersion={
            maximized
              ? "maximized"
              : position
                ? `${position.x}:${position.y}`
                : `initial:${bottomInset}:${defaultLayoutVersion}`
          }
          className="absolute inset-0"
        />
        <div
          className={
            "pointer-events-none absolute inset-0 z-[31] ring-1 ring-inset ring-border/80 " +
            (maximized ? "" : "rounded-b-xl")
          }
        />
        {!desktopOverlay?.hasWebContents ? (
          <div
            className={
              "pointer-events-none absolute inset-0 z-[32] flex items-center justify-center bg-muted text-xs text-muted-foreground " +
              (maximized ? "" : "rounded-b-xl")
            }
          >
            Reconnecting preview…
          </div>
        ) : null}
        {!maximized ? (
          <button
            type="button"
            aria-label="Resize floating preview"
            className="pointer-events-auto absolute bottom-0 right-0 z-[33] size-5 cursor-nwse-resize rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
        ) : null}
      </div>
    </section>
  );

  return maximized ? createPortal(player, document.body) : player;
}
