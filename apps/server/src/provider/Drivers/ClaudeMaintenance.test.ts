import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  createProviderVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import { withClaudeNativeLatestVersion } from "./ClaudeMaintenance.ts";

it.effect.each([
  { channel: undefined, body: "2.1.314\n", status: 200, expected: "2.1.314" },
  { channel: "stable", body: "2.1.308", status: 200, expected: "2.1.308" },
  { channel: "latest", body: "unavailable", status: 200, expected: null },
  { channel: "latest", body: "2.1.316", status: 503, expected: null },
  { channel: "latest", body: "2.1.315", status: 200, expected: "2.1.315" },
])("checks the native release instead of npm: $channel, $status, $body", (fixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(
      path.join(configDir, "settings.json"),
      JSON.stringify({ autoUpdatesChannel: fixture.channel }),
    );
    const requests: string[] = [];
    const capabilities = yield* withClaudeNativeLatestVersion(
      makeProviderMaintenanceCapabilities({
        provider: ProviderDriverKind.make("claudeAgent"),
        packageName: "@anthropic-ai/claude-code",
        updateExecutable: "/home/me/.local/bin/claude",
        updateArgs: ["update"],
        updateLockKey: "claudeAgent-native",
      }),
      configDir,
    ).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(fixture.body, { status: fixture.status }),
            ),
          );
        }),
      ),
    );
    const latest = yield* resolveLatestProviderVersion(capabilities).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("must not compare native installs against npm")),
      ),
    );
    expect(latest).toBe(fixture.expected);
    expect(requests).toEqual([
      `https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/${fixture.channel ?? "latest"}`,
    ]);
    expect(
      createProviderVersionAdvisory({
        driver: ProviderDriverKind.make("claudeAgent"),
        currentVersion: "2.1.314",
        latestVersion: latest,
        maintenanceCapabilities: capabilities,
      }).status,
    ).toBe(
      fixture.expected === null
        ? "unknown"
        : fixture.expected === "2.1.315"
          ? "behind_latest"
          : "current",
    );
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, ProviderLatestVersions.layer])),
);
