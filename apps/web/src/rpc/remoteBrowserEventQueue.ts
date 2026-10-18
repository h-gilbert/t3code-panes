import type { DesktopBrowserEvent } from "@t3tools/contracts";

/** Keep protocol order without paying one network round trip per CDP event. */
export function createRemoteBrowserEventQueue(
  send: (events: readonly DesktopBrowserEvent[]) => Promise<void>,
  onError: (cause: unknown) => void,
) {
  const pending: { event: DesktopBrowserEvent; size: number }[] = [];
  let running = false;
  let closed = false;
  const close = () => {
    closed = true;
    pending.length = 0;
  };
  const drain = async () => {
    while (pending.length > 0) {
      if (closed) return;
      const batch: DesktopBrowserEvent[] = [];
      let size = 0;
      // Bound both event count and JSON size; one large frame still travels alone.
      while (pending.length > 0 && batch.length < 64) {
        const next = pending[0]!;
        if (batch.length > 0 && size + next.size > 8 * 1024 * 1024) break;
        pending.shift();
        batch.push(next.event);
        size += next.size;
      }
      await send(batch);
    }
  };
  const start = () => {
    if (running || closed || pending.length === 0) return;
    running = true;
    queueMicrotask(() => {
      void drain()
        .catch((cause: unknown) => {
          if (closed) return;
          close();
          onError(cause);
        })
        .finally(() => {
          running = false;
          start();
        });
    });
  };
  return {
    close,
    enqueue: (event: DesktopBrowserEvent) => {
      if (closed) return;
      pending.push({ event, size: JSON.stringify(event).length });
      start();
    },
  };
}
