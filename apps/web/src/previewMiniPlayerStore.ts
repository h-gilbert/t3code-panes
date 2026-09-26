import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { DevicePlatform, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

/** What the floating player mirrors: a browser tab or a device stream. */
export type PreviewMiniPlayerSource =
  | { readonly kind: "browser"; readonly tabId: string }
  | {
      readonly kind: "device";
      readonly hostId: string;
      readonly deviceId: string;
      readonly platform: DevicePlatform;
      readonly name: string;
    };

export interface PreviewMiniPlayerState {
  readonly source: PreviewMiniPlayerSource;
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly size: PreviewMiniPlayerSize | null;
  /** Fills the window instead of floating; position/size are kept for restore. */
  readonly maximized: boolean;
  readonly floating: boolean;
}

interface PreviewMiniPlayerStoreState {
  readonly frontThreadKey: string | null;
  readonly bringToFront: (ref: ScopedThreadRef) => void;
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  readonly open: (ref: ScopedThreadRef, source: PreviewMiniPlayerSource | string) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly move: (ref: ScopedThreadRef, tabId: string, position: PreviewMiniPlayerPosition) => void;
  readonly setMaximized: (ref: ScopedThreadRef, tabId: string, maximized: boolean) => void;
  readonly setFloating: (ref: ScopedThreadRef, tabId: string, floating: boolean) => void;
  readonly resize: (
    ref: ScopedThreadRef,
    tabId: string,
    size: PreviewMiniPlayerSize | number,
  ) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export function previewMiniPlayerSourceKey(source: PreviewMiniPlayerSource): string {
  return source.kind === "browser"
    ? `browser:${source.tabId}`
    : `device:${encodeURIComponent(source.hostId)}:${encodeURIComponent(source.deviceId)}`;
}

export const browserMiniPlayerSource = (tabId: string): PreviewMiniPlayerSource => ({
  kind: "browser",
  tabId,
});

function matchesSource(source: PreviewMiniPlayerSource, key: string): boolean {
  return (
    previewMiniPlayerSourceKey(source) === key ||
    (source.kind === "browser" && source.tabId === key)
  );
}

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  frontThreadKey: null,
  bringToFront: (ref) => set({ frontThreadKey: scopedThreadKey(ref) }),
  open: (ref, input) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      const source = typeof input === "string" ? browserMiniPlayerSource(input) : input;
      if (
        current &&
        previewMiniPlayerSourceKey(current.source) === previewMiniPlayerSourceKey(source)
      )
        return state;
      const sameKind = current?.source.kind === source.kind;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            source,
            width: sameKind ? current.width : null,
            position: sameKind ? current.position : null,
            size: sameKind ? current.size : null,
            maximized: sameKind ? current.maximized : false,
            floating: sameKind ? current.floating : false,
          },
        },
      };
    }),
  close: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _closed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
  setMaximized: (ref, tabId, maximized) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || !matchesSource(current.source, tabId) || current.maximized === maximized)
        return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, maximized },
        },
      };
    }),
  setFloating: (ref, tabId, floating) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || !matchesSource(current.source, tabId) || current.floating === floating)
        return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, floating },
        },
      };
    }),
  move: (ref, tabId, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || !matchesSource(current.source, tabId)) return state;
      if (current.position?.x === position.x && current.position.y === position.y) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position },
        },
      };
    }),
  resize: (ref, tabId, size) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || !matchesSource(current.source, tabId)) return state;
      if (typeof size === "number") {
        if (current.width === size) return state;
        return { byThreadKey: { ...state.byThreadKey, [threadKey]: { ...current, width: size } } };
      }
      if (current.size?.width === size.width && current.size.height === size.height) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, size },
        },
      };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}

/** The floating browser tab, or null when nothing floats or a device does. */
export function selectThreadPreviewMiniPlayerTabId(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  const source = selectThreadPreviewMiniPlayer(byThreadKey, ref)?.source;
  return source?.kind === "browser" ? source.tabId : null;
}
