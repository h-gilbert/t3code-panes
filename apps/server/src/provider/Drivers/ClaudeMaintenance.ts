import type { ProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenance";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

const ReleaseSettings = Schema.Struct({ autoUpdatesChannel: Schema.optional(Schema.String) });
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseSettings));
const RELEASES_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

export const withClaudeNativeLatestVersion = Effect.fn("withClaudeNativeLatestVersion")(function* (
  capabilities: ProviderMaintenanceCapabilities,
  configDir: string,
) {
  if (capabilities.update?.lockKey !== "claudeAgent-native") return capabilities;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;
  const lookupLatestVersion = Effect.gen(function* () {
    const settings = yield* fs.readFileString(path.join(configDir, "settings.json")).pipe(
      Effect.flatMap(decodeSettings),
      Effect.orElseSucceed(() => null),
    );
    const channel = settings?.autoUpdatesChannel === "stable" ? "stable" : "latest";
    const response = yield* client.get(`${RELEASES_URL}/${channel}`);
    if (response.status < 200 || response.status >= 300) return null;
    const version = (yield* response.text).trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }).pipe(
    Effect.timeout(4_000),
    Effect.orElseSucceed(() => null),
  );
  return {
    ...capabilities,
    update: {
      ...capabilities.update,
      env: { ...capabilities.update.env, CLAUDE_CONFIG_DIR: configDir },
    },
    latestVersion: null,
    lookupLatestVersion,
  };
});
