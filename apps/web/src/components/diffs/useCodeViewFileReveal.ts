import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useEffect, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  getItem(id: string): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

/**
 * Scrolls a code view to a file. `attach` is the viewer's ref and `flush` its post-render
 * handler, so a reveal asked before the viewer mounts, or for a file it does not hold yet, is
 * positioned once it does. Detaching drops pending requests unless the hook owns an explicit
 * scope, which retains requests across temporary detachment until that scope changes.
 */
export function createCodeViewFileReveal(defer = false) {
  let viewer: FileRevealHandle | null = null;
  let pending: string | null = null;
  const flush = () => {
    if (pending === null || viewer === null) return;
    if (!viewer.getInstance() || viewer.getItem(pending) === undefined) return;
    viewer.scrollTo({ type: "item", id: pending, align: "start" });
    pending = null;
  };
  return {
    attach(next: FileRevealHandle | null) {
      if (!defer && viewer !== null && next !== viewer) pending = null;
      viewer = next;
      if (!defer) flush();
    },
    request(fileKey: string) {
      pending = fileKey;
      if (!defer) flush();
    },
    flush,
  };
}

export function useCodeViewFileReveal(scope: unknown = null) {
  const [, update] = useState(0);
  const createScopedReveal = () => {
    const pending = createCodeViewFileReveal(scope !== null);
    return {
      scope,
      reveal:
        scope === null
          ? pending
          : {
              ...pending,
              request(fileKey: string) {
                pending.request(fileKey);
                update((value) => value + 1);
              },
            },
    };
  };
  const [state, setState] = useState(createScopedReveal);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals after the commit expands the requested file
  useEffect(() => {
    if (scope !== null) state.reveal.flush();
  });
  if (state.scope !== scope) {
    const next = createScopedReveal();
    setState(next);
    return next.reveal;
  }
  return state.reveal;
}
