import {
  FileRenderer,
  getSharedHighlighter,
  type CodeViewScrollTarget,
  type FileContents,
} from "@pierre/diffs";
import { useWorkerPool, type CodeViewProps } from "@pierre/diffs/react";
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker";
import {
  createContext,
  StrictMode,
  use,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));

vi.mock("@pierre/diffs/react", async (importOriginal) => {
  const { WorkerPoolContext, useWorkerPool } =
    await importOriginal<typeof import("@pierre/diffs/react")>();
  return {
    WorkerPoolContext,
    useWorkerPool,
    CodeView: (props: CodeViewProps<undefined, undefined>) =>
      props.items?.map((item) =>
        item.type === "file" ? <FileOutput key={item.id} file={item.file} /> : null,
      ),
  };
});

import { StyledDiffCodeView } from "./StyledDiffCodeView";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

const RenderPools = createContext<((pool: WorkerPoolManager | undefined) => void) | null>(null);

function FileOutput({ file }: { file: FileContents }) {
  const pool = useWorkerPool();
  const recordPool = use(RenderPools);
  const [html, setHtml] = useState("");
  useEffect(() => {
    recordPool?.(pool);
    const renderer = new FileRenderer(
      { theme: "pierre-dark", preferredHighlighter: "shiki-wasm" },
      undefined,
      render,
      pool,
    );
    function render() {
      const result = renderer.renderFile(file);
      if (result) setHtml(renderer.renderFullHTML(result));
    }
    render();
    return () => renderer.cleanUp();
  }, [file, pool, recordPool]);
  return <pre data-code-file={file.name}>{html}</pre>;
}

const files = [
  { name: "notes.txt", contents: "Plain text is ready.\n", cacheKey: "plain-text" },
  { name: "answer.ts", contents: "const answer = 42;\n", cacheKey: "typescript" },
] satisfies FileContents[];

function Views({ count }: { count: number }) {
  const [draft, setDraft] = useState("Draft");
  return (
    <>
      <button onClick={() => setDraft("Edited draft")}>{draft}</button>
      {files.slice(0, count).map((file) => (
        <StyledDiffCodeView key={file.name} items={[{ type: "file", id: file.name, file }]} />
      ))}
    </>
  );
}

function setupWorkerLifecycle({
  cores = 2,
  failWorkers = false,
  holdInitialization = false,
}: { cores?: number; failWorkers?: boolean; holdInitialization?: boolean } = {}) {
  const disposables = new DisposableStack();
  const workers: Worker[] = [];
  const terminations: Worker[] = [];
  const requests: WorkerRequest[] = [];
  const pools = new Map<WorkerPoolManager, Promise<void>>();
  const renderPools: (WorkerPoolManager | undefined)[] = [];
  const heldResponses: (() => void)[] = [];
  const initializationHeld = Promise.withResolvers<void>();
  const BrowserWorker = Worker;
  const coreCount = vi
    .spyOn(Navigator.prototype, "hardwareConcurrency", "get")
    .mockReturnValue(cores);

  disposables.use(coreCount);
  disposables.use(fakeTimers());
  // Observe real browser workers. A held response can be delivered after termination.
  disposables.use(
    stubGlobal(
      "Worker",
      class extends BrowserWorker {
        constructor(...args: ConstructorParameters<typeof BrowserWorker>) {
          if (failWorkers) throw new Error("Worker creation failed");
          super(...args);
          workers.push(this);
          if (holdInitialization) {
            this.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
              if (
                !event.isTrusted ||
                event.data.type !== "success" ||
                event.data.requestType !== "initialize"
              )
                return;
              event.stopImmediatePropagation();
              heldResponses.push(() =>
                this.dispatchEvent(new MessageEvent("message", { data: event.data })),
              );
              if (heldResponses.length === workers.length) initializationHeld.resolve();
            });
          }
        }

        override postMessage(
          message: WorkerRequest,
          transfer: Transferable[] | StructuredSerializeOptions = [],
        ) {
          requests.push(message);
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        }

        override terminate() {
          terminations.push(this);
          super.terminate();
        }
      },
    ),
  );

  const initialize = WorkerPoolManager.prototype.initialize;
  disposables.use(
    vi.spyOn(WorkerPoolManager.prototype, "initialize").mockImplementation(function (
      this: WorkerPoolManager,
      ...args
    ) {
      const pending = initialize.apply(this, args);
      pools.set(this, pending);
      return pending;
    }),
  );

  const recordPool = (pool: WorkerPoolManager | undefined) => renderPools.push(pool);
  return {
    workers,
    terminations,
    requests,
    pools,
    renderPools,
    heldResponses,
    initializationHeld,
    views: (count: number) => (
      <StrictMode>
        <RenderPools value={recordPool}>
          <Views count={count} />
        </RenderPools>
      </StrictMode>
    ),
    async [Symbol.asyncDispose]() {
      try {
        await vi.runOnlyPendingTimersAsync();
      } finally {
        disposables.dispose();
      }
    },
  };
}

// Workers and reveal fixtures do not read route state.
const renderOptions = { router: false } as const;

describe("code-view worker lifecycle", () => {
  it("starts on demand, keeps quick reopens warm, and expires the last closed pool", async () => {
    await using test = setupWorkerLifecycle();
    await using screen = await render(test.views(0), renderOptions);
    const button = screen.getByRole("button", { name: "Draft", exact: true });
    const draft = button.element();
    expect(test.workers).toHaveLength(0);
    expect(test.pools.size).toBe(0);

    await act(async () => {
      draft.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await screen.rerender(test.views(1));
    });
    const pool = [...test.pools.keys()][0]!;
    await act(() => test.pools.get(pool));
    expect(pool.isInitialized()).toBe(true);
    expect(test.workers).toHaveLength(2);
    expect(screen.container.querySelector('[data-code-file="notes.txt"]')?.textContent).toContain(
      "Plain text is ready.",
    );
    expect(test.requests.filter((request) => request.type === "file")).toHaveLength(0);

    await screen.rerender(test.views(2));
    await act(() => pool.primeFileHighlightCache(files[1]!));
    expect(test.pools.size).toBe(1);
    expect(test.workers).toHaveLength(2);
    expect(new Set(test.renderPools)).toEqual(new Set([pool]));
    expect(pool.getFileResultCache(files[1]!)).toBeDefined();
    expect(screen.container.querySelector('[data-code-file="answer.ts"]')?.textContent).toContain(
      "answer",
    );

    await screen.rerender(test.views(1));
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(test.terminations).toHaveLength(0);
    await screen.rerender(test.views(0));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(test.terminations).toHaveLength(0);

    await screen.rerender(test.views(1));
    expect(test.pools.size).toBe(1);
    expect(test.workers).toHaveLength(2);
    expect(screen.getByRole("status").elements()).toHaveLength(0);
    expect(pool.getFileResultCache(files[1]!)).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool.getStats().totalWorkers).toBe(2);

    await screen.rerender(test.views(0));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool.getStats().totalWorkers).toBe(0);
    expect(test.terminations).toHaveLength(2);

    await screen.rerender(test.views(1));
    const reopenedPool = [...test.pools.keys()][1]!;
    await act(() => test.pools.get(reopenedPool));
    expect(reopenedPool.isInitialized()).toBe(true);
    expect(test.workers).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Edited draft" }).element()).toBe(draft);
    expect(screen.container.querySelector('[data-code-file="notes.txt"]')?.textContent).toContain(
      "Plain text is ready.",
    );
  });

  it("caps workers on a high core count machine", async () => {
    await using test = setupWorkerLifecycle({ cores: 12 });
    await using screen = await render(test.views(1), renderOptions);
    const pool = [...test.pools.keys()][0]!;
    await act(() => test.pools.get(pool));
    expect(pool.getStats().totalWorkers).toBe(3);
    expect(screen.container.querySelector('[data-code-file="notes.txt"]')?.textContent).toContain(
      "Plain text is ready.",
    );
  });

  it("renders through Pierre's main-thread fallback when worker creation fails", async () => {
    await using test = setupWorkerLifecycle({ failWorkers: true });
    await using screen = await render(test.views(1), renderOptions);
    const pool = [...test.pools.keys()][0]!;
    await act(async () => {
      await expect(test.pools.get(pool)).rejects.toMatchObject({ _tag: "DiffWorkerError" });
      await getSharedHighlighter({
        themes: ["pierre-dark"],
        langs: ["text"],
        preferredHighlighter: "shiki-wasm",
      });
    });
    expect(pool.isWorkingPool()).toBe(false);
    expect(test.workers).toHaveLength(0);
    expect(screen.container.querySelector('[data-code-file="notes.txt"]')?.textContent).toContain(
      "Plain text is ready.",
    );
  });

  it("keeps an initializing pool until its last view closes and ignores late responses", async () => {
    await using test = setupWorkerLifecycle({ holdInitialization: true });
    await using screen = await render(test.views(2), renderOptions);
    const pool = [...test.pools.keys()][0]!;
    const pending = test.pools.get(pool)!;
    await test.initializationHeld.promise;
    expect(pool.isInitialized()).toBe(false);
    expect(test.pools.size).toBe(1);
    expect(screen.getByRole("status").elements()).toHaveLength(2);
    expect(test.renderPools).toHaveLength(0);

    await screen.rerender(test.views(1));
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(test.terminations).toHaveLength(0);
    await screen.rerender(test.views(0));
    // Pierre's startup timeout runs before the idle pool is torn down.
    const timedOut = expect(pending).rejects.toThrow("worker initialization timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
    await act(() => {
      for (const deliver of test.heldResponses) deliver();
    });
    expect(pool.getStats().totalWorkers).toBe(0);
    expect(test.workers).toHaveLength(2);
    expect(test.terminations).toHaveLength(2);
    expect(test.renderPools).toHaveLength(0);
    expect(screen.container.querySelectorAll("pre")).toHaveLength(0);
  });
});

type RevealHandle = NonNullable<Parameters<ReturnType<typeof useCodeViewFileReveal>["attach"]>[0]>;
type RevealCall = {
  scope: string;
  fileKey: string;
  mounted: boolean;
  collapsed: boolean | undefined;
};

function RevealViewer({
  viewerRef,
  scope,
  collapsed,
  onReveal,
}: {
  viewerRef: Ref<RevealHandle>;
  scope: string;
  collapsed: boolean;
  onReveal: (call: RevealCall) => void;
}) {
  const instance = useRef<{ collapsed: boolean } | undefined>(undefined);
  const [viewerInstance] = useState(() => ({ getRenderedItems: () => [] }));
  useLayoutEffect(() => {
    instance.current = { collapsed };
    return () => {
      instance.current = undefined;
    };
  }, [collapsed]);
  const [handle] = useState(() => ({
    getInstance: () => (instance.current ? viewerInstance : undefined),
    getItem: () => instance.current,
    scrollTo: (target: CodeViewScrollTarget) => {
      if (target.type !== "item") return;
      onReveal({
        scope,
        fileKey: target.id,
        mounted: instance.current !== undefined,
        collapsed: instance.current?.collapsed,
      });
    },
  }));
  useImperativeHandle(viewerRef, () => handle, [handle]);
  return null;
}

function RevealViews({
  scope,
  visible,
  selectedFile = null,
  requestId = 0,
  onReveal,
}: {
  scope: string;
  visible: boolean;
  selectedFile?: string | null;
  requestId?: number;
  onReveal: (call: RevealCall) => void;
}) {
  const [viewer, setViewer] = useState<RevealHandle | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const selectedRequest = JSON.stringify([selectedFile, requestId]);
  useEffect(() => {
    const [file] = JSON.parse(selectedRequest) as [string | null, number];
    if (!file || !viewer?.getInstance()) return;
    viewer.scrollTo({ type: "item", id: file, align: "start" });
  }, [selectedRequest, viewer]);
  const revealScope = JSON.stringify([scope, selectedRequest]);
  const requestReveal = useCodeViewFileReveal(revealScope);
  useLayoutEffect(() => {
    requestReveal.attach(viewer);
    return () => requestReveal.attach(null);
  }, [viewer, requestReveal]);
  useEffect(() => requestReveal.flush());
  return (
    <>
      {visible && (
        <RevealViewer
          key={scope}
          viewerRef={setViewer}
          scope={scope}
          collapsed={collapsed}
          onReveal={onReveal}
        />
      )}
      <button
        onClick={() => {
          setCollapsed(false);
          requestReveal.request("tree-file");
        }}
      >
        Reveal file
      </button>
    </>
  );
}

describe("code-view file reveals", () => {
  it("does not replay a handled tree click or scroll an old handle when a selected file remounts the view", async () => {
    const revealCalls: RevealCall[] = [];
    const onReveal = (call: RevealCall) => revealCalls.push(call);
    await using screen = await render(
      <RevealViews scope="first" visible selectedFile="external-a" onReveal={onReveal} />,
      renderOptions,
    );
    const reveal = screen.getByRole("button", { name: "Reveal file" });
    await reveal.click();
    expect(revealCalls.at(-1)?.fileKey).toBe("tree-file");
    revealCalls.length = 0;

    await screen.rerender(
      <RevealViews
        scope="second"
        visible
        selectedFile="external-b"
        requestId={1}
        onReveal={onReveal}
      />,
    );
    expect(revealCalls).toEqual([
      { scope: "second", fileKey: "external-b", mounted: true, collapsed: false },
    ]);
  });

  it("waits for a live viewer and applies each pending tree click only once", async () => {
    const revealCalls: RevealCall[] = [];
    const onReveal = (call: RevealCall) => revealCalls.push(call);
    await using screen = await render(
      <RevealViews scope="diff" visible={false} selectedFile="external" onReveal={onReveal} />,
      renderOptions,
    );
    const reveal = screen.getByRole("button", { name: "Reveal file" });
    await reveal.click();
    expect(revealCalls).toEqual([]);

    await screen.rerender(
      <RevealViews scope="diff" visible selectedFile="external" onReveal={onReveal} />,
    );
    expect(revealCalls.map((call) => call.fileKey)).toEqual(["external", "tree-file"]);
    revealCalls.length = 0;
    await screen.rerender(
      <RevealViews scope="diff" visible={false} selectedFile="external" onReveal={onReveal} />,
    );
    await screen.rerender(
      <RevealViews scope="diff" visible selectedFile="external" onReveal={onReveal} />,
    );
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "external", mounted: true, collapsed: false },
    ]);

    revealCalls.length = 0;
    await act(async () => {
      reveal.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await screen.rerender(
        <RevealViews scope="diff" visible={false} selectedFile="external" onReveal={onReveal} />,
      );
    });
    expect(revealCalls).toEqual([]);
    await screen.rerender(
      <RevealViews scope="diff" visible selectedFile="external" onReveal={onReveal} />,
    );
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "external", mounted: true, collapsed: false },
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
    ]);
  });

  it("cancels pending tree clicks when an external selection or diff scope changes", async () => {
    const revealCalls: RevealCall[] = [];
    const onReveal = (call: RevealCall) => revealCalls.push(call);
    await using screen = await render(
      <RevealViews scope="first" visible={false} selectedFile="external-a" onReveal={onReveal} />,
      renderOptions,
    );
    const reveal = screen.getByRole("button", { name: "Reveal file" });
    await reveal.click();
    await screen.rerender(
      <RevealViews
        scope="first"
        visible
        selectedFile="external-b"
        requestId={1}
        onReveal={onReveal}
      />,
    );
    expect(revealCalls.map((call) => call.fileKey)).toEqual(["external-b"]);
    revealCalls.length = 0;

    await screen.rerender(<RevealViews scope="first" visible={false} onReveal={onReveal} />);
    await reveal.click();
    await screen.rerender(<RevealViews scope="second" visible={false} onReveal={onReveal} />);
    await screen.rerender(<RevealViews scope="first" visible onReveal={onReveal} />);
    expect(revealCalls).toEqual([]);
  });

  it("reveals after a collapsed file expands and honors another click on the same file", async () => {
    const revealCalls: RevealCall[] = [];
    const onReveal = (call: RevealCall) => revealCalls.push(call);
    await using screen = await render(
      <RevealViews scope="diff" visible onReveal={onReveal} />,
      renderOptions,
    );
    const reveal = screen.getByRole("button", { name: "Reveal file" });
    await reveal.click();
    await reveal.click();
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
    ]);
  });
});
