import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { type ScopedThreadRef } from "@t3tools/contracts";
import { Maximize2Icon, Minimize2Icon, PictureInPicture2, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadPreviewState } from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { closePreviewSession } from "./closePreviewSession";
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
  readonly width: number;
  readonly height: number;
  readonly containerWidth: number;
  readonly containerHeight: number;
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
}

export function ThreadPreviewMiniPlayer({ threadRef, tabId }: Props) {
  const [anchorLayout, setAnchorLayout] = useState(0);
  const rootRef = useRef<HTMLElement | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingPositionRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const inFront = usePreviewMiniPlayerStore(
    (state) => state.frontThreadKey === scopedThreadKey(threadRef),
  );
  const windowLayer = inFront ? 120 : 110;
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const hasPreview = snapshot !== null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const position = miniPlayer?.tabId === tabId ? miniPlayer.position : null;
  const size =
    miniPlayer?.tabId === tabId && miniPlayer.size
      ? miniPlayer.size
      : PREVIEW_MINI_PLAYER_DEFAULT_SIZE;
  const maximized = miniPlayer?.tabId === tabId && miniPlayer.maximized;
  const floating = Boolean(miniPlayer?.tabId === tabId && miniPlayer.floating);
  const compact = !floating && !maximized;
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

  const toggleFloating = () => {
    const store = usePreviewMiniPlayerStore.getState();
    if (!floating && !miniPlayer?.size) {
      store.resize(threadRef, tabId, { width: 800, height: 560 });
    }
    store.setFloating(threadRef, tabId, !floating);
    store.setMaximized(threadRef, tabId, false);
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!compact || !hasPreview || !anchor) return;
    const observer = new ResizeObserver(() => setAnchorLayout((version) => version + 1));
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [compact, hasPreview]);

  useLayoutEffect(() => {
    if (!floating || maximized || !hasPreview) return;
    const clampAndMove = () => {
      const root = rootRef.current;
      if (!root) return;
      const container = { width: window.innerWidth, height: window.innerHeight };
      const current = selectThreadPreviewMiniPlayer(
        usePreviewMiniPlayerStore.getState().byThreadKey,
        threadRef,
      );
      const nextSize = clampPreviewMiniPlayerSize(
        current?.size ?? PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
        container,
      );
      const anchor = anchorRef.current?.getBoundingClientRect();
      const nextPosition = clampPreviewMiniPlayerPosition(
        current?.position ?? {
          x: (anchor?.right ?? container.width) - nextSize.width - PREVIEW_MINI_PLAYER_EDGE_GAP,
          y: (anchor?.top ?? 0) + PREVIEW_MINI_PLAYER_EDGE_GAP,
        },
        container,
        nextSize,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
      usePreviewMiniPlayerStore.getState().move(threadRef, tabId, nextPosition);
    };
    clampAndMove();
    window.addEventListener("resize", clampAndMove);
    return () => window.removeEventListener("resize", clampAndMove);
  }, [floating, hasPreview, maximized, tabId, threadRef]);

  useLayoutEffect(
    () => () => {
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
      pendingPositionRef.current = null;
      dragRef.current = null;
    },
    [tabId, threadRef, floating, maximized],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !floating || maximized) return;
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left,
      playerY: rootRect.top,
      width: rootRect.width,
      height: rootRect.height,
      containerWidth: window.innerWidth,
      containerHeight: window.innerHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampPreviewMiniPlayerPosition(
      {
        x: drag.playerX + event.clientX - drag.pointerX,
        y: drag.playerY + event.clientY - drag.pointerY,
      },
      { width: drag.containerWidth, height: drag.containerHeight },
      { width: drag.width, height: drag.height },
    );
    pendingPositionRef.current = next;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const pending = pendingPositionRef.current;
      pendingPositionRef.current = null;
      if (pending) usePreviewMiniPlayerStore.getState().move(threadRef, tabId, pending);
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    dragFrameRef.current = null;
    const pending = pendingPositionRef.current;
    pendingPositionRef.current = null;
    if (pending) usePreviewMiniPlayerStore.getState().move(threadRef, tabId, pending);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !floating || maximized) return;
    const root = rootRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    resizeRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left,
      playerY: rootRect.top,
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
    if (!resize || resize.pointerId !== event.pointerId || !root) {
      return;
    }
    const nextSize = clampPreviewMiniPlayerSize(
      {
        width: resize.width + event.clientX - resize.pointerX,
        height: resize.height + event.clientY - resize.pointerY,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
    const nextPosition = clampPreviewMiniPlayerPosition(
      { x: resize.playerX, y: resize.playerY },
      { width: window.innerWidth, height: window.innerHeight },
      nextSize,
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
      aria-label={compact ? "Browser preview" : "Floating browser preview"}
      data-preview-mini-player={tabId}
      onPointerDownCapture={() => {
        if (!compact) usePreviewMiniPlayerStore.getState().bringToFront(threadRef);
      }}
      className={
        maximized
          ? "pointer-events-none fixed z-100 flex select-none flex-col bg-background"
          : compact
            ? "pointer-events-none absolute z-100 flex select-none flex-col shadow-xl"
            : "pointer-events-none fixed z-100 flex select-none flex-col shadow-xl"
      }
      style={{
        zIndex: compact ? 100 : windowLayer,
        ...(maximized
          ? {
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
            }
          : compact
            ? {
                right: PREVIEW_MINI_PLAYER_EDGE_GAP,
                top: PREVIEW_MINI_PLAYER_EDGE_GAP,
                width: PREVIEW_MINI_PLAYER_DEFAULT_SIZE.width,
                height: PREVIEW_MINI_PLAYER_DEFAULT_SIZE.height,
              }
            : position
              ? { left: position.x, top: position.y, width: size.width, height: size.height }
              : {
                  right: PREVIEW_MINI_PLAYER_EDGE_GAP,
                  top: PREVIEW_MINI_PLAYER_EDGE_GAP,
                  width: size.width,
                  height: size.height,
                }),
      }}
    >
      {/* Always-visible chrome. Sits ABOVE the surface slot rather than over
          it: on desktop the guest page is a native view composited above the
          DOM, so any control overlapping that rect can never be hovered or
          clicked. */}
      <div
        className={
          "pointer-events-auto flex h-8 shrink-0 items-center gap-0.5 border border-b-0 border-border/80 bg-popover px-1.5 " +
          (maximized ? "" : "rounded-t-xl ") +
          (floating && !maximized ? "cursor-grab active:cursor-grabbing" : "")
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
                variant="ghost"
                size="icon-xs"
                aria-label={floating ? "Return to small preview" : "Open floating browser window"}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={toggleFloating}
              />
            }
          >
            <PictureInPicture2 />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {floating ? "Return to small preview" : "Open floating browser window"}
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
        <div className="absolute inset-0 z-[29] bg-muted" />
        <BrowserSurfaceSlot
          tabId={runtimeTabId}
          visible={Boolean(desktopOverlay?.hasWebContents)}
          cornerRadius={0}
          fitSourceContent={compact}
          fillContainer={!compact}
          zIndex={compact ? 110 : windowLayer + 1}
          layoutVersion={
            compact
              ? `compact:${anchorLayout}`
              : maximized
                ? "maximized"
                : position
                  ? `${position.x}:${position.y}`
                  : "initial"
          }
          className="absolute inset-0"
        />
        <div className="pointer-events-none absolute inset-0 z-[31] ring-1 ring-inset ring-border/80" />
        {!desktopOverlay?.hasWebContents ? (
          <div className="pointer-events-none absolute inset-0 z-[32] flex items-center justify-center bg-muted text-xs text-muted-foreground">
            Reconnecting preview…
          </div>
        ) : null}
      </div>
      {floating && !maximized ? (
        <button
          type="button"
          aria-label="Resize floating preview"
          className="pointer-events-auto absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      ) : null}
    </section>
  );

  return (
    <>
      <div ref={anchorRef} className="pointer-events-none absolute inset-0" aria-hidden="true" />
      {compact ? player : createPortal(player, document.body)}
    </>
  );
}
