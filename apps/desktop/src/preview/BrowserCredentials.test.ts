import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as BrowserCredentials from "./BrowserCredentials.ts";

const files = new Map<string, string>();
const ENV_A = "env_a";
const ENV_B = "env_b";

const fileSystemLayer = Layer.succeed(
  FileSystem.FileSystem,
  FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => Effect.succeed(files.get(path) ?? ""),
    writeFileString: (path, data) =>
      Effect.sync(() => {
        files.set(path, data);
      }),
  }),
);

const environmentLayer = Layer.mock(DesktopEnvironment.DesktopEnvironment)({
  stateDir: "/state",
} as never);

/** Reversible fake "encryption" so tests can assert plaintext never rests on disk. */
const safeStorageLayer = (encryptionAvailable: boolean, backend: string | null = null) =>
  Layer.mock(ElectronSafeStorage.ElectronSafeStorage)({
    isEncryptionAvailable: Effect.succeed(encryptionAvailable),
    encryptString: (value) => Effect.succeed(new TextEncoder().encode(`enc:${value}`)),
    decryptString: (value) => Effect.succeed(new TextDecoder().decode(value).replace(/^enc:/, "")),
    selectedStorageBackend: Effect.succeed(backend === null ? Option.none() : Option.some(backend)),
  });

const layerWith = (encryptionAvailable: boolean, backend: string | null = null) =>
  BrowserCredentials.layer.pipe(
    Layer.provideMerge(fileSystemLayer),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(safeStorageLayer(encryptionAvailable, backend)),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(NodeServices.layer),
  );

describe("normalizeCredentialOrigin", () => {
  it("binds to the exact lowercased origin and rejects non-http(s)", () => {
    assert.strictEqual(
      BrowserCredentials.normalizeCredentialOrigin("https://GitHub.com/login?a=1"),
      "https://github.com",
    );
    assert.strictEqual(
      BrowserCredentials.normalizeCredentialOrigin("http://localhost:5173/admin"),
      "http://localhost:5173",
    );
    assert.strictEqual(BrowserCredentials.normalizeCredentialOrigin("http://example.com"), null);
    assert.strictEqual(
      BrowserCredentials.normalizeCredentialOrigin("github.com"),
      "https://github.com",
    );
    assert.strictEqual(BrowserCredentials.normalizeCredentialOrigin("file:///etc/passwd"), null);
    assert.strictEqual(BrowserCredentials.normalizeCredentialOrigin("not a url"), null);
  });
});

describe("BrowserCredentials", () => {
  it.effect("saves, lists without passwords, and resolves only on exact origin + profile", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;

      yield* store.save({
        environmentId: ENV_A,
        url: "https://github.com/login",
        profile: null,
        username: "hamish",
        password: "hunter2",
      });

      const listed = yield* store.list;
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.origin, "https://github.com");
      assert.isFalse(Object.values(listed[0] ?? {}).some((value) => value === "hunter2"));
      // The password must never rest on disk in plaintext.
      assert.isFalse([...files.values()].some((raw) => raw.includes("hunter2")));

      const hit = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://github.com",
        profile: null,
      });
      assert.deepStrictEqual(hit, { username: "hamish", password: "hunter2" });

      // A different origin or profile is a refusal, never a fallback.
      const wrongOrigin = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://evil.example",
        profile: null,
      });
      assert.deepStrictEqual(wrongOrigin, { reason: "no-credential" });
      const wrongProfile = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://github.com",
        profile: "work",
      });
      assert.deepStrictEqual(wrongProfile, { reason: "no-credential" });
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("isolates managed profiles from shared and identically named legacy profiles", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;
      const base = { environmentId: ENV_A, url: "https://github.com", username: "hamish" };
      yield* store.save({ ...base, profile: null, password: "shared" });
      yield* store.save({ ...base, profile: "work", password: "legacy" });
      yield* store.save({ ...base, profile: null, profileId: "work", password: "managed" });
      const fill = { environmentId: ENV_A, origin: base.url };
      assert.deepStrictEqual(yield* store.resolveForFill({ ...fill, profile: null }), {
        username: "hamish",
        password: "shared",
      });
      assert.deepStrictEqual(yield* store.resolveForFill({ ...fill, profile: "work" }), {
        username: "hamish",
        password: "legacy",
      });
      assert.deepStrictEqual(
        yield* store.resolveForFill({ ...fill, profile: null, profileId: "work" }),
        { username: "hamish", password: "managed" },
      );
      assert.deepStrictEqual(
        yield* store.resolveForFill({ ...fill, profile: null, profileId: "other" }),
        { reason: "no-credential" },
      );
      assert.strictEqual((yield* store.list).length, 3);
      assert.include(files.get("/state/browser-credentials.json") ?? "", '\"version\":3');
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("reads version 2 logins without making them available to managed profiles", () =>
    Effect.gen(function* () {
      files.clear();
      files.set(
        "/state/browser-credentials.json",
        // @effect-diagnostics-next-line preferSchemaOverJson:off - fixture for the previous persisted document format.
        JSON.stringify({
          version: 2,
          credentials: [
            {
              id: "v2",
              environmentId: ENV_A,
              origin: "https://github.com",
              profile: null,
              username: "hamish",
              encryptedPassword: "ZW5jOnNlY3JldA==",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      );
      const store = yield* BrowserCredentials.BrowserCredentials;
      const input = { environmentId: ENV_A, origin: "https://github.com", profile: null };
      assert.deepStrictEqual(yield* store.resolveForFill(input), {
        username: "hamish",
        password: "secret",
      });
      assert.deepStrictEqual(yield* store.resolveForFill({ ...input, profileId: "work" }), {
        reason: "no-credential",
      });
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("requires a username to pick between several logins for one origin", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;
      yield* store.save({
        environmentId: ENV_A,
        url: "https://github.com",
        profile: null,
        username: "personal",
        password: "a",
      });
      yield* store.save({
        environmentId: ENV_A,
        url: "https://github.com",
        profile: null,
        username: "work",
        password: "b",
      });

      const ambiguous = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://github.com",
        profile: null,
      });
      assert.deepStrictEqual(ambiguous, { reason: "ambiguous-credential" });

      const picked = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://github.com",
        profile: null,
        username: "work",
      });
      assert.deepStrictEqual(picked, { username: "work", password: "b" });
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("isolates logins by environment", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;
      yield* store.save({
        environmentId: ENV_A,
        url: "https://github.com",
        profile: null,
        username: "hamish",
        password: "a",
      });

      const miss = yield* store.resolveForFill({
        environmentId: ENV_B,
        origin: "https://github.com",
        profile: null,
      });
      assert.deepStrictEqual(miss, { reason: "no-credential" });

      yield* store.save({
        environmentId: ENV_B,
        url: "https://github.com",
        profile: null,
        username: "hamish",
        password: "b",
      });
      assert.strictEqual((yield* store.list).length, 2);
      assert.deepStrictEqual(
        yield* store.resolveForFill({
          environmentId: ENV_B,
          origin: "https://github.com",
          profile: null,
        }),
        { username: "hamish", password: "b" },
      );
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("claims a version 1 login for the first environment that uses it", () =>
    Effect.gen(function* () {
      files.clear();
      files.set(
        "/state/browser-credentials.json",
        '{"version":1,"credentials":[{"id":"legacy","origin":"https://github.com","profile":null,"username":"hamish","encryptedPassword":"ZW5jOmxlZ2FjeS1wYXNzd29yZA==","updatedAt":"2026-08-31T00:00:00.000Z"}]}',
      );
      const store = yield* BrowserCredentials.BrowserCredentials;

      assert.deepStrictEqual(
        yield* store.resolveForFill({
          environmentId: ENV_A,
          origin: "https://github.com",
          profile: null,
        }),
        { username: "hamish", password: "legacy-password" },
      );
      assert.include(files.get("/state/browser-credentials.json") ?? "", '"version":3');
      assert.deepStrictEqual(
        yield* store.resolveForFill({
          environmentId: ENV_B,
          origin: "https://github.com",
          profile: null,
        }),
        { reason: "no-credential" },
      );
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("rotates the password in place for the same origin, profile, and username", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;
      yield* store.save({
        environmentId: ENV_A,
        url: "https://github.com",
        profile: null,
        username: "hamish",
        password: "old",
      });
      yield* store.save({
        environmentId: ENV_A,
        url: "https://github.com/login",
        profile: null,
        username: "hamish",
        password: "new",
      });

      assert.strictEqual((yield* store.list).length, 1);
      const resolved = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://github.com",
        profile: null,
      });
      assert.deepStrictEqual(resolved, { username: "hamish", password: "new" });
    }).pipe(Effect.provide(layerWith(true))),
  );

  it.effect("refuses to save and reports unavailable when the keychain is missing", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;
      const error = yield* store
        .save({
          environmentId: ENV_A,
          url: "https://github.com",
          profile: null,
          username: "u",
          password: "p",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "BrowserCredentialEncryptionUnavailableError");

      const resolved = yield* store.resolveForFill({
        environmentId: ENV_A,
        origin: "https://github.com",
        profile: null,
      });
      assert.deepStrictEqual(resolved, { reason: "unavailable" });
    }).pipe(Effect.provide(layerWith(false))),
  );

  it.effect("refuses Electron's plaintext Linux storage backend", () =>
    Effect.gen(function* () {
      files.clear();
      const store = yield* BrowserCredentials.BrowserCredentials;
      const error = yield* store
        .save({
          environmentId: ENV_A,
          url: "https://github.com",
          profile: null,
          username: "u",
          password: "p",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "BrowserCredentialEncryptionUnavailableError");
    }).pipe(Effect.provide(layerWith(true, "basic_text"))),
  );
});
