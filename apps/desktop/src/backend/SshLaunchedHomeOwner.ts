import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeRuntimeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The lock owner, when it is a server an SSH client started here (packages/ssh tunnel.ts).
 * Those clients restart the home's server whenever it is unreachable, including while
 * this app quits to install an update, so the relaunched app finds the home taken.
 */
export const find = Effect.fn("desktop.sshLaunchedHomeOwner.find")(function* (input: {
  readonly baseDir: string;
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => text.trim()),
      Effect.option,
    );

  const runtime = yield* read(path.join(input.stateDir, "server-runtime.json"));
  const ownerPid = Option.flatMap(runtime, decodeRuntimeRecord).pipe(
    Option.map((record) => record.pid),
    Option.filter((pid) => pid > 1 && isAlive(pid)),
  );
  if (Option.isNone(ownerPid)) return Option.none<number>();

  const launchDir = path.join(input.baseDir, "ssh-launch");
  const entries = yield* fs.readDirectory(launchDir).pipe(Effect.orElseSucceed(() => []));
  for (const entry of entries) {
    const [pid, kind] = yield* Effect.all([
      read(path.join(launchDir, entry, "pid")),
      read(path.join(launchDir, entry, "managed")),
    ]);
    if (
      Option.getOrUndefined(kind) === "managed" &&
      Option.getOrUndefined(pid) === String(ownerPid.value)
    ) {
      return ownerPid;
    }
  }
  return Option.none<number>();
});

const terminate = (pid: number) => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone, or not ours to signal; the liveness check below decides.
  }
};

/** SIGTERM lets the server shut down cleanly; true once the process is gone. */
export const stop = Effect.fn("desktop.sshLaunchedHomeOwner.stop")(function* (pid: number) {
  terminate(pid);
  for (let waited = 0; waited < 150; waited++) {
    if (!isAlive(pid)) return true;
    yield* Effect.sleep(Duration.millis(100));
  }
  return !isAlive(pid);
});
