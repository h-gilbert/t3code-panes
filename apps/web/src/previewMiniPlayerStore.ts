import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

export interface PreviewMiniPlayerState {
  readonly tabId: string;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly size: PreviewMiniPlayerSize | null;
  /** Fills the window instead of floating; position/size are kept for restore. */
  readonly maximized: boolean;
  readonly expanded: boolean;
  readonly windowPosition: PreviewMiniPlayerPosition | null;
  readonly windowSize: PreviewMiniPlayerSize | null;
}

interface PreviewMiniPlayerStoreState {
  readonly frontThreadKey: string | null;
  readonly bringToFront: (ref: ScopedThreadRef) => void;
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  readonly open: (ref: ScopedThreadRef, tabId: string) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly move: (ref: ScopedThreadRef, tabId: string, position: PreviewMiniPlayerPosition) => void;
  readonly setExpanded: (ref: ScopedThreadRef, tabId: string, expanded: boolean) => void;
  readonly setMaximized: (ref: ScopedThreadRef, tabId: string, maximized: boolean) => void;
  readonly resize: (ref: ScopedThreadRef, tabId: string, size: PreviewMiniPlayerSize) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  frontThreadKey: null,
  bringToFront: (ref) => set({ frontThreadKey: scopedThreadKey(ref) }),
  open: (ref, tabId) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (current?.tabId === tabId) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            tabId,
            position: current?.position ?? null,
            size: current?.size ?? null,
            maximized: current?.maximized ?? false,
            expanded: current?.expanded ?? false,
            windowPosition: current?.windowPosition ?? null,
            windowSize: current?.windowSize ?? null,
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
  setExpanded: (ref, tabId, expanded) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const current = state.byThreadKey[key];
      if (!current || current.tabId !== tabId) return state;
      return {
        frontThreadKey: expanded ? key : state.frontThreadKey,
        byThreadKey: { ...state.byThreadKey, [key]: { ...current, expanded, maximized: false } },
      };
    }),
  setMaximized: (ref, tabId, maximized) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || current.tabId !== tabId || current.maximized === maximized) return state;
      return {
        frontThreadKey: maximized ? threadKey : state.frontThreadKey,
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, maximized },
        },
      };
    }),
  move: (ref, tabId, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || current.tabId !== tabId) return state;
      const positionKey = current.expanded ? "windowPosition" : "position";
      if (current[positionKey]?.x === position.x && current[positionKey]?.y === position.y)
        return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, [positionKey]: position },
        },
      };
    }),
  resize: (ref, tabId, size) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || current.tabId !== tabId) return state;
      const sizeKey = current.expanded ? "windowSize" : "size";
      if (current[sizeKey]?.width === size.width && current[sizeKey]?.height === size.height)
        return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, [sizeKey]: size },
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
