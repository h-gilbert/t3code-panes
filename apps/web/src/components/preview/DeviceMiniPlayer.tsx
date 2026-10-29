import { createPortal } from "react-dom";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { observeResize } from "~/lib/observeResize";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { Maximize2Icon, Minimize2Icon, PictureInPicture2, XIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { BrowserViewportResizeDirection } from "~/browser/browserViewportLayout";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  type PreviewMiniPlayerSize,
  type PreviewMiniPlayerSource,
  type PreviewMiniPlayerState,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { useDeviceState } from "~/state/device";

import { DeviceStreamView } from "../device/DeviceStreamView";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import {
  clampPreviewMiniPlayerPosition,
  PREVIEW_MINI_PLAYER_CORNER_RADIUS,
  PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX,
  type PreviewMiniPlayerFrame,
  resizePreviewMiniPlayer,
  resolveDeviceMiniPlayerCornerRadius,
  resolveDeviceMiniPlayerSourceSize,
  resolvePreviewMiniPlayerFrame,
} from "./previewMiniPlayerLayout";

interface PointerGesture {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly frame: PreviewMiniPlayerFrame;
  readonly direction: BrowserViewportResizeDirection | null;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  readonly bottomInset: number;
}

const frameCornerRadius = () => PREVIEW_MINI_PLAYER_CORNER_RADIUS;

// Invisible grab zones straddling each edge; the cursor is the only affordance.
const RESIZE_HANDLES: ReadonlyArray<{
  readonly direction: BrowserViewportResizeDirection;
  readonly className: string;
}> = [
  { direction: "north", className: "inset-x-0 -top-1 h-2 cursor-ns-resize" },
  { direction: "south", className: "inset-x-0 -bottom-1 h-2 cursor-ns-resize" },
  { direction: "west", className: "inset-y-0 -left-1 w-2 cursor-ew-resize" },
  { direction: "east", className: "inset-y-0 -right-1 w-2 cursor-ew-resize" },
  { direction: "northwest", className: "-left-2 -top-2 size-4 cursor-nwse-resize" },
  { direction: "northeast", className: "-right-2 -top-2 size-4 cursor-nesw-resize" },
  { direction: "southwest", className: "-bottom-2 -left-2 size-4 cursor-nesw-resize" },
  { direction: "southeast", className: "-bottom-2 -right-2 size-4 cursor-nwse-resize" },
];

export function DeviceMiniPlayer({
  threadRef,
  source,
  miniPlayer,
  bottomInset,
}: Props & { readonly source: Extract<PreviewMiniPlayerSource, { kind: "device" }> }) {
  const { state: deviceState } = useDeviceState(threadRef.environmentId);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const sourceSize = resolveDeviceMiniPlayerSourceSize(source.platform, screen);
  const device = deviceState.devices.find(
    (entry) => entry.hostId === source.hostId && entry.id === source.deviceId,
  );
  const hostLabel =
    deviceState.hosts.find((host) => host.id === source.hostId)?.label ?? "Device host";
  const cornerRadius = (player: PreviewMiniPlayerSize) =>
    resolveDeviceMiniPlayerCornerRadius(source.platform, player);

  return (
    <MiniPlayerShell
      threadRef={threadRef}
      miniPlayer={miniPlayer}
      sourceSize={sourceSize}
      bottomInset={bottomInset}
      label="Floating device preview"
      cornerRadius={cornerRadius}
    >
      {() => (
        // The stream is DOM, so it takes the band the browser's native webview would.
        <div
          className="pointer-events-auto absolute inset-0 overflow-hidden rounded-[inherit]"
          style={{ zIndex: PREVIEW_MINI_PLAYER_WEBVIEW_Z_INDEX }}
        >
          <DeviceStreamView
            environmentId={threadRef.environmentId}
            platform={source.platform}
            deviceId={source.deviceId}
            hostId={source.hostId}
            deviceName={device?.name ?? source.name}
            deviceDescription={`${hostLabel} · ${device?.version ?? source.platform}`}
            visible
            onScreen={setScreen}
          />
        </div>
      )}
    </MiniPlayerShell>
  );
}

// Device windows keep the screen aspect ratio when dragged or resized.
function MiniPlayerShell({
  threadRef,
  miniPlayer,
  sourceSize,
  bottomInset,
  label,
  pillActions,
  cornerRadius = frameCornerRadius,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly miniPlayer: PreviewMiniPlayerState;
  readonly sourceSize: PreviewMiniPlayerSize;
  readonly bottomInset: number;
  readonly label: string;
  readonly pillActions?: ReactNode;
  /** The clip radius for a given frame; the pill stays inside the curve. */
  readonly cornerRadius?: (frame: PreviewMiniPlayerSize) => number;
  readonly children: (frame: PreviewMiniPlayerFrame) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<PointerGesture | null>(null);
  const [container, setContainer] = useState<PreviewMiniPlayerSize | null>(null);
  const sourceKey = previewMiniPlayerSourceKey(miniPlayer.source);
  const { maximized, floating } = miniPlayer;
  const compact = !maximized && !floating;
  const inFront = usePreviewMiniPlayerStore(
    (state) => state.frontThreadKey === scopedThreadKey(threadRef),
  );
  const obstacles = {
    detailsCard: null,
    composer:
      compact && container && bottomInset > 0
        ? { left: 0, right: container.width, height: bottomInset }
        : null,
  };
  const frame = container
    ? maximized
      ? { x: 0, y: 0, width: container.width, height: container.height }
      : resolvePreviewMiniPlayerFrame({
          width: miniPlayer.width ?? (floating ? 360 : null),
          position: miniPlayer.position,
          source: sourceSize,
          container,
          obstacles,
        })
    : null;

  const radius = maximized ? 0 : frame ? cornerRadius(frame) : PREVIEW_MINI_PLAYER_CORNER_RADIUS;
  // Inside a wide curve the default 8px inset would land on the clipped-away corner.
  const pillInset = Math.max(8, Math.round(radius * 0.55));

  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const size = compact
        ? { width: element.clientWidth, height: element.clientHeight }
        : { width: window.innerWidth, height: window.innerHeight };
      setContainer((current) =>
        current?.width === size.width && current.height === size.height ? current : size,
      );
    };
    measure();
    if (!compact) {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    if (typeof ResizeObserver === "undefined") return;
    return observeResize(element, measure);
  }, [compact]);

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    direction: BrowserViewportResizeDirection | null,
  ) => {
    if (event.button !== 0 || !frame || maximized) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      frame,
      direction,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !container) return;
    const delta = { x: event.clientX - gesture.pointerX, y: event.clientY - gesture.pointerY };
    const store = usePreviewMiniPlayerStore.getState();
    if (gesture.direction === null) {
      store.move(
        threadRef,
        sourceKey,
        clampPreviewMiniPlayerPosition(
          { x: gesture.frame.x + delta.x, y: gesture.frame.y + delta.y },
          container,
          gesture.frame,
          obstacles,
        ),
      );
      return;
    }
    const next = resizePreviewMiniPlayer({
      start: gesture.frame,
      direction: gesture.direction,
      delta,
      source: sourceSize,
      container,
      obstacles,
    });
    store.resize(threadRef, sourceKey, next.width);
    store.move(threadRef, sourceKey, { x: next.x, y: next.y });
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const player = frame ? (
    <section
      aria-label={label}
      data-preview-mini-player={sourceKey}
      data-preview-presentation={maximized ? "fullscreen" : floating ? "window" : "mini"}
      onPointerDownCapture={() => {
        if (!compact) usePreviewMiniPlayerStore.getState().bringToFront(threadRef);
      }}
      onClick={(event) => event.stopPropagation()}
      className={cn("pointer-events-none select-none", compact ? "absolute" : "fixed")}
      style={{
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        borderRadius: radius,
        zIndex: compact ? undefined : inFront ? 120 : 110,
      }}
    >
      <div
        className={cn(
          "group pointer-events-auto absolute z-[49] size-3",
          !compact && "[&>div]:pointer-events-auto [&>div]:opacity-100",
        )}
        style={{ right: pillInset, top: pillInset }}
      >
        <div
          aria-hidden="true"
          className="absolute right-0 top-0 size-2 rounded-full bg-foreground/25 shadow-sm ring-1 ring-background/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
        />
        <div
          className="pointer-events-none absolute right-0 top-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing"
          onPointerDown={(event) => beginGesture(event, null)}
          onPointerMove={handlePointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={maximized ? "Exit full screen" : "Expand preview to full screen"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() =>
                    usePreviewMiniPlayerStore
                      .getState()
                      .setMaximized(threadRef, sourceKey, !maximized)
                  }
                />
              }
            >
              {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
            </TooltipTrigger>
            <TooltipPopup side="top">{maximized ? "Exit full screen" : "Full screen"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={floating ? "Return to small preview" : "Open floating device window"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    const store = usePreviewMiniPlayerStore.getState();
                    store.setFloating(threadRef, sourceKey, !floating);
                    store.setMaximized(threadRef, sourceKey, false);
                  }}
                />
              }
            >
              <PictureInPicture2 />
            </TooltipTrigger>
            <TooltipPopup side="top">{floating ? "Small preview" : "Floating window"}</TooltipPopup>
          </Tooltip>
          {pillActions}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close floating preview"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={close}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Close floating preview</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      <div className="absolute inset-0 z-[47] rounded-[inherit] bg-muted shadow-2xl/35" />
      {children(frame)}
      <div className="pointer-events-none absolute inset-0 z-[49] rounded-[inherit] ring-1 ring-inset ring-border/80" />
      {!maximized &&
        RESIZE_HANDLES.map(({ direction, className }) => (
          <div
            key={direction}
            role="presentation"
            data-preview-mini-player-resize={direction}
            className={cn("pointer-events-auto absolute z-[49] touch-none", className)}
            onPointerDown={(event) => beginGesture(event, direction)}
            onPointerMove={handlePointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
        ))}
    </section>
  ) : null;
  return (
    <>
      <div ref={containerRef} className="pointer-events-none absolute inset-0">
        {compact ? player : null}
      </div>
      {!compact && player ? createPortal(player, document.body) : null}
    </>
  );
}
