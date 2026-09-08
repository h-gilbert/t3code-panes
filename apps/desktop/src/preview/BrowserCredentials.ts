/**
 * Keychain-backed store for browser logins the collaborative browser can
 * autofill.
 *
 * Passwords are encrypted with Electron `safeStorage` (macOS Keychain /
 * DPAPI / libsecret) and persisted next to the other desktop state. They are
 * decrypted only inside the main process at fill time and typed directly
 * into the guest page — list results never include them, and neither the
 * renderer nor an agent can read one back through this service.
 *
 * Every login is bound to an environment, an exact origin
 * (scheme://host[:port]), and a browser profile (null = the shared profile).
 * Fill callers must present all three; a mismatch is a refusal, not a
 * fallback, so an unrelated environment or site cannot borrow a login.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { DesktopBrowserCredentialSummary } from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const CREDENTIALS_FILE_NAME = "browser-credentials.json";

const StoredCredential = Schema.Struct({
  id: Schema.String,
  /** Null only while an entry from version 1 waits to be claimed by an environment. */
  environmentId: Schema.NullOr(Schema.String),
  origin: Schema.String,
  profile: Schema.NullOr(Schema.String),
  profileId: Schema.optional(Schema.String),
  username: Schema.String,
  /** Base64 of the safeStorage ciphertext. */
  encryptedPassword: Schema.String,
  updatedAt: Schema.String,
});
type StoredCredential = typeof StoredCredential.Type;

const CredentialsDocumentV1 = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      origin: Schema.String,
      profile: Schema.NullOr(Schema.String),
      username: Schema.String,
      encryptedPassword: Schema.String,
      updatedAt: Schema.String,
    }),
  ),
});

const CredentialsDocumentV2 = Schema.Struct({
  version: Schema.Literal(2),
  credentials: Schema.Array(StoredCredential),
});

const CredentialsDocument = Schema.Struct({
  version: Schema.Literal(3),
  credentials: Schema.Array(StoredCredential),
});
type CredentialsDocument = typeof CredentialsDocument.Type;

const decodeDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([CredentialsDocumentV1, CredentialsDocumentV2, CredentialsDocument]),
  ),
);
const encodeDocument = Schema.encodeEffect(Schema.fromJsonString(CredentialsDocument));

export class BrowserCredentialStoreError extends Schema.TaggedErrorClass<BrowserCredentialStoreError>()(
  "BrowserCredentialStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser credential store operation failed: ${this.operation}.`;
  }
}

export class BrowserCredentialEncryptionUnavailableError extends Schema.TaggedErrorClass<BrowserCredentialEncryptionUnavailableError>()(
  "BrowserCredentialEncryptionUnavailableError",
  {},
) {
  override get message(): string {
    return "OS keychain encryption is unavailable, so browser logins cannot be stored or read.";
  }
}

export class BrowserCredentialInvalidOriginError extends Schema.TaggedErrorClass<BrowserCredentialInvalidOriginError>()(
  "BrowserCredentialInvalidOriginError",
  { url: Schema.String },
) {
  override get message(): string {
    return `Logins require an HTTPS URL or an HTTP loopback URL: ${this.url}`;
  }
}

export const BrowserCredentialsError = Schema.Union([
  BrowserCredentialStoreError,
  BrowserCredentialEncryptionUnavailableError,
  BrowserCredentialInvalidOriginError,
]);
export type BrowserCredentialsError = typeof BrowserCredentialsError.Type;

/** Exact-origin form a login is keyed and matched by. */
export const normalizeCredentialOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url.includes("://") ? url : `https://${url}`);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) return null;
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Select the login to fill for a live page. Exact environment + origin +
 * profile match only; `username` disambiguates several matching logins.
 */
export const selectCredentialForFill = (
  credentials: ReadonlyArray<StoredCredential>,
  input: {
    readonly origin: string;
    readonly environmentId: string;
    readonly profile: string | null;
    readonly profileId?: string | undefined;
    readonly username?: string | undefined;
  },
):
  | { readonly credential: StoredCredential }
  | { readonly reason: "no-credential" | "ambiguous-credential" } => {
  const exactMatches = credentials.filter(
    (credential) =>
      credential.environmentId === input.environmentId &&
      credential.origin === input.origin &&
      credential.profile === input.profile &&
      credential.profileId === input.profileId &&
      (input.username === undefined || credential.username === input.username),
  );
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : credentials.filter(
          (credential) =>
            credential.environmentId === null &&
            credential.origin === input.origin &&
            credential.profile === input.profile &&
            credential.profileId === input.profileId &&
            (input.username === undefined || credential.username === input.username),
        );
  if (matches.length === 0) return { reason: "no-credential" };
  if (matches.length > 1) return { reason: "ambiguous-credential" };
  return { credential: matches[0]! };
};

const toSummary = (credential: StoredCredential): DesktopBrowserCredentialSummary => ({
  id: credential.id,
  environmentId: credential.environmentId,
  origin: credential.origin,
  profile: credential.profile,
  ...(credential.profileId === undefined ? {} : { profileId: credential.profileId }),
  username: credential.username,
  updatedAt: credential.updatedAt,
});

export class BrowserCredentials extends Context.Service<
  BrowserCredentials,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<DesktopBrowserCredentialSummary>,
      BrowserCredentialStoreError
    >;
    readonly save: (input: {
      readonly environmentId: string;
      readonly url: string;
      readonly profile: string | null;
      readonly profileId?: string | undefined;
      readonly username: string;
      readonly password: string;
    }) => Effect.Effect<DesktopBrowserCredentialSummary, BrowserCredentialsError>;
    readonly delete: (id: string) => Effect.Effect<void, BrowserCredentialStoreError>;
    /**
     * Resolve the plaintext password for a fill. The only decrypting read;
     * callers must have already verified `origin` against the live page.
     */
    readonly resolveForFill: (input: {
      readonly origin: string;
      readonly environmentId: string;
      readonly profile: string | null;
      readonly profileId?: string | undefined;
      readonly username?: string | undefined;
    }) => Effect.Effect<
      | { readonly username: string; readonly password: string }
      | { readonly reason: "no-credential" | "ambiguous-credential" | "unavailable" },
      BrowserCredentialStoreError
    >;
  }
>()("@t3tools/desktop/preview/BrowserCredentials") {}

export const make = Effect.gen(function* BrowserCredentialsMake() {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const storePath = path.join(environment.stateDir, CREDENTIALS_FILE_NAME);
  // Serializes read-modify-write cycles so concurrent saves cannot drop
  // each other's entries.
  const writeLock = yield* SynchronizedRef.make<void>(undefined);

  const readDocument = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(storePath)
      .pipe(
        Effect.mapError((cause) => new BrowserCredentialStoreError({ operation: "stat", cause })),
      );
    if (!exists) return { version: 3, credentials: [] } as CredentialsDocument;
    const raw = yield* fileSystem
      .readFileString(storePath)
      .pipe(
        Effect.mapError((cause) => new BrowserCredentialStoreError({ operation: "read", cause })),
      );
    const decoded = yield* decodeDocument(raw).pipe(
      Effect.mapError((cause) => new BrowserCredentialStoreError({ operation: "decode", cause })),
    );
    return decoded.version !== 1
      ? { ...decoded, version: 3 as const }
      : {
          version: 3,
          credentials: decoded.credentials.map((credential) => ({
            ...credential,
            environmentId: null,
            profileId: undefined,
          })),
        };
  });

  const writeDocument = (document: CredentialsDocument) =>
    encodeDocument(document).pipe(
      Effect.mapError((cause) => new BrowserCredentialStoreError({ operation: "encode", cause })),
      Effect.flatMap((raw) =>
        fileSystem
          .writeFileString(storePath, raw)
          .pipe(
            Effect.mapError(
              (cause) => new BrowserCredentialStoreError({ operation: "write", cause }),
            ),
          ),
      ),
    );

  const encryptionAvailable = Effect.all([
    safeStorage.isEncryptionAvailable,
    safeStorage.selectedStorageBackend,
  ]).pipe(
    Effect.map(
      ([available, backend]) =>
        available && !(Option.isSome(backend) && backend.value === "basic_text"),
    ),
    Effect.mapError((cause) => new BrowserCredentialStoreError({ operation: "keychain", cause })),
  );

  const requireEncryption = encryptionAvailable.pipe(
    Effect.filterOrFail(
      (available): available is true => available,
      () => new BrowserCredentialEncryptionUnavailableError(),
    ),
  );

  return BrowserCredentials.of({
    list: readDocument.pipe(Effect.map((document) => document.credentials.map(toSummary))),

    save: Effect.fn("BrowserCredentials.save")(function* (input) {
      const origin = normalizeCredentialOrigin(input.url);
      if (origin === null) {
        return yield* new BrowserCredentialInvalidOriginError({ url: input.url });
      }
      yield* requireEncryption;
      const encryptedPassword = Encoding.encodeBase64(
        yield* safeStorage
          .encryptString(input.password)
          .pipe(
            Effect.mapError(
              (cause) => new BrowserCredentialStoreError({ operation: "encrypt", cause }),
            ),
          ),
      );
      const id = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replace(/-/g, "");
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* SynchronizedRef.modifyEffect(writeLock, () =>
        Effect.gen(function* () {
          const document = yield* readDocument;
          // One login per (environment, origin, profile, username): saving
          // again rotates the password in place. A matching version 1 entry
          // is claimed by this environment during the same write.
          const existing = document.credentials.find(
            (credential) =>
              (credential.environmentId === input.environmentId ||
                credential.environmentId === null) &&
              credential.origin === origin &&
              credential.profile === input.profile &&
              credential.profileId === input.profileId &&
              credential.username === input.username,
          );
          const entry: StoredCredential = {
            id: existing?.id ?? id,
            environmentId: input.environmentId,
            origin,
            profile: input.profile,
            ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
            username: input.username,
            encryptedPassword,
            updatedAt,
          };
          const credentials = existing
            ? document.credentials.map((credential) =>
                credential.id === existing.id ? entry : credential,
              )
            : [...document.credentials, entry];
          yield* writeDocument({ version: 3, credentials });
          return [toSummary(entry), undefined] as const;
        }),
      );
    }),

    delete: Effect.fn("BrowserCredentials.delete")(function* (id) {
      yield* SynchronizedRef.modifyEffect(writeLock, () =>
        Effect.gen(function* () {
          const document = yield* readDocument;
          const credentials = document.credentials.filter((credential) => credential.id !== id);
          if (credentials.length !== document.credentials.length) {
            yield* writeDocument({ version: 3, credentials });
          }
          return [undefined, undefined] as const;
        }),
      );
    }),

    resolveForFill: Effect.fn("BrowserCredentials.resolveForFill")(function* (input) {
      const available = yield* encryptionAvailable;
      if (!available) return { reason: "unavailable" } as const;
      const selected = yield* SynchronizedRef.modifyEffect(writeLock, () =>
        Effect.gen(function* () {
          const document = yield* readDocument;
          const selected = selectCredentialForFill(document.credentials, input);
          if ("reason" in selected || selected.credential.environmentId !== null) {
            return [selected, undefined] as const;
          }
          const claimed = {
            ...selected.credential,
            environmentId: input.environmentId,
          };
          yield* writeDocument({
            version: 3,
            credentials: document.credentials.map((credential) =>
              credential.id === claimed.id ? claimed : credential,
            ),
          });
          return [{ credential: claimed }, undefined] as const;
        }),
      );
      if ("reason" in selected) return selected;
      const encrypted = yield* Effect.fromResult(
        Encoding.decodeBase64(selected.credential.encryptedPassword),
      ).pipe(
        Effect.mapError(
          (cause) => new BrowserCredentialStoreError({ operation: "decode-password", cause }),
        ),
      );
      const password = yield* safeStorage
        .decryptString(encrypted)
        .pipe(
          Effect.mapError(
            (cause) => new BrowserCredentialStoreError({ operation: "decrypt", cause }),
          ),
        );
      return { username: selected.credential.username, password };
    }),
  });
}).pipe(Effect.withSpan("BrowserCredentials.make"));

export const layer = Layer.effect(BrowserCredentials, make);
