// @effect-diagnostics nodeBuiltinImport:off -- Node provides authenticated encryption for the vault.
import * as NodeCrypto from "node:crypto";
import {
  CredentialMetadata,
  SecretRequestError,
  type CredentialCaller,
  type CredentialRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as LinkedCredentialVault from "./LinkedCredentialVault.ts";

export const LoginValue = Schema.fromJsonString(
  Schema.Struct({ username: Schema.String, password: Schema.String }),
);
const StoredCredential = Schema.Struct({ ...CredentialMetadata.fields, value: Schema.String });
const StoredCredentials = Schema.fromJsonString(Schema.Array(StoredCredential));
const decode = Schema.decodeUnknownEffect(StoredCredentials);
const encode = Schema.encodeEffect(StoredCredentials);
const publicMetadata = ({ value: _value, ...metadata }: typeof StoredCredential.Type) => metadata;
const storageFailed = (cause: unknown) =>
  new SecretRequestError({ reason: "vault_storage_failed", cause });
const unreadable = (cause?: unknown) =>
  new SecretRequestError({ reason: "vault_unreadable", ...(cause === undefined ? {} : { cause }) });

/** A project grant covers that project and every project of the same repository, on any machine. */
const allowed = (entry: CredentialMetadata, caller: CredentialCaller) =>
  entry.scope === "environment" ||
  entry.projectId === caller.projectId ||
  (entry.repositoryKey !== undefined && entry.repositoryKey === caller.repositoryKey);

export interface CredentialVaultShape {
  readonly list: (
    caller?: CredentialCaller,
  ) => Effect.Effect<ReadonlyArray<CredentialMetadata>, SecretRequestError>;
  readonly save: (input: {
    request: CredentialRequest;
    caller: CredentialCaller;
    scope: "project" | "environment";
    value: string;
  }) => Effect.Effect<void, SecretRequestError>;
  readonly get: (
    request: CredentialRequest,
    caller: CredentialCaller,
  ) => Effect.Effect<Option.Option<string>, SecretRequestError>;
  readonly remove: (id: string) => Effect.Effect<void, SecretRequestError>;
}

export class CredentialVault extends Context.Service<
  CredentialVault,
  CredentialVaultShape & {
    /** This environment's own vault, which linked environments use through the link. */
    readonly local: CredentialVaultShape;
  }
>()("t3/secrets/CredentialVault") {}

const makeLocal = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const read = Effect.gen(function* () {
    const bytes = yield* store.get("credential-vault").pipe(Effect.mapError(storageFailed));
    if (Option.isNone(bytes)) return [];
    const key = yield* store.get("credential-vault-key").pipe(Effect.mapError(storageFailed));
    if (Option.isNone(key)) return yield* unreadable();
    const json = yield* Effect.try({
      try: () => {
        const buffer = Buffer.from(bytes.value);
        const decipher = NodeCrypto.createDecipheriv(
          "aes-256-gcm",
          key.value,
          buffer.subarray(0, 12),
        );
        decipher.setAuthTag(buffer.subarray(12, 28));
        return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString(
          "utf8",
        );
      },
      catch: unreadable,
    });
    return yield* decode(json).pipe(Effect.mapError(unreadable));
  });
  const write = Effect.fn("CredentialVault.write")(function* (
    entries: ReadonlyArray<typeof StoredCredential.Type>,
  ) {
    const key = yield* store
      .getOrCreateRandom("credential-vault-key", 32)
      .pipe(Effect.mapError(storageFailed));
    const json = yield* encode(entries).pipe(Effect.mapError(storageFailed));
    const encrypted = yield* Effect.try({
      try: () => {
        const nonce = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
        const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), data]);
      },
      catch: storageFailed,
    });
    yield* store.set("credential-vault", encrypted).pipe(Effect.mapError(storageFailed));
  });
  const local: CredentialVaultShape = {
    list: Effect.fn("CredentialVault.list")(function* (caller) {
      return (yield* read)
        .filter((entry) => caller === undefined || allowed(entry, caller))
        .map(publicMetadata);
    }),
    get: Effect.fn("CredentialVault.get")(function* (request, caller) {
      const entries = (yield* read).filter(
        (entry) =>
          allowed(entry, caller) &&
          entry.name === request.name &&
          entry.kind === request.kind &&
          entry.website === request.website,
      );
      return Option.fromNullishOr(
        entries.find((entry) => entry.scope === "project")?.value ?? entries[0]?.value,
      );
    }),
    save: Effect.fn("CredentialVault.save")(function* (input) {
      yield* Effect.gen(function* () {
        const entries = yield* read;
        const id = NodeCrypto.createHash("sha256")
          .update(
            `${input.scope}\0${input.scope === "project" ? input.caller.projectId : ""}\0${input.request.name}`,
          )
          .digest("hex");
        const next = {
          id,
          name: input.request.name,
          kind: input.request.kind,
          ...(input.request.website === undefined ? {} : { website: input.request.website }),
          scope: input.scope,
          projectId: input.caller.projectId,
          ...(input.scope === "project" && input.caller.repositoryKey !== undefined
            ? { repositoryKey: input.caller.repositoryKey }
            : {}),
          updatedAt: yield* Clock.currentTimeMillis,
          value: input.value,
        };
        yield* write([...entries.filter((entry) => entry.id !== id), next]);
      }).pipe(lock.withPermits(1));
    }),
    remove: Effect.fn("CredentialVault.remove")(function* (id) {
      yield* Effect.gen(function* () {
        yield* write((yield* read).filter((entry) => entry.id !== id));
      }).pipe(lock.withPermits(1));
    }),
  };
  return local;
});

const make = Effect.gen(function* () {
  const local = yield* makeLocal;
  // Absent in standalone and test runtimes, which keep their own vault.
  const linked = yield* Effect.serviceOption(LinkedCredentialVault.LinkedCredentialVault);
  const route = <A>(
    here: Effect.Effect<A, SecretRequestError>,
    there: (
      linked: LinkedCredentialVault.LinkedCredentialVault["Service"],
      host: EnvironmentId,
    ) => Effect.Effect<A, SecretRequestError>,
  ) =>
    Option.isNone(linked)
      ? here
      : linked.value.host.pipe(
          Effect.flatMap((host) => (Option.isNone(host) ? here : there(linked.value, host.value))),
        );
  return CredentialVault.of({
    local,
    list: Effect.fn("CredentialVault.shared.list")(function* (caller) {
      return yield* route(local.list(caller), (vault, host) =>
        vault
          .call(host, { op: "list", ...(caller === undefined ? {} : { caller }) })
          .pipe(Effect.map((result) => result.credentials ?? [])),
      );
    }),
    get: Effect.fn("CredentialVault.shared.get")(function* (credential, caller) {
      return yield* route(local.get(credential, caller), (vault, host) =>
        vault
          .call(host, { op: "get", credential, caller })
          .pipe(Effect.map((result) => Option.fromUndefinedOr(result.value))),
      );
    }),
    save: Effect.fn("CredentialVault.shared.save")(function* (input) {
      yield* route(local.save(input), (vault, host) =>
        vault
          .call(host, {
            op: "save",
            credential: input.request,
            caller: input.caller,
            scope: input.scope,
            value: input.value,
          })
          .pipe(Effect.asVoid),
      );
    }),
    remove: Effect.fn("CredentialVault.shared.remove")(function* (id) {
      yield* route(local.remove(id), (vault, host) =>
        vault.call(host, { op: "remove", id }).pipe(Effect.asVoid),
      );
    }),
  });
});
export const layer = Layer.effect(CredentialVault, make);
