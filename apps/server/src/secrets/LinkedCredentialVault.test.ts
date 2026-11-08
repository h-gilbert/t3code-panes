import { expect, it } from "@effect/vitest";
import { EnvironmentId, type PeerLink } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LinkedCredentialVault from "./LinkedCredentialVault.ts";

const vaultHost = (settings: {
  readonly browserHostEnvironmentId: string | null;
  readonly credentialVaultEnvironmentId: string | null;
}) =>
  Effect.gen(function* () {
    const linked = yield* LinkedCredentialVault.LinkedCredentialVault;
    return yield* linked.host;
  }).pipe(
    Effect.provide(
      LinkedCredentialVault.layer.pipe(
        Layer.provide(ServerSettings.layerTest(settings)),
        Layer.provide(
          Layer.succeed(
            ServerEnvironment.ServerEnvironment,
            ServerEnvironment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("air")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            get: (environmentId) => Effect.succeed(Option.some({ environmentId } as PeerLink)),
          }),
        ),
        Layer.provide(Layer.mock(PeerMcpClient.PeerMcpClient)({})),
      ),
    ),
  );

it.effect.each([
  { browser: "jeff", vault: null, expected: "jeff" },
  { browser: null, vault: "jeff", expected: "jeff" },
  { browser: "jeff", vault: "air", expected: null },
  { browser: null, vault: null, expected: null },
])(
  "uses the vault of $expected for browser host $browser and vault $vault",
  ({ browser, vault, expected }) =>
    Effect.gen(function* () {
      const host = yield* vaultHost({
        browserHostEnvironmentId: browser,
        credentialVaultEnvironmentId: vault,
      });
      expect(Option.getOrNull(host)).toBe(expected);
    }),
);
