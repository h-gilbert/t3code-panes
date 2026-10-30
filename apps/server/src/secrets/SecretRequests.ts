// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file for the agent's own shell.
import { pipe } from "effect/Function";
import {
  CommandId,
  CredentialRequest,
  type CredentialMetadata,
  SecretRef,
  SecretRequestError,
  type ProjectId,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CredentialVault from "./CredentialVault.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

const StoredSecret = Schema.fromJsonString(
  Schema.Struct({
    projectId: Schema.String,
    value: Schema.optional(Schema.String),
    credential: Schema.optional(CredentialRequest),
    savedAt: Schema.Number,
  }),
);
const encodeLogin = Schema.encodeEffect(CredentialVault.LoginValue);
const decodeLogin = Schema.decodeEffect(CredentialVault.LoginValue);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly browserCredential: (input: {
      threadId: ThreadId;
      name: string;
      origin: string;
    }) => Effect.Effect<{ origin: string; username: string; password: string }, SecretRequestError>;
    readonly listCredentials: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<CredentialMetadata>, SecretRequestError>;
    readonly removeCredential: (id: string) => Effect.Effect<void, SecretRequestError>;
    readonly reuseCredential: (input: {
      credential: CredentialRequest;
      projectId: ProjectId;
      delivery?: "file";
    }) => Effect.Effect<
      Option.Option<{ status: "saved"; secretRef: SecretRef } | { status: "saved"; file: string }>,
      SecretRequestError
    >;
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const vault = yield* CredentialVault.CredentialVault;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  const answerLock = yield* Semaphore.make(1);
  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(function* (
    input,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "secret_request.answer": input.answer.type,
    });
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
      return yield* new SecretRequestError({ reason: "not_found" });
    }
    if (item.secretStatus !== "pending") {
      return yield* new SecretRequestError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
    const credentialValue =
      input.answer.type === "save" && item.credential?.kind === "login"
        ? input.answer.username === undefined
          ? undefined
          : yield* encodeLogin({
              username: input.answer.username,
              password: input.answer.secret,
            }).pipe(Effect.orDie)
        : input.answer.type === "save"
          ? input.answer.secret
          : undefined;
    if (input.answer.type === "save" && credentialValue === undefined)
      return yield* new SecretRequestError({ reason: "username_required" });
    // Create before recording so racing answers cannot overwrite values or show saved before storage.
    // Existing values on pending cards finish earlier saves whose recording failed.
    if (input.answer.type === "save") {
      if (item.credential !== undefined) {
        yield* vault.save({
          request: item.credential,
          projectId: records.thread.projectId,
          scope: input.answer.scope ?? "project",
          value: credentialValue ?? input.answer.secret,
        });
      }
      const encoded = yield* encodeStored({
        projectId: records.thread.projectId,
        ...(item.credential === undefined
          ? { value: input.answer.secret }
          : { credential: item.credential }),
        savedAt: yield* Clock.currentTimeMillis,
      }).pipe(Effect.orDie);
      yield* store
        .create(storeName(refFor(salt, input.threadId, item.id)), new TextEncoder().encode(encoded))
        .pipe(
          Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
          Effect.mapError(
            (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
          ),
        );
    }
    const secretStatus = input.answer.type === "save" ? "saved" : "declined";
    yield* threadManagement
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
        threadId: input.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        turnItemId: item.id,
        label: item.label,
        reason: item.reason,
        ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
        ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
        ...(item.credential === undefined ? {} : { credential: item.credential }),
        secretStatus,
      })
      .pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        // Clear failed saves so the pending card can be answered again.
        Effect.tapError(() =>
          input.answer.type === "save"
            ? pipe(refFor(salt, input.threadId, item.id), storeName, removeLogged)
            : Effect.void,
        ),
      );
    if (input.answer.type !== "save") return;
    // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
    const recorded = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })));
    const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
    if (card?.type === "secret_request" && card.secretStatus !== "saved") {
      yield* pipe(refFor(salt, input.threadId, item.id), storeName, removeLogged);
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
  }, answerLock.withPermits(1));

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  /** A live ref's value, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    if (decoded.value.credential !== undefined) {
      const value = yield* vault.get(decoded.value.credential, input.projectId);
      if (Option.isNone(value)) return yield* new SecretRequestError({ reason: "ref_unavailable" });
      return value.value;
    }
    if (decoded.value.value === undefined)
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    return decoded.value.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    const value = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return value;
  });

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = refFor(salt, input.threadId, item.id);
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    return yield* Effect.gen(function* () {
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const value = yield* readRef({ ref, projectId: records.thread.projectId });
      const partial = `${file}.partial`;
      yield* fileSystem.makeDirectory(filesDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fileSystem.chmod(filesDir, 0o700)),
        Effect.andThen(fileSystem.remove(partial, { force: true })),
        // `wx` never follows or replaces an existing path.
        Effect.andThen(
          fileSystem.writeFile(partial, new TextEncoder().encode(value), {
            flag: "wx",
            mode: 0o600,
          }),
        ),
        Effect.andThen(fileSystem.rename(partial, file)),
        Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
      );
      return yield* removeStored;
    }).pipe(consumeLock.withPermits(1));
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  const browserCredential: SecretRequests["Service"]["browserCredential"] = Effect.fn(
    "SecretRequests.browserCredential",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, [], { messageRoles: [] })
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "load_failed" })));
    const metadata = (yield* vault.list(records.thread.projectId)).find(
      (entry) =>
        entry.name === input.name &&
        entry.kind === "login" &&
        entry.website !== undefined &&
        URL.canParse(entry.website) &&
        new URL(entry.website).origin === input.origin,
    );
    if (metadata === undefined || !/^https?:\/\//.test(input.origin))
      return yield* new SecretRequestError({ reason: "credential_failed" });
    const stored = yield* vault.get(
      {
        name: metadata.name,
        kind: "login",
        ...(metadata.website === undefined ? {} : { website: metadata.website }),
      },
      records.thread.projectId,
    );
    if (Option.isNone(stored))
      return yield* new SecretRequestError({ reason: "credential_failed" });
    const login = yield* decodeLogin(stored.value).pipe(
      Effect.mapError(() => new SecretRequestError({ reason: "credential_failed" })),
    );
    return { ...login, origin: input.origin };
  });
  const reuseCredential: SecretRequests["Service"]["reuseCredential"] = Effect.fn(
    "SecretRequests.reuseCredential",
  )(function* (input) {
    const value = yield* vault.get(input.credential, input.projectId);
    if (Option.isNone(value)) return Option.none();
    const ref = SecretRef.make(`secret-ref:${NodeCrypto.randomBytes(16).toString("hex")}`);
    if (input.delivery === "file") {
      if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
      const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
      yield* fileSystem.makeDirectory(filesDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fileSystem.chmod(filesDir, 0o700)),
        Effect.andThen(
          fileSystem.writeFile(file, new TextEncoder().encode(value.value), {
            flag: "wx",
            mode: 0o600,
          }),
        ),
        Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })),
      );
      return Option.some({ status: "saved" as const, file });
    }
    const encoded = yield* encodeStored({
      projectId: input.projectId,
      credential: input.credential,
      savedAt: yield* Clock.currentTimeMillis,
    }).pipe(Effect.orDie);
    yield* store
      .create(storeName(ref), new TextEncoder().encode(encoded))
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
    return Option.some({ status: "saved" as const, secretRef: ref });
  });
  return SecretRequests.of({
    answer,
    savedRef,
    consume,
    saveToFile,
    reuseCredential,
    browserCredential,
    listCredentials: vault.list,
    removeCredential: vault.remove,
  });
});

export const layer = Layer.effect(SecretRequests, make).pipe(Layer.provide(CredentialVault.layer));
