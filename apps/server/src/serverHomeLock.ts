import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as Runtime from "effect/Runtime";
// @effect-diagnostics nodeBuiltinImport:off - SQLite supplies the cross-process OS lock.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isProcessAlive, readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

export class ServerHomeLockError extends Schema.TaggedError<ServerHomeLockError>()(
  "ServerHomeLockError",
  { stateDir: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;
  override get message(): string {
    return `Cannot start T3 in ${this.stateDir}: ${this.detail}`;
  }
}

/** Acquire before building any database, provider, or HTTP layers; release after they close. */
export const acquireServerHomeLock = Effect.fn("acquireServerHomeLock")(function* (input: {
  readonly stateDir: string;
  readonly serverRuntimeStatePath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(input.stateDir, { recursive: true });
  // A separate SQLite file holds an exclusive OS lock without locking the conversation
  // database. Crashes release it automatically. Never unlink this file: replacing its
  // inode would let another process acquire a different lock for the same home.
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(path.join(input.stateDir, "server-lock.sqlite"));
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
          return db;
        } catch (cause) {
          db.close();
          throw cause;
        }
      },
      catch: (cause) =>
        new ServerHomeLockError({
          stateDir: input.stateDir,
          detail:
            "Could not acquire exclusive access. Another server may already be using this home. Connect to it, or use a different --base-dir.",
          cause,
        }),
    }),
    (db) => Effect.sync(() => db.close()),
  );

  // Older installed servers do not hold the lock. Respect their discovery record
  // too, including when this process is the boot service.
  const existing = yield* readPersistedServerRuntimeState(input.serverRuntimeStatePath);
  if (Option.isSome(existing) && isProcessAlive(existing.value.pid)) {
    return yield* new ServerHomeLockError({
      stateDir: input.stateDir,
      detail: `Server PID ${existing.value.pid} already serves this home at ${existing.value.origin}. Connect to it, or stop it before restarting T3.`,
    });
  }
});
