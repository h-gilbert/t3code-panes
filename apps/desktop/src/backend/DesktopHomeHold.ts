import { DESKTOP_HOME_HOLD_FILE } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const RESTART_HOLD = Duration.minutes(2);

const holdPath = Effect.fn("desktop.homeHold.path")(function* (baseDir: string) {
  const path = yield* Path.Path;
  const runtimeDir = path.join(baseDir, "runtime");
  return { runtimeDir, file: path.join(runtimeDir, DESKTOP_HOME_HOLD_FILE) };
});

const write = Effect.fn("desktop.homeHold.write")(function* (baseDir: string, until: number) {
  const fs = yield* FileSystem.FileSystem;
  const { runtimeDir, file } = yield* holdPath(baseDir);
  yield* fs.makeDirectory(runtimeDir, { recursive: true });
  yield* fs.writeFileString(file, `${process.pid} ${until}\n`);
});

// Best effort: a missing hold only reopens the race, so it must never fail startup or quit.
const bestEffort = Effect.ignoreCause({ log: "Warn", message: "desktop home hold failed" });

/**
 * Tells SSH launchers (packages/ssh tunnel.ts) that this app owns the home while it lives,
 * so a remote client reconnecting during startup or a takeover adopts the app's server
 * instead of winning the home lock first.
 */
export const hold = (baseDir: string) => write(baseDir, 0).pipe(bestEffort);

/** Outlives this process so the relaunched app can reclaim the home after an update. */
export const holdThroughRestart = (baseDir: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      write(baseDir, Math.ceil((now + Duration.toMillis(RESTART_HOLD)) / 1000)),
    ),
    bestEffort,
  );

/** A normal quit hands the home back to SSH clients; a restart hold is left to expire. */
export const release = Effect.fn("desktop.homeHold.release")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const { file } = yield* holdPath(baseDir);
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (text.trim() === `${process.pid} 0`) yield* fs.remove(file, { force: true });
}, bestEffort);
