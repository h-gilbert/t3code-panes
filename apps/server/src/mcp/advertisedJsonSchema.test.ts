import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import {
  advertisedJsonSchema,
  COMPACT_MCP_TOOL_MAX_JSON_BYTES,
  COMPACT_MCP_TOOL_MAX_PARAMS_BYTES,
  compactMcpToolForSizeBudget,
  compactToolsListResponseText,
  mcpToolWireBytes,
} from "./advertisedJsonSchema.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("drops JSON noise, flattens annotation allOf, merges tagged & range unions, and keeps null where required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      tabId: Schema.optional(Schema.String.check(Schema.isNonEmpty())).annotateKey({
        description: "Exact browser tab id.",
      }),
      sizeBytes: Schema.Union([
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10 })),
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
      ]),
      filter: Schema.Union([
        Schema.Struct({
          op: Schema.Literals(["equals", "startsWith"]),
          path: Schema.String,
          value: Schema.String,
        }),
        Schema.Struct({
          op: Schema.Literal("exists"),
          path: Schema.String,
        }),
      ]),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      tabId: { type: "string", minLength: 1, description: "Exact browser tab id." },
      sizeBytes: { type: "integer", minimum: 0, maximum: 50 },
      filter: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["equals", "startsWith", "exists"] },
          path: { type: "string" },
          value: { type: "string" },
        },
        required: ["op", "path"],
      },
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every", "sizeBytes", "filter"],
  });
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});

it("compacts oversized tools under Antigravity's per-tool byte budget without altering small tools", () => {
  const oversizedTools = [
    PreviewToolkit.tools.preview_open,
    PreviewToolkit.tools.preview_navigate,
    PreviewToolkit.tools.preview_act,
    OrchestratorToolkit.tools.schedule_task,
    ProjectToolkit.tools.t3_thread_launch,
    EnvironmentToolkit.tools.t3_settings_update,
    OrchestratorToolkit.tools.request_secret,
  ];
  for (const tool of oversizedTools) {
    const raw = {
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: advertisedJsonSchema(tool),
    };
    const compacted = compactMcpToolForSizeBudget(raw);
    const { total: totalBytes, params: paramsBytes } = mcpToolWireBytes(compacted);
    expect(totalBytes, `${tool.name} total bytes`).toBeLessThanOrEqual(
      COMPACT_MCP_TOOL_MAX_JSON_BYTES,
    );
    expect(paramsBytes, `${tool.name} params bytes`).toBeLessThanOrEqual(
      COMPACT_MCP_TOOL_MAX_PARAMS_BYTES,
    );
    // Only a description longer than the budget allows loses its end.
    const kept = (compacted.description ?? "").replace(/…$/u, "");
    expect(raw.description?.startsWith(kept), `${tool.name} keeps a description prefix`).toBe(true);
    expect(kept.length, `${tool.name} keeps most of its description`).toBeGreaterThanOrEqual(
      Math.floor((raw.description?.length ?? 0) * 0.8),
    );
    const compactedProps = (compacted.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    const rawProps = (raw.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(Object.keys(compactedProps ?? {}), `${tool.name} keeps all top-level keys`).toEqual(
      Object.keys(rawProps ?? {}),
    );
  }

  const small = {
    name: PreviewToolkit.tools.preview_status.name,
    description: Tool.getDescription(PreviewToolkit.tools.preview_status),
    inputSchema: advertisedJsonSchema(PreviewToolkit.tools.preview_status),
  };
  expect(compactMcpToolForSizeBudget(small)).toBe(small);

  // Also handles SSE-framed tools/list responses and leaves non-list responses alone.
  const sse = `data: ${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        {
          name: PreviewToolkit.tools.preview_open.name,
          description: Tool.getDescription(PreviewToolkit.tools.preview_open),
          inputSchema: advertisedJsonSchema(PreviewToolkit.tools.preview_open),
        },
      ],
    },
  })}\n\n`;
  const rewritten = compactToolsListResponseText(sse);
  expect(rewritten).toBeDefined();
  const parsed = JSON.parse(rewritten!.replace(/^data: /u, "").trim()) as {
    result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
  };
  expect(parsed.result.tools[0]?.name).toBe("preview_open");
  expect(mcpToolWireBytes(parsed.result.tools[0]!).total).toBeLessThanOrEqual(
    COMPACT_MCP_TOOL_MAX_JSON_BYTES,
  );
  expect(
    compactToolsListResponseText(`data: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n`),
  ).toBeUndefined();
});
