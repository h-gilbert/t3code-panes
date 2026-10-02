import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const descriptionCount = allOf.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      typeof (member as Record<string, unknown>).description === "string",
  ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("exports exact object result schemas for preview actions", () => {
  const actionNames = ["preview_type", "preview_scroll", "preview_wait_for"] as const;
  for (const name of actionNames) {
    expect(Tool.getJsonSchemaFromSchema(PreviewToolkit.tools[name].successSchema)).toEqual({
      type: "object",
      properties: { toolIcon: expect.any(Object) },
      additionalProperties: false,
      description: "The preview action completed successfully.",
    });
  }
});

it("reports a file picker opened by a click or key press", () => {
  for (const name of ["preview_click", "preview_press"] as const) {
    const schema = Tool.getJsonSchemaFromSchema(PreviewToolkit.tools[name].successSchema) as {
      readonly properties?: Record<string, unknown>;
      readonly additionalProperties?: boolean;
    };
    expect(Object.keys(schema.properties ?? {}).toSorted()).toEqual(["fileChooser", "toolIcon"]);
    expect(schema.additionalProperties).toBe(false);
  }
});

it("registers preview_close in both agent-facing toolkits", () => {
  const tool = PreviewToolkit.tools.preview_close;
  expect(tool).toBeDefined();
  expect(PreviewStandardToolkit.tools.preview_close).toBeDefined();
  // Closing a preview tab discards no user data; it must not be flagged
  // destructive, or cautious agent harnesses will refuse to call it.
  expect(Context.get(tool.annotations, Tool.Destructive)).toBe(false);
  const resultSchema = Tool.getJsonSchemaFromSchema(tool.successSchema) as {
    readonly properties?: Record<string, unknown>;
  };
  expect(Object.keys(resultSchema.properties ?? {})).toEqual(["tabId", "closed"]);
});

it("registers preview_autofill and its result never carries a password field", () => {
  const tool = PreviewToolkit.tools.preview_autofill;
  expect(tool).toBeDefined();
  expect(PreviewStandardToolkit.tools.preview_autofill).toBeDefined();
  const resultSchema = Tool.getJsonSchemaFromSchema(tool.successSchema) as {
    readonly properties?: Record<string, unknown>;
  };
  const keys = Object.keys(resultSchema.properties ?? {});
  expect(keys).toContain("filled");
  expect(keys).not.toContain("password");
});
