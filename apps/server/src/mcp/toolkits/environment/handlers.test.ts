import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as AgentSettings from "../../../settings/AgentSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:preferences",
  thread: {
    threadId,
    providerSessionId: "provider:preferences",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const layerEnvironment = Layer.mock(Environment.ServerEnvironment)({
  getDescriptor: Effect.succeed({
    environmentId,
    label: "Test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0",
    capabilities: { repositoryIdentity: false },
  }),
});

it.effect("registers the approved settings tool with its full settings schema", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    // A stopped caller is rejected before it can propose a settings change.
    const result = yield* server
      .callTool({
        name: "t3_settings_update",
        arguments: { reason: "Use the connected phone", patch: { enableAgentDeviceAccess: true } },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(
          McpSchema.McpServerClient,
          McpSchema.McpServerClient.of({
            clientId: 1,
            protocolVersion: "2025-06-18",
            clientCapabilities: {},
            clientInfo: { name: "preferences", version: "1" },
            initializePayload: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "preferences", version: "1" },
            },
            getClient: Effect.die("unused"),
          }),
        ),
      );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("parent_not_active"),
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerEnvironmentToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { activeRunId: null })),
          }),
        ),
        Layer.provide(layerEnvironment),
        Layer.provide(Settings.layerTest()),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);

it.effect.each(["approval-required", "full-access"] satisfies RuntimeMode[])(
  "requires app approval for settings in %s",
  (runtimeMode) =>
    Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const result = yield* toolkit
        .handle("t3_settings_update", {
          reason: "Enable device testing",
          patch: { enableAgentDeviceAccess: true },
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(result.at(-1)?.result).toEqual({ applied: false });
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, caller)),
          Layer.provideMerge(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { runtimeMode })),
            }),
          ),
          Layer.provideMerge(layerEnvironment),
          Layer.provideMerge(Settings.layerTest()),
          Layer.provideMerge(
            Layer.mock(AgentSettings.AgentSettings)({
              update: () => Effect.succeed({ applied: false }),
            }),
          ),
        ),
      ),
    ),
);
