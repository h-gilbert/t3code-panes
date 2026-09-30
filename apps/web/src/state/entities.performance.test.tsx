import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { useEnvironmentBootstrapComplete, useThreadTitle } from "./entities";
import { environmentShell } from "./shell";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

vi.mock("./threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return {
    environmentThreadShells: {
      threadShellAtom: Atom.family(() => Atom.make<{ title: string } | null>(null)),
    },
    environmentThreadDetails: {
      detailAtom: Atom.family(() => Atom.make<{ title: string } | null>(null)),
    },
  };
});

vi.mock("./shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Option = await import("effect/Option");
  const initial: EnvironmentShellState = {
    snapshot: Option.none(),
    status: "empty",
    error: Option.none(),
  };
  return {
    environmentShell: { stateValueAtom: Atom.family(() => Atom.make(initial)) },
    allEnvironmentShellsBootstrappedAtom: Atom.make(false),
    allEnvironmentProjectSnapshotsReadyAtom: Atom.make(false),
    environmentSnapshotAtom: () => Atom.make(null),
  };
});

describe("pane title subscriptions", () => {
  it("ignores unchanged titles and detail activity, and restores the detail fallback when the shell disappears", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const registry = AtomRegistry.make();
    const ref = {
      environmentId: EnvironmentId.make("title-performance"),
      threadId: ThreadId.make("thread"),
    };
    // These mock atoms only expose the title, which is all the hook reads.
    const shell = environmentThreadShells.threadShellAtom(ref) as Atom.Writable<{
      title: string;
    } | null>;
    const detail = environmentThreadDetails.detailAtom(ref) as Atom.Writable<{
      title: string;
    } | null>;
    // The chat owns the detail subscription even when the title reads only the shell.
    const releaseDetail = registry.mount(detail);
    registry.set(shell, { title: "Shell title" });
    registry.set(detail, { title: "Cached detail title" });
    let renders = 0;
    let title: string | null = null;
    function Probe() {
      title = useThreadTitle(ref);
      renders += 1;
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <RegistryContext.Provider value={registry}>
            <Probe />
          </RegistryContext.Provider>,
        );
      });
      expect(title).toBe("Shell title");
      const initialRenders = renders;
      await act(() => registry.set(shell, { title: "Shell title" }));
      await act(() => registry.set(detail, { title: "New detail title" }));
      expect(renders).toBe(initialRenders);

      await act(() => registry.set(shell, { title: "Renamed shell" }));
      expect(title).toBe("Renamed shell");
      await act(() => registry.set(shell, null));
      expect(title).toBe("New detail title");
      await act(() => registry.set(detail, { title: "Renamed detail" }));
      expect(title).toBe("Renamed detail");
    } finally {
      await act(() => renderer?.unmount());
      releaseDetail();
      registry.dispose();
      vi.unstubAllGlobals();
    }
  });
});

const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
};

describe("pane bootstrap subscriptions", () => {
  it("updates nine loading guards on bootstrap and reconnect, without rerendering them for shell activity", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("pane-performance");
    const shell = environmentShell.stateValueAtom(
      environmentId,
    ) as Atom.Writable<EnvironmentShellState>;
    let renders = 0;
    const values: boolean[] = [];
    function Probe({ index }: { index: number }) {
      values[index] = useEnvironmentBootstrapComplete(environmentId);
      renders += 1;
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          <RegistryContext.Provider value={registry}>
            {Array.from({ length: 9 }, (_, index) => (
              <Probe key={index} index={index} />
            ))}
          </RegistryContext.Provider>,
        );
      });
      expect(values).toEqual(Array(9).fill(false));
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: "2026-09-30T00:00:00Z",
        projects: [],
        threads: [],
      };
      await act(() =>
        registry.set(shell, {
          ...EMPTY_SHELL_STATE,
          snapshot: Option.some(snapshot),
          status: "live",
        }),
      );
      expect(values).toEqual(Array(9).fill(true));
      const bootstrappedRenders = renders;
      for (let sequence = 2; sequence <= 101; sequence += 1) {
        await act(() =>
          registry.set(shell, {
            ...EMPTY_SHELL_STATE,
            snapshot: Option.some({ ...snapshot, snapshotSequence: sequence }),
            status: "live",
          }),
        );
      }
      expect(renders).toBe(bootstrappedRenders);
      await act(() => registry.set(shell, EMPTY_SHELL_STATE));
      expect(values).toEqual(Array(9).fill(false));
    } finally {
      await act(() => renderer?.unmount());
      registry.dispose();
      vi.unstubAllGlobals();
    }
  });
});
