import {
  CredentialVaultPeerResult,
  EnvironmentId,
  SecretRequestError,
  type CredentialVaultPeerInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerSettings from "../serverSettings.ts";

/** The link-only tool a browser host serves its vault through. */
export const CREDENTIAL_VAULT_PEER_TOOL = "t3_credential_vault";

const hostFailed = (detail: string) =>
  new SecretRequestError({ reason: "vault_host_failed", detail });

/**
 * An environment whose browser host is another, linked environment shares that host's vault, so
 * a login saved once serves both. Values cross only the authenticated link, one per call.
 */
export class LinkedCredentialVault extends Context.Service<
  LinkedCredentialVault,
  {
    /** The linked browser host whose vault this environment uses, if any. */
    readonly host: Effect.Effect<Option.Option<EnvironmentId>, SecretRequestError>;
    readonly call: (
      host: EnvironmentId,
      input: CredentialVaultPeerInput,
    ) => Effect.Effect<CredentialVaultPeerResult, SecretRequestError>;
  }
>()("t3/secrets/LinkedCredentialVault") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const links = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  return LinkedCredentialVault.of({
    host: Effect.gen(function* () {
      const selected = (yield* settings.getSettings).browserHostEnvironmentId;
      if (selected === null || selected === (yield* environment.getEnvironmentId)) {
        return Option.none();
      }
      // Without a link to the browser host, this environment keeps its own vault.
      if (!(yield* links.enabled)) return Option.none();
      const link = yield* links.get(EnvironmentId.make(selected));
      return Option.map(link, (found) => found.environmentId);
    }).pipe(
      Effect.mapError(() => hostFailed("Could not read this environment's link settings.")),
      Effect.withSpan("LinkedCredentialVault.host"),
    ),
    call: Effect.fn("LinkedCredentialVault.call")(
      function* (host, input) {
        return yield* client.call({
          environmentId: host,
          tool: CREDENTIAL_VAULT_PEER_TOOL,
          arguments: { ...input },
          // Vault calls act for no agent; the link's own access still bounds them there.
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: CredentialVaultPeerResult,
        });
      },
      (effect, _host, input) =>
        effect.pipe(
          Effect.mapError((failure) => hostFailed(failure.message)),
          Effect.annotateSpans({ "credential_vault.op": input.op }),
        ),
    ),
  });
});

export const layer = Layer.effect(LinkedCredentialVault, make);
