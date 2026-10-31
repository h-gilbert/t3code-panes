import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  EnvironmentId,
  ProjectId,
  type CredentialRequest,
  type OrchestrationV2ServerCommand,
  SecretRef,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as LinkedCredentialVault from "./LinkedCredentialVault.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");

interface ServiceOptions {
  readonly credential?: CredentialRequest;
  readonly threadId?: ThreadId;
  readonly delivery?: "file";
  readonly directory?: string;
  readonly runStatus?: string;
  readonly removeFails?: boolean;
  readonly closedFirst?: boolean;
  readonly failedRecords?: number;
  readonly projectId?: ProjectId;
  /** Repository keys of projects, as their checkouts' Git remotes resolve. */
  readonly repositories?: Readonly<Record<string, string>>;
  /** The vault service of a linked browser host this environment shares. */
  readonly linkedHost?: SecretRequests.SecretRequests["Service"];
}

const buildService = (options: ServiceOptions = {}) =>
  Effect.gen(function* () {
    const threadProjectId = options.projectId ?? projectId;
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          ...(options.directory === undefined ? {} : { directory: options.directory }),
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId: threadProjectId },
            runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
                secretStatus,
                ...(options.credential === undefined ? {} : { credential: options.credential }),
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    const layerProjects = Layer.mergeAll(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: (id) => Effect.succeedSome({ workspaceRoot: `/work/${id}` } as never),
      }),
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        readRepositoryIdentity: (root) => {
          const key = options.repositories?.[root.slice("/work/".length)];
          return Effect.succeed(key === undefined ? null : ({ canonicalKey: key } as never));
        },
      }),
    );
    const host = options.linkedHost;
    const layerLinked =
      host === undefined
        ? Layer.empty
        : Layer.succeed(
            LinkedCredentialVault.LinkedCredentialVault,
            LinkedCredentialVault.LinkedCredentialVault.of({
              host: Effect.succeedSome(EnvironmentId.make("environment-mac")),
              call: (_environmentId, input) => host.peerVault(input),
            }),
          );
    const context = yield* Layer.build(
      SecretRequests.layer.pipe(
        Layer.provide(Layer.mergeAll(layerDependencies, layerProjects, layerLinked)),
      ),
    );
    const service = Context.get(context, SecretRequests.SecretRequests);
    return { service, stored, dispatched };
  });

const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: ServiceOptions = {},
) => Effect.scoped(Effect.flatMap(buildService(options), body));

const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect("a saved answer becomes a one-use ref, and the thread only learns it was saved", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      assert.equal(dispatched.length, 1);
      assert.include(dispatched[0] as object, {
        type: "secret_request.record",
        secretStatus: "saved",
      });
      assert.notInclude(Object.values(dispatched[0] as object).map(String), "ghp_secret");

      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      const again = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
      assert.include(again.message, "already used");
    }),
  ),
);

it.effect("two concurrent uses of one ref hand the value out once", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const results = yield* Effect.forEach(
        [service.consume({ ref, projectId }), service.consume({ ref, projectId })],
        Effect.result,
        { concurrency: "unbounded" },
      );
      assert.deepEqual(results.map((result) => result._tag).toSorted(), ["Failure", "Success"]);
    }),
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a ref only works in the project it was entered for", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      const elsewhere = yield* service
        .consume({ ref, projectId: ProjectId.make("project-other") })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "does not exist");
      assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
    }),
  ),
);

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_consumed_total" &&
            snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.consume({ ref, projectId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.consume");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.consume({ ref, projectId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect("refuses an answer once the agent that asked has stopped", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const late = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.include(late.message, "has stopped");
        assert.deepEqual(valuesOf(stored), []);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);

it.effect("a used value that cannot be deleted is not handed out", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        const failed = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
        assert.include(failed.message, "Could not use");
      }),
    { removeFails: true },
  ),
);

const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

it.effect("a file request moves its value to an owner-only file, once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    const file = yield* withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token'$(id)" },
          });
          assert.include(dispatched[0] as object, { secretStatus: "saved", delivery: "file" });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "cf_token'$(id)");
          assert.deepEqual(valuesOf(stored), []);
          if ((yield* HostProcess.Platform) !== "win32") {
            assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
            assert.equal((yield* fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          }
          // A retried request_secret gets the same file; the value is never a ref again.
          assert.equal(yield* service.saveToFile({ threadId, turnItemId }), file);
          const ref = SecretRef.make(`secret-ref:${path.basename(file)}`);
          const reused = yield* service.consume({ ref, projectId }).pipe(Effect.flip);
          assert.equal(reused.reason, "ref_unavailable");
          return file;
        }),
      { delivery: "file", directory },
    );

    const { mtime } = yield* fs.stat(file);
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS);
    yield* withService(() => Effect.void, { directory });
    assert.isTrue(yield* fs.exists(file));
    yield* TestClock.setTime(Option.getOrThrow(mtime).getTime() + SECRET_FILE_TTL_MS + 1);
    yield* withService(() => Effect.void, { directory });
    assert.isFalse(yield* fs.exists(file));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failed file write keeps the value, so the request can retry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          const name = ref.slice("secret-ref:".length);
          // A non-empty directory where the partial file goes makes the write fail.
          const partial = path.join(directory, "files", `${name}.partial`);
          yield* fs.makeDirectory(path.join(partial, "block"), { recursive: true });
          const failed = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(failed.reason, "store_failed");
          yield* fs.remove(partial, { recursive: true });
          const file = yield* service.saveToFile({ threadId, turnItemId });
          assert.equal(yield* fs.readFileString(file), "cf_token");
        }),
      { delivery: "file", directory },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a file is not delivered while its stored copy cannot be removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "secret-files-test-" });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "cf_token" },
          });
          const first = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(first.reason, "consume_failed");
          // A retry finds the file but still will not hand it out until the removal works.
          const retried = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
          assert.equal(retried.reason, "consume_failed");
        }),
      { delivery: "file", directory, removeFails: true },
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a secret the card promised to keep from the agent is never written to a file", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const refused = yield* service.saveToFile({ threadId, turnItemId }).pipe(Effect.flip);
      assert.equal(refused.reason, "not_a_file_request");
      assert.isTrue(valuesOf(stored).some((value) => value.includes("ghp_secret")));
    }),
  ),
);

it.effect(
  "named logins persist encrypted, preserve passwords, and only issue fresh project-bound references",
  () =>
    withService(
      ({ service, stored, dispatched }) =>
        Effect.gen(function* () {
          const credential = {
            name: "Example login",
            kind: "login" as const,
            website: "https://example.com",
          };
          yield* service.answer({
            threadId,
            turnItemId,
            answer: {
              type: "save",
              secret: " password with spaces ",
              username: "user@example.com",
            },
          });
          const original = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
          assert.isFalse(
            [...stored.values()].some((bytes) =>
              new TextDecoder().decode(bytes).includes("password with spaces"),
            ),
          );
          const login = JSON.parse(yield* service.consume({ ref: original, projectId }));
          assert.equal(login.password, " password with spaces ");
          assert.equal(login.username, "user@example.com");
          assert.deepEqual(yield* service.browserCredential({ threadId, name: credential.name }), {
            ...login,
            origin: "https://example.com",
          });
          assert.notInclude(
            new TextDecoder().decode(stored.get("credential-vault")),
            "password with spaces",
          );
          assert.notInclude(JSON.stringify(dispatched), "user@example.com");
          assert.notInclude(
            JSON.stringify(yield* service.listCredentials()),
            "password with spaces",
          );
          assert.lengthOf(yield* service.listCredentials(ProjectId.make("other-project")), 0);
          assert.isTrue(
            Option.isNone(
              yield* service.reuseCredential({
                credential,
                projectId: ProjectId.make("other-project"),
              }),
            ),
          );
          assert.isTrue(
            Option.isNone(
              yield* service.reuseCredential({
                credential: { ...credential, website: "https://other.example" },
                projectId,
              }),
            ),
          );
          yield* TestClock.adjust("25 hours");
          const reused = Option.getOrThrow(
            yield* service.reuseCredential({ credential, projectId }),
          );
          assert.isTrue("secretRef" in reused);
          if (!("secretRef" in reused)) return;
          assert.notEqual(reused.secretRef, original);
          assert.deepEqual(
            JSON.parse(yield* service.consume({ ref: reused.secretRef, projectId })),
            login,
          );
          assert.equal(
            (yield* service.consume({ ref: reused.secretRef, projectId }).pipe(Effect.flip)).reason,
            "ref_unavailable",
          );
          const [metadata] = yield* service.listCredentials();
          const pending = Option.getOrThrow(
            yield* service.reuseCredential({ credential, projectId }),
          );
          yield* service.removeCredential(metadata!.id);
          if ("secretRef" in pending)
            assert.equal(
              (yield* service.consume({ ref: pending.secretRef, projectId }).pipe(Effect.flip))
                .reason,
              "ref_unavailable",
            );
          assert.isTrue(Option.isNone(yield* service.reuseCredential({ credential, projectId })));
        }),
      { credential: { name: "Example login", kind: "login", website: "https://example.com" } },
    ),
);

it.effect(
  "only the private answer can grant reuse across projects; corrupted vaults fail closed",
  () =>
    withService(
      ({ service, stored }) =>
        Effect.gen(function* () {
          const credential = { name: "Example token", kind: "secret" as const };
          yield* service.answer({
            threadId,
            turnItemId,
            answer: { type: "save", secret: "token-value", scope: "environment" },
          });
          const anotherProject = ProjectId.make("other-project");
          const reused = Option.getOrThrow(
            yield* service.reuseCredential({ credential, projectId: anotherProject }),
          );
          if (!("secretRef" in reused)) return;
          assert.equal(
            yield* service.consume({ ref: reused.secretRef, projectId: anotherProject }),
            "token-value",
          );
          const vault = stored.get("credential-vault")!;
          vault[vault.length - 1] = vault[vault.length - 1]! ^ 1;
          assert.equal(
            (yield* service.listCredentials().pipe(Effect.flip)).reason,
            "vault_unreadable",
          );
          assert.equal(
            (yield* service.reuseCredential({ credential, projectId }).pipe(Effect.flip)).reason,
            "vault_unreadable",
          );
        }),
      { credential: { name: "Example token", kind: "secret" } },
    ),
);

it.effect("a browser login resolves to its website's origin, and failures say what is wrong", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "dummy-password", username: "dummy@example.com" },
        });
        // Apple frames this sign-in form inside appstoreconnect.apple.com; the browser host matches frames.
        assert.deepEqual(yield* service.browserCredential({ threadId, name: "Apple ID" }), {
          username: "dummy@example.com",
          password: "dummy-password",
          origin: "https://idmsa.apple.com",
        });
        const missing = yield* service
          .browserCredential({ threadId, name: "Unknown" })
          .pipe(Effect.flip);
        assert.equal(missing.reason, "credential_not_found");
        assert.notInclude(missing.message, "vault");
      }),
    {
      credential: {
        name: "Apple ID",
        kind: "login",
        website: "https://idmsa.apple.com/appleauth/auth/signin",
      },
    },
  ),
);

it.effect("a login saved without a website cannot be autofilled, and says so", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "dummy-password", username: "dummy@example.com" },
        });
        const error = yield* service
          .browserCredential({ threadId, name: "No site" })
          .pipe(Effect.flip);
        assert.equal(error.reason, "credential_no_website");
      }),
    { credential: { name: "No site", kind: "login" } },
  ),
);

it.effect("a project grant covers projects of the same repository, and only those", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const credential = { name: "Deploy token", kind: "secret" as const };
        yield* service.answer({ threadId, turnItemId, answer: { type: "save", secret: "dummy" } });
        const sameRepository = ProjectId.make("project-same-repo");
        const reused = Option.getOrThrow(
          yield* service.reuseCredential({ credential, projectId: sameRepository }),
        );
        assert.isTrue("secretRef" in reused);
        if ("secretRef" in reused)
          assert.equal(
            yield* service.consume({ ref: reused.secretRef, projectId: sameRepository }),
            "dummy",
          );
        assert.isTrue(
          Option.isNone(
            yield* service.reuseCredential({
              credential,
              projectId: ProjectId.make("project-other-repo"),
            }),
          ),
        );
        assert.isTrue(
          Option.isNone(
            yield* service.reuseCredential({
              credential,
              projectId: ProjectId.make("project-no-remote"),
            }),
          ),
        );
      }),
    {
      credential: { name: "Deploy token", kind: "secret" },
      repositories: {
        [projectId]: "github.com/acme/app",
        "project-same-repo": "github.com/acme/app",
        "project-other-repo": "github.com/acme/other",
      },
    },
  ),
);

it.effect(
  "an environment whose browser host is linked saves to, lists, reuses and autofills from the host's vault",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "linked-vault-test-" });
        const credential = {
          name: "Dummy site",
          kind: "login" as const,
          website: "https://login.example.com",
        };
        const repositories = {
          "project-mac": "github.com/acme/app",
          "project-fred": "github.com/acme/app",
        };
        const mac = yield* buildService({
          projectId: ProjectId.make("project-mac"),
          repositories,
          credential,
        });
        const fredProject = ProjectId.make("project-fred");
        const fred = yield* buildService({
          projectId: fredProject,
          repositories,
          credential,
          directory,
          linkedHost: mac.service,
        });

        // A private card on the linked machine saves into the host's vault, and only there.
        yield* fred.service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "dummy-password", username: "dummy@example.com" },
        });
        assert.isFalse(fred.stored.has("credential-vault"));
        assert.isTrue(mac.stored.has("credential-vault"));
        assert.notInclude(
          new TextDecoder().decode(mac.stored.get("credential-vault")),
          "dummy-password",
        );
        const [onMac] = yield* mac.service.listCredentials(ProjectId.make("project-mac"));
        assert.equal(onMac?.repositoryKey, "github.com/acme/app");

        assert.deepEqual(
          (yield* fred.service.listCredentials(fredProject)).map((entry) => entry.name),
          ["Dummy site"],
        );
        const ref = Option.getOrThrow(
          yield* fred.service.reuseCredential({ credential, projectId: fredProject }),
        );
        if ("secretRef" in ref)
          assert.equal(
            JSON.parse(yield* fred.service.consume({ ref: ref.secretRef, projectId: fredProject }))
              .password,
            "dummy-password",
          );
        const file = Option.getOrThrow(
          yield* fred.service.reuseCredential({
            credential,
            projectId: fredProject,
            delivery: "file",
          }),
        );
        if ("file" in file) {
          assert.isTrue(file.file.startsWith(directory));
          assert.include(yield* fs.readFileString(file.file), "dummy-password");
        }
        assert.deepEqual(yield* fred.service.browserCredential({ threadId, name: "Dummy site" }), {
          username: "dummy@example.com",
          password: "dummy-password",
          origin: "https://login.example.com",
        });

        // Revoking on the host revokes it everywhere.
        yield* mac.service.removeCredential(onMac!.id);
        assert.lengthOf(yield* fred.service.listCredentials(fredProject), 0);
        assert.equal(
          (yield* fred.service
            .browserCredential({ threadId, name: "Dummy site" })
            .pipe(Effect.flip)).reason,
          "credential_not_found",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
