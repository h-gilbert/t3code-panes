import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthMcpClientAccess, AuthSessionId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";

const layerCli = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);
const decodeIssued = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      token: Schema.String,
      sessionId: AuthSessionId,
      subject: Schema.String,
      scopes: Schema.Array(Schema.String),
      access: Schema.optionalKey(AuthMcpClientAccess),
      expiresAt: Schema.String,
    }),
  ),
);
const run = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const stdout = Effect.gen(function* () {
  return (
    (yield* TestConsole.logLines).findLast((line): line is string => typeof line === "string") ?? ""
  );
});
const bearerRequest = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/mcp", { headers: { authorization: `Bearer ${token}` } }),
  );

it.effect.each(AuthMcpClientAccess.literals)(
  "auth mcp issue persists an MCP-only %s grant with the requested lifetime",
  (access) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auth-mcp-cli-" });
      const before = yield* Clock.currentTimeMillis;
      yield* run([
        "auth",
        "mcp",
        "issue",
        "--base-dir",
        baseDir,
        "--access",
        access,
        "--ttl",
        "5m",
        "--label",
        "Remote helper",
        "--json",
      ]);
      const issued = decodeIssued(yield* stdout);
      const after = yield* Clock.currentTimeMillis;
      expect(Date.parse(issued.expiresAt)).toBeGreaterThanOrEqual(before + 299_000);
      expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual(after + 300_000);
      expect(issued.subject).toBe("mcp-client");
      expect(issued.access).toBe(access);
      expect(issued.scopes).toEqual(
        access === "read-only"
          ? ["orchestration:read"]
          : access === "full-access"
            ? [
                "orchestration:read",
                "orchestration:operate",
                "settings:write",
                "source-control:write",
              ]
            : ["orchestration:read", "orchestration:operate"],
      );

      // Reopen the store as the server would: verify the signed ceiling rather
      // than trusting the CLI's output or decoding an unverified payload.
      const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        expect(yield* auth.authenticateMcpClient(bearerRequest(issued.token))).toMatchObject({
          sessionId: issued.sessionId,
          label: "Remote helper",
          access,
        });
        const httpError = yield* auth
          .authenticateHttpRequest(bearerRequest(issued.token))
          .pipe(Effect.flip);
        expect(httpError._tag).toBe("ServerAuthInvalidCredentialError");
        const wsError = yield* auth
          .authenticateWebSocketUpgrade(bearerRequest(issued.token), "rpc")
          .pipe(Effect.flip);
        expect(wsError._tag).toBe("ServerAuthInvalidCredentialError");
        expect(yield* auth.revokeSession(issued.sessionId)).toBe(true);
        expect(
          yield* auth.authenticateMcpClient(bearerRequest(issued.token)).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ServerAuthInvalidCredentialError",
        });
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
    }).pipe(Effect.provide(layerCli)),
);

it.effect(
  "auth mcp issue defaults to read only and token-only output contains only the token",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auth-mcp-default-" });
      yield* run(["auth", "mcp", "issue", "--base-dir", baseDir, "--token-only"]);
      const output = yield* stdout;
      expect(output.trim().split(/\s+/)).toHaveLength(1);
      const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        expect(yield* auth.authenticateMcpClient(bearerRequest(output.trim()))).toMatchObject({
          access: "read-only",
        });
      }).pipe(
        Effect.provide(
          EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
    }).pipe(Effect.provide(layerCli)),
);

it.effect("generic CLI MCP sessions keep their conservative ceiling", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-auth-mcp-legacy-" });
    yield* run([
      "auth",
      "session",
      "issue",
      "--base-dir",
      baseDir,
      "--subject",
      "mcp-client",
      "--scope",
      "orchestration:read",
      "--scope",
      "orchestration:operate",
      "--json",
    ]);
    const issued = decodeIssued(yield* stdout);
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      expect(yield* auth.authenticateMcpClient(bearerRequest(issued.token))).toMatchObject({
        access: "approval-required",
      });
    }).pipe(
      Effect.provide(EnvironmentAuth.layerRuntime.pipe(Layer.provide(ServerConfig.layer(config)))),
    );
  }).pipe(Effect.provide(layerCli)),
);
