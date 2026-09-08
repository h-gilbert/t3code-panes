import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

export interface DesktopWorkspaceWindowState {
  readonly workspaceId: string;
  readonly bounds: DesktopAppSettings.DesktopWindowBounds | null;
  readonly isMaximized: boolean;
}

const DesktopWorkspaceWindowDocument = Schema.Struct({
  workspaceId: Schema.String,
  bounds: Schema.NullOr(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  isMaximized: Schema.Boolean,
});

const DesktopWindowSessionDocument = Schema.Struct({
  windows: Schema.Array(DesktopWorkspaceWindowDocument),
});

const DesktopWindowSessionJson = fromLenientJson(DesktopWindowSessionDocument);
const decodeDesktopWindowSessionJson = Schema.decodeEffect(DesktopWindowSessionJson);
const encodeDesktopWindowSessionJson = Schema.encodeEffect(DesktopWindowSessionJson);

const DesktopWindowSessionWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-session-file",
]);
type DesktopWindowSessionWriteOperation = typeof DesktopWindowSessionWriteOperation.Type;

export class DesktopWindowSessionWriteError extends Schema.TaggedError<DesktopWindowSessionWriteError>()(
  "DesktopWindowSessionWriteError",
  {
    operation: DesktopWindowSessionWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop window session write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopWindowSession extends Context.Service<
  DesktopWindowSession,
  {
    readonly load: Effect.Effect<ReadonlyArray<DesktopWorkspaceWindowState>>;
    readonly get: Effect.Effect<ReadonlyArray<DesktopWorkspaceWindowState>>;
    readonly upsert: (
      window: DesktopWorkspaceWindowState,
    ) => Effect.Effect<void, DesktopWindowSessionWriteError>;
    readonly remove: (workspaceId: string) => Effect.Effect<void, DesktopWindowSessionWriteError>;
  }
>()("@t3tools/desktop/window/DesktopWindowSession") {}

function statesEqual(
  left: DesktopWorkspaceWindowState,
  right: DesktopWorkspaceWindowState,
): boolean {
  const boundsEqual =
    left.bounds === right.bounds ||
    (left.bounds !== null &&
      right.bounds !== null &&
      left.bounds.x === right.bounds.x &&
      left.bounds.y === right.bounds.y &&
      left.bounds.width === right.bounds.width &&
      left.bounds.height === right.bounds.height);
  return (
    left.workspaceId === right.workspaceId && left.isMaximized === right.isMaximized && boundsEqual
  );
}

function normalizeDocument(
  document: typeof DesktopWindowSessionDocument.Type,
): ReadonlyArray<DesktopWorkspaceWindowState> {
  const windows = new Map<string, DesktopWorkspaceWindowState>();
  for (const candidate of document.windows) {
    const workspaceId = candidate.workspaceId.trim();
    if (workspaceId.length === 0 || windows.has(workspaceId)) continue;
    const bounds = DesktopAppSettings.normalizeMainWindowBounds(candidate.bounds);
    windows.set(workspaceId, {
      workspaceId,
      bounds,
      isMaximized: bounds !== null && candidate.isMaximized,
    });
  }
  return [...windows.values()];
}

function readSession(
  fileSystem: FileSystem.FileSystem,
  sessionPath: string,
): Effect.Effect<ReadonlyArray<DesktopWorkspaceWindowState>> {
  return fileSystem.readFileString(sessionPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed([]),
        onSome: (raw) =>
          decodeDesktopWindowSessionJson(raw).pipe(
            Effect.map(normalizeDocument),
            Effect.orElseSucceed(() => []),
          ),
      }),
    ),
  );
}

const writeSession = Effect.fn("desktop.windowSession.write")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sessionPath: string;
  readonly windows: ReadonlyArray<DesktopWorkspaceWindowState>;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopWindowSessionWriteError> {
  const directory = input.path.dirname(input.sessionPath);
  const tempPath = `${input.sessionPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeDesktopWindowSessionJson({ windows: input.windows }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopWindowSessionWriteError({
          operation: "encode-document",
          path: input.sessionPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopWindowSessionWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopWindowSessionWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, input.sessionPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopWindowSessionWriteError({
          operation: "replace-session-file",
          path: input.sessionPath,
          cause,
        }),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sessionPath = path.join(environment.stateDir, "window-session.json");
  const windowsRef = yield* SynchronizedRef.make<ReadonlyArray<DesktopWorkspaceWindowState>>([]);

  const persist = (
    update: (
      windows: ReadonlyArray<DesktopWorkspaceWindowState>,
    ) => ReadonlyArray<DesktopWorkspaceWindowState>,
  ) =>
    SynchronizedRef.modifyEffect(windowsRef, (windows) => {
      const nextWindows = update(windows);
      if (nextWindows === windows) return Effect.succeed([undefined, windows] as const);
      return crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => uuid.replace(/-/g, "")),
        Effect.mapError(
          (cause) =>
            new DesktopWindowSessionWriteError({
              operation: "create-temporary-file-name",
              path: sessionPath,
              cause,
            }),
        ),
        Effect.flatMap((suffix) =>
          writeSession({ fileSystem, path, sessionPath, windows: nextWindows, suffix }),
        ),
        Effect.as([undefined, nextWindows] as const),
      );
    });

  return DesktopWindowSession.of({
    get: SynchronizedRef.get(windowsRef),
    load: readSession(fileSystem, sessionPath).pipe(
      Effect.flatMap((windows) => SynchronizedRef.setAndGet(windowsRef, windows)),
      Effect.withSpan("desktop.windowSession.load"),
    ),
    upsert: (window) =>
      persist((windows) => {
        const index = windows.findIndex(
          (candidate) => candidate.workspaceId === window.workspaceId,
        );
        if (index < 0) return [...windows, window];
        const current = windows[index]!;
        if (statesEqual(current, window)) return windows;
        const next = [...windows];
        next[index] = window;
        return next;
      }).pipe(Effect.withSpan("desktop.windowSession.upsert")),
    remove: (workspaceId) =>
      persist((windows) => {
        const next = windows.filter((window) => window.workspaceId !== workspaceId);
        return next.length === windows.length ? windows : next;
      }).pipe(Effect.withSpan("desktop.windowSession.remove")),
  });
});

export const layer = Layer.effect(DesktopWindowSession, make);

export const layerTest = (initialWindows: ReadonlyArray<DesktopWorkspaceWindowState> = []) =>
  Layer.effect(
    DesktopWindowSession,
    Effect.gen(function* () {
      const windowsRef = yield* SynchronizedRef.make(initialWindows);
      return DesktopWindowSession.of({
        get: SynchronizedRef.get(windowsRef),
        load: SynchronizedRef.get(windowsRef),
        upsert: (window) =>
          SynchronizedRef.update(windowsRef, (windows) => {
            const index = windows.findIndex(
              (candidate) => candidate.workspaceId === window.workspaceId,
            );
            if (index < 0) return [...windows, window];
            const next = [...windows];
            next[index] = window;
            return next;
          }),
        remove: (workspaceId) =>
          SynchronizedRef.update(windowsRef, (windows) =>
            windows.filter((window) => window.workspaceId !== workspaceId),
          ),
      });
    }),
  );
