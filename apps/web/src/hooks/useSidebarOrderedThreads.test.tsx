import { act, useLayoutEffect, useMemo } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { limitRecentSidebarThreads } from "../components/Sidebar.logic";
import { useSidebarOrderedThreads } from "./useSidebarOrderedThreads";

const threads = ["recent", "older", "oldest"];
const pinned = ["pinned"];
const working = ["working"];
const snoozed = ["snoozed"];
const settled = ["settled"];
let renderer: ReactTestRenderer | undefined;
let ordered: string[] = [];

function Probe({ routeThread, maximum }: { routeThread: string | null; maximum: number }) {
  const visibleActiveThreads = useMemo(
    () => limitRecentSidebarThreads({ threads, maximum, activeThread: routeThread }),
    [routeThread, maximum],
  );
  const value = useSidebarOrderedThreads(pinned, visibleActiveThreads, working, snoozed, settled);
  useLayoutEffect(() => {
    ordered = value;
  });
  return null;
}

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("includes the newly opened thread outside the preview limit without a server update", () => {
  act(() => {
    renderer = create(<Probe routeThread={null} maximum={1} />);
  });
  expect(ordered).toEqual(["pinned", "recent", "working", "snoozed", "settled"]);

  act(() => renderer?.update(<Probe routeThread="oldest" maximum={1} />));
  expect(ordered).toEqual(["pinned", "oldest", "working", "snoozed", "settled"]);

  act(() => renderer?.update(<Probe routeThread={null} maximum={1} />));
  expect(ordered).toEqual(["pinned", "recent", "working", "snoozed", "settled"]);
});

it("updates selection and shortcut order when the preview limit changes", () => {
  act(() => {
    renderer = create(<Probe routeThread={null} maximum={1} />);
  });
  const initialOrder = ordered;
  act(() => renderer?.update(<Probe routeThread={null} maximum={1} />));
  expect(ordered).toBe(initialOrder);

  act(() => renderer?.update(<Probe routeThread={null} maximum={3} />));
  expect(ordered).toEqual(["pinned", "recent", "older", "oldest", "working", "snoozed", "settled"]);

  act(() => renderer?.update(<Probe routeThread={null} maximum={1} />));
  expect(ordered).toEqual(["pinned", "recent", "working", "snoozed", "settled"]);
});
