// @effect-diagnostics nodeBuiltinImport:off -- Node provides authenticated encryption for the vault.
import * as NodeCrypto from "node:crypto";
import {
  CredentialMetadata,
  SecretRequestError,
  type CredentialRequest,
  type ProjectId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export const LoginValue = Schema.fromJsonString(
  Schema.Struct({ username: Schema.String, password: Schema.String }),
);
const StoredCredential = Schema.Struct({ ...CredentialMetadata.fields, value: Schema.String });
const StoredCredentials = Schema.fromJsonString(Schema.Array(StoredCredential));
const decode = Schema.decodeUnknownEffect(StoredCredentials);
const encode = Schema.encodeEffect(StoredCredentials);
const publicMetadata = ({ value: _value, ...metadata }: typeof StoredCredential.Type) => metadata;
const unavailable = () => new SecretRequestError({ reason: "credential_failed" });

export class CredentialVault extends Context.Service<
  CredentialVault,
  {
    readonly list: (
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<CredentialMetadata>, SecretRequestError>;
    readonly save: (input: {
      request: CredentialRequest;
      projectId: ProjectId;
      scope: "project" | "environment";
      value: string;
    }) => Effect.Effect<void, SecretRequestError>;
    readonly get: (
      request: CredentialRequest,
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<string>, SecretRequestError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretRequestError>;
  }
>()("t3/secrets/CredentialVault") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const read = Effect.gen(function* () {
    const bytes = yield* store.get("credential-vault").pipe(Effect.mapError(unavailable));
    if (Option.isNone(bytes)) return [];
    const key = yield* store.get("credential-vault-key").pipe(Effect.mapError(unavailable));
    if (Option.isNone(key)) return yield* unavailable();
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
      catch: unavailable,
    });
    return yield* decode(json).pipe(Effect.mapError(unavailable));
  });
  const write = Effect.fn("CredentialVault.write")(function* (
    entries: ReadonlyArray<typeof StoredCredential.Type>,
  ) {
    const key = yield* store
      .getOrCreateRandom("credential-vault-key", 32)
      .pipe(Effect.mapError(unavailable));
    const json = yield* encode(entries).pipe(Effect.mapError(unavailable));
    const encrypted = yield* Effect.try({
      try: () => {
        const nonce = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
        const data = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), data]);
      },
      catch: unavailable,
    });
    yield* store.set("credential-vault", encrypted).pipe(Effect.mapError(unavailable));
  });
  const allowed = (entry: CredentialMetadata, projectId: ProjectId) =>
    entry.scope === "environment" || entry.projectId === projectId;
  return CredentialVault.of({
    list: Effect.fn("CredentialVault.list")(function* (projectId) {
      return (yield* read)
        .filter((entry) => projectId === undefined || allowed(entry, projectId))
        .map(publicMetadata);
    }),
    get: Effect.fn("CredentialVault.get")(function* (request, projectId) {
      const entries = (yield* read).filter(
        (entry) =>
          allowed(entry, projectId) &&
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
            `${input.scope}\0${input.scope === "project" ? input.projectId : ""}\0${input.request.name}`,
          )
          .digest("hex");
        const next = {
          id,
          name: input.request.name,
          kind: input.request.kind,
          ...(input.request.website === undefined ? {} : { website: input.request.website }),
          scope: input.scope,
          projectId: input.projectId,
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
  });
});
export const layer = Layer.effect(CredentialVault, make);
