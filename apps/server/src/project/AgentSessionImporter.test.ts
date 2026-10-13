import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const layerTest = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        IdAllocator.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(layerTest));
});

/** V1's retry/root/resume invariants exercised at the V2 import boundary. */
function importHarness(
  options: {
    source?: "codex" | "claudeAgent";
    nativeId?: string;
    existing?: { projectId: ProjectId; historyOrigin: "v1_import" | "native" };
    failWriteOnce?: boolean;
    bindingGate?: Deferred.Deferred<void>;
    bindingStarted?: Deferred.Deferred<void>;
  } = {},
) {
  const source = options.source ?? "codex";
  const nativeId = options.nativeId ?? providerSessionId;
  const instanceId = ProviderInstanceId.make(source);
  const importedId = ThreadId.make(`import:${instanceId}:${nativeId}`);
  const scannedRoots: string[] = [];
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const cursors: unknown[] = [];
  const order: string[] = [];
  let failWrite = options.failWriteOnce ?? false;
  let completed = false;
  const layer = AgentSessionImporter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AgentSessionScanner.AgentSessionScanner)({
          recentThreads: (root) => {
            scannedRoots.push(root);
            return Stream.succeed({
              _tag: "Importable" as const,
              source: {
                provider: source,
                providerInstanceId: instanceId,
                providerSessionId: nativeId,
                filePath: "/tmp/source.jsonl",
                size: 1,
                mtimeMs: 1,
                device: 1,
                inode: 1,
                birthtimeMs: 1,
              },
              thread: {
                source,
                providerInstanceId: instanceId,
                providerSessionId: nativeId,
                title: "Imported",
                model: null,
                createdAt: "2026-09-01T10:00:00.000Z",
                updatedAt: "2026-09-01T10:01:00.000Z",
                messages: [
                  {
                    role: "user" as const,
                    text: "Existing prompt",
                    createdAt: "2026-09-01T10:00:00.000Z",
                  },
                ],
              },
            });
          },
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            options.existing || completed
              ? Effect.succeed({
                  thread: {
                    id: importedId,
                    projectId,
                    historyOrigin: "v1_import",
                    ...options.existing,
                  },
                } as never)
              : Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: importedId })),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.suspend(() => {
              order.push("publish");
              if (failWrite) {
                failWrite = false;
                return Effect.fail(
                  new EventSink.EventSinkWriteError({ eventCount: input.events.length }),
                );
              }
              writes.push(input.events);
              completed = true;
              return Effect.succeed([]);
            }),
        }),
        Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input, config) =>
            Effect.gen(function* () {
              expect(config?.onConflict).toBe("ignore");
              if (options.bindingStarted)
                yield* Deferred.succeed(options.bindingStarted, undefined);
              if (options.bindingGate) yield* Deferred.await(options.bindingGate);
              cursors.push(input.resumeCursor);
              order.push("binding");
            }),
          recordImportedTranscript: () => Effect.void,
        }),
        IdAllocator.layer,
      ),
    ),
  );
  return { layer, scannedRoots, writes, cursors, order, importedId };
}

it.effect.each(["codex", "claudeAgent"] as const)(
  "keeps the %s resume cursor and uses the project root",
  (source) => {
    const nativeId = source === "codex" ? "codex-session" : "550e8400-e29b-41d4-a716-446655440000";
    const h = importHarness({ source, nativeId });
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(
        yield* importer.importRecentAgentThreads({
          projectId,
          expectedWorkspaceRoot: "/workspace/project",
        }),
      ).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(h.scannedRoots).toEqual(["/workspace/project"]);
      expect(h.cursors).toEqual([
        source === "codex" ? { threadId: nativeId } : { threadId: h.importedId, resume: nativeId },
      ]);
      expect(h.order).toEqual(["binding", "publish"]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("rejects a moved project before scanning or writing", () => {
  const h = importHarness();
  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter.AgentSessionImporter;
    const error = yield* importer
      .importRecentAgentThreads({ projectId, expectedWorkspaceRoot: "/old/root" })
      .pipe(Effect.flip);
    expect(error._tag).toBe("AgentSessionImportProjectChangedError");
    expect(h.scannedRoots).toEqual([]);
    expect(h.order).toEqual([]);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([
  { source: "claudeAgent" as const, nativeId: "not-a-uuid" },
  { existing: { projectId: ProjectId.make("other-project"), historyOrigin: "v1_import" as const } },
  { existing: { projectId, historyOrigin: "native" as const } },
])(
  "skips malformed sessions, project collisions, and native work without changing bindings",
  (options) => {
    const h = importHarness(options);
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 0,
        skippedCount: 1,
      });
      expect(h.order).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect(
  "retries failed event publication without overwriting a resume binding, then leaves imported history alone",
  () => {
    const h = importHarness({ failWriteOnce: true });
    return Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 0,
        skippedCount: 1,
      });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      expect(h.writes).toHaveLength(1);
      expect(h.cursors).toHaveLength(2);
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("cannot expose the imported thread before its native resume binding is durable", () =>
  Effect.gen(function* () {
    const bindingGate = yield* Deferred.make<void>();
    const bindingStarted = yield* Deferred.make<void>();
    const h = importHarness({ bindingGate, bindingStarted });
    yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const pending = yield* importer
        .importRecentAgentThreads({ projectId })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(bindingStarted);
      expect(h.writes).toEqual([]);
      yield* Deferred.succeed(bindingGate, undefined);
      yield* Fiber.join(pending);
      expect(h.order).toEqual(["binding", "publish"]);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);
