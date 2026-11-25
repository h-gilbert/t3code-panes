import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

// Gemini rejects function declarations whose enums hold anything but strings.
const isNonStringEnum = (key: string, value: Json) =>
  key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string");

const isAnnotationOnlyObject = (value: Json): value is JsonObject => {
  if (!Predicate.isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "description" || key === "title");
};

const stringEnumValuesOf = (branch: JsonObject, key: string): ReadonlyArray<string> | undefined => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  if (
    !Predicate.isObject(property) ||
    !Array.isArray(property.enum) ||
    property.enum.length === 0
  ) {
    return undefined;
  }
  return property.enum.every((item): item is string => typeof item === "string")
    ? property.enum
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const groups = objects.map((object) => stringEnumValuesOf(object, key));
    if (!groups.every((group): group is ReadonlyArray<string> => group !== undefined)) return false;
    const all = groups.flat();
    return new Set(all).size === all.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: {
      type: "string",
      enum: objects.flatMap((object) => stringEnumValuesOf(object, tag)!),
    },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const NUMERIC_RANGE_KEYS: ReadonlySet<string> = new Set([
  "type",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "description",
]);

/** Collapses same-type numeric range unions (e.g. image vs file byte limits) into one schema. */
const mergeNumericRangeUnion = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const first = branches[0];
  if (!Predicate.isObject(first) || (first.type !== "integer" && first.type !== "number")) {
    return undefined;
  }
  const type = first.type;
  const objects = branches.filter(
    (branch): branch is JsonObject =>
      Predicate.isObject(branch) &&
      branch.type === type &&
      Object.keys(branch).every((key) => NUMERIC_RANGE_KEYS.has(key)),
  );
  if (objects.length !== branches.length) return undefined;
  const merged: JsonObject = { type };
  const minimums = objects.map((object) => object.minimum);
  const maximums = objects.map((object) => object.maximum);
  if (minimums.every((value): value is number => typeof value === "number")) {
    merged.minimum = Math.min(...minimums);
  }
  if (maximums.every((value): value is number => typeof value === "number")) {
    merged.maximum = Math.max(...maximums);
  }
  return merged;
};

const compact = (schema: Json, optional: boolean): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    if (isNonStringEnum(key, value)) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name)),
            ]),
          )
        : compact(value, false);
  }
  // Effect emits `allOf: [{ description }]` for `.annotateKey(...)` on refined schemas; Gemini drops `allOf`.
  if (Array.isArray(result.allOf)) {
    const remaining: Array<Json> = [];
    for (const branch of result.allOf) {
      if (isAnnotationOnlyObject(branch)) {
        for (const [key, value] of Object.entries(branch)) {
          if (result[key] === undefined) result[key] = value;
        }
      } else {
        remaining.push(branch);
      }
    }
    if (remaining.length === 0) delete result.allOf;
    else result.allOf = remaining;
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    const only =
      branches.length === 1
        ? branches[0]
        : (mergeTaggedObjects(branches) ?? mergeNumericRangeUnion(branches));
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: branches };
  }
  return result;
};

/**
 * The input schema T3 advertises for a tool. Drops JSON noise that every thread pays for:
 * `additionalProperties: true`, safe-integer bounds, annotation-only `allOf`, nested `anyOf`,
 * JSON-string fallbacks, and the `null` branch of optional properties. Tagged unions of objects
 * and numeric range unions become one schema. Decoding still uses the full schema.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false) as ReturnType<typeof Tool.getJsonSchema>;

/**
 * Antigravity (`agy`) silently drops the largest eager MCP tools once the combined tool list
 * exceeds its ~59 KB raw JSON budget (~57.4–59.0 KB loaded, ~59.1–60.0 KB dropped). Keep the
 * aggregate list comfortably below that ceiling while capping individual tools as well.
 */
export const COMPACT_MCP_TOOL_MAX_JSON_BYTES = 1_900;
export const COMPACT_MCP_TOOL_MAX_PARAMS_BYTES = 1_650;
export const COMPACT_MCP_TOOL_LIST_MAX_JSON_BYTES = 54_000;

const VALIDATION_CONSTRAINT_KEYS: ReadonlySet<string> = new Set([
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
]);

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
// Antigravity re-encodes tools with Go's encoding/json, which writes these as six-byte escapes.
const jsonWireBytes = (value: unknown) =>
  utf8Bytes(JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, "\\u0000"));

/** A tool's declaration size as Antigravity counts it, in total and for its parameters. */
export const mcpToolWireBytes = (tool: {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}) => ({
  total: jsonWireBytes(
    tool.description === undefined
      ? { name: tool.name, parameters: tool.inputSchema }
      : { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  ),
  params: jsonWireBytes(tool.inputSchema),
});

const stripValidationConstraints = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(stripValidationConstraints);
  if (!Predicate.isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (VALIDATION_CONSTRAINT_KEYS.has(key)) continue;
    out[key] = stripValidationConstraints(entry);
  }
  return out;
};

const cloneJson = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!Predicate.isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = cloneJson(entry);
  }
  return out;
};

const collectDescriptionNodes = (value: Json, out: Array<JsonObject>): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectDescriptionNodes(item, out);
    return;
  }
  if (!Predicate.isObject(value)) return;
  if (typeof value.description === "string") out.push(value);
  for (const entry of Object.values(value)) collectDescriptionNodes(entry, out);
};

const findLargestNestedObject = (
  value: Json,
  isRoot: boolean,
): { readonly node: JsonObject; readonly bytes: number } | undefined => {
  if (Array.isArray(value)) {
    let best: { readonly node: JsonObject; readonly bytes: number } | undefined;
    for (const item of value) {
      const candidate = findLargestNestedObject(item, false);
      if (candidate !== undefined && (best === undefined || candidate.bytes > best.bytes)) {
        best = candidate;
      }
    }
    return best;
  }
  if (!Predicate.isObject(value)) return undefined;
  let best: { readonly node: JsonObject; readonly bytes: number } | undefined;
  if (
    !isRoot &&
    value.type === "object" &&
    Predicate.isObject(value.properties) &&
    Object.keys(value.properties).length > 0
  ) {
    best = { node: value, bytes: utf8Bytes(JSON.stringify(value)) };
  }
  for (const entry of Object.values(value)) {
    const candidate = findLargestNestedObject(entry, false);
    if (candidate !== undefined && (best === undefined || candidate.bytes > best.bytes)) {
      best = candidate;
    }
  }
  return best;
};

/** Trims text so its encoded JSON string, quotes included, fits `maxBytes`. */
const trimJsonText = (text: string, maxBytes: number): string => {
  if (jsonWireBytes("") >= maxBytes) return "";
  if (jsonWireBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = text.slice(0, mid);
    if (jsonWireBytes(`${slice}…`) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  if (low === 0) return "";
  const last = text.charCodeAt(low - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? low - 1 : low;
  return `${text.slice(0, end)}…`;
};

const toolMatchesBudget = (
  name: string,
  description: string | undefined,
  inputSchema: Json,
  maxToolBytes: number,
  maxParamsBytes: number,
): boolean => {
  const bytes = mcpToolWireBytes({ name, description, inputSchema });
  return bytes.params <= maxParamsBytes && bytes.total <= maxToolBytes;
};

export interface CompactMcpToolBudget {
  readonly maxToolBytes?: number;
  readonly maxParamsBytes?: number;
  readonly maxListBytes?: number;
}

export interface CompactableMcpTool {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Json;
}

/**
 * Compacts an MCP tool descriptor only when it exceeds a client's per-tool size ceiling.
 * Preserves top-level tool description, parameter names, types, enums, and required keys
 * wherever possible; tools already under budget are returned untouched.
 */
export const compactMcpToolForSizeBudget = <T extends CompactableMcpTool>(
  tool: T,
  budget?: CompactMcpToolBudget,
): T => {
  if (tool.inputSchema === undefined) return tool;
  const maxToolBytes = budget?.maxToolBytes ?? COMPACT_MCP_TOOL_MAX_JSON_BYTES;
  const maxParamsBytes = budget?.maxParamsBytes ?? COMPACT_MCP_TOOL_MAX_PARAMS_BYTES;
  if (
    toolMatchesBudget(tool.name, tool.description, tool.inputSchema, maxToolBytes, maxParamsBytes)
  ) {
    return tool;
  }
  let schema = stripValidationConstraints(tool.inputSchema);
  let description = tool.description;
  if (toolMatchesBudget(tool.name, description, schema, maxToolBytes, maxParamsBytes)) {
    return { ...tool, inputSchema: schema };
  }
  schema = cloneJson(schema);
  const described: Array<JsonObject> = [];
  collectDescriptionNodes(schema, described);
  described.sort(
    (left, right) =>
      utf8Bytes(String(right.description ?? "")) - utf8Bytes(String(left.description ?? "")),
  );
  for (const node of described) {
    delete node.description;
    if (toolMatchesBudget(tool.name, description, schema, maxToolBytes, maxParamsBytes)) {
      return { ...tool, inputSchema: schema };
    }
  }
  while (!toolMatchesBudget(tool.name, description, schema, maxToolBytes, maxParamsBytes)) {
    const largest = findLargestNestedObject(schema, true);
    if (largest === undefined) break;
    delete largest.node.properties;
    delete largest.node.required;
    delete largest.node.additionalProperties;
  }
  if (
    !toolMatchesBudget(tool.name, description, schema, maxToolBytes, maxParamsBytes) &&
    description !== undefined
  ) {
    const overhead = jsonWireBytes({ name: tool.name, description: "", parameters: schema });
    description = trimJsonText(description, maxToolBytes - overhead + jsonWireBytes(""));
  }
  return { ...tool, ...(description === undefined ? {} : { description }), inputSchema: schema };
};

/**
 * Compacts an MCP `tools/list` array so both individual tools and the combined list stay
 * within Antigravity's eager MCP schema budget. Strips validation constraints and the longest
 * parameter descriptions first, preserving tool names, top-level descriptions, and parameter shapes.
 */
export const compactMcpToolsForSizeBudget = <T extends CompactableMcpTool>(
  tools: ReadonlyArray<T>,
  budget?: CompactMcpToolBudget,
): ReadonlyArray<T> => {
  const maxListBytes = budget?.maxListBytes ?? COMPACT_MCP_TOOL_LIST_MAX_JSON_BYTES;
  let changed = false;
  const working: Array<T> = tools.map((tool) => {
    const compacted = compactMcpToolForSizeBudget(tool, budget);
    if (compacted !== tool) changed = true;
    return compacted;
  });
  const wireBytes = working.map((tool) => mcpToolWireBytes(tool).total);
  let totalBytes = wireBytes.reduce((sum, bytes) => sum + bytes, 0);
  if (totalBytes <= maxListBytes) return changed ? working : tools;

  const updateTool = (index: number, next: T): number => {
    const nextBytes = mcpToolWireBytes(next).total;
    totalBytes += nextBytes - wireBytes[index]!;
    wireBytes[index] = nextBytes;
    working[index] = next;
    changed = true;
    return totalBytes;
  };

  // Pass 1: drop JSON Schema validation constraints from the largest tools first.
  const byLargest = working
    .map((_, index) => index)
    .toSorted((left, right) => wireBytes[right]! - wireBytes[left]!);
  for (const index of byLargest) {
    if (totalBytes <= maxListBytes) break;
    const tool = working[index]!;
    if (tool.inputSchema === undefined) continue;
    const stripped = stripValidationConstraints(tool.inputSchema);
    const candidate = { ...tool, inputSchema: stripped };
    if (mcpToolWireBytes(candidate).total < wireBytes[index]!) {
      totalBytes = updateTool(index, candidate);
    }
  }

  // Pass 2: drop the longest nested parameter descriptions across the list.
  if (totalBytes > maxListBytes) {
    const clonedSchemas = new Map<number, Json>();
    const dirtyTools = new Set<number>();
    const descriptionNodes: Array<{
      readonly index: number;
      readonly node: JsonObject;
      readonly bytes: number;
    }> = [];
    for (let index = 0; index < working.length; index++) {
      const schema = working[index]!.inputSchema;
      if (schema === undefined) continue;
      const cloned = cloneJson(schema);
      const nodes: Array<JsonObject> = [];
      collectDescriptionNodes(cloned, nodes);
      if (nodes.length === 0) continue;
      clonedSchemas.set(index, cloned);
      for (const node of nodes) {
        descriptionNodes.push({
          index,
          node,
          bytes: jsonWireBytes(String(node.description ?? "")),
        });
      }
    }
    descriptionNodes.sort((left, right) => right.bytes - left.bytes);
    for (const entry of descriptionNodes) {
      if (totalBytes <= maxListBytes) break;
      delete entry.node.description;
      dirtyTools.add(entry.index);
      const tool = working[entry.index]!;
      const nextSchema = clonedSchemas.get(entry.index)!;
      const nextBytes = mcpToolWireBytes({ ...tool, inputSchema: nextSchema }).total;
      totalBytes += nextBytes - wireBytes[entry.index]!;
      wireBytes[entry.index] = nextBytes;
    }
    for (const index of dirtyTools) {
      working[index] = { ...working[index]!, inputSchema: clonedSchemas.get(index)! };
      changed = true;
    }
  }

  // Pass 3: collapse the largest nested object properties across tools if still over budget.
  const nestedClones = new Map<number, Json>();
  while (totalBytes > maxListBytes) {
    let best:
      | { readonly index: number; readonly node: JsonObject; readonly bytes: number }
      | undefined;
    for (let index = 0; index < working.length; index++) {
      const rawSchema = working[index]!.inputSchema;
      if (rawSchema === undefined) continue;
      const schema = nestedClones.get(index) ?? rawSchema;
      const candidate = findLargestNestedObject(schema, true);
      if (candidate !== undefined && (best === undefined || candidate.bytes > best.bytes)) {
        best = { index, node: candidate.node, bytes: candidate.bytes };
      }
    }
    if (best === undefined) break;
    let schema = nestedClones.get(best.index);
    if (schema === undefined) {
      schema = cloneJson(working[best.index]!.inputSchema);
      nestedClones.set(best.index, schema);
      const refreshed = findLargestNestedObject(schema, true);
      if (refreshed === undefined) break;
      best = { index: best.index, node: refreshed.node, bytes: refreshed.bytes };
    }
    delete best.node.properties;
    delete best.node.required;
    delete best.node.additionalProperties;
    totalBytes = updateTool(best.index, { ...working[best.index]!, inputSchema: schema });
  }

  // Pass 4: last-resort trim of the longest top-level tool descriptions.
  while (totalBytes > maxListBytes) {
    let longestIndex = -1;
    let longestBytes = jsonWireBytes("");
    let secondBytes = jsonWireBytes("");
    for (let index = 0; index < working.length; index++) {
      const description = working[index]!.description;
      if (description === undefined) continue;
      const bytes = jsonWireBytes(description);
      if (bytes > longestBytes) {
        secondBytes = longestBytes;
        longestBytes = bytes;
        longestIndex = index;
      } else if (bytes > secondBytes) {
        secondBytes = bytes;
      }
    }
    if (longestIndex === -1) break;
    const tool = working[longestIndex]!;
    const excess = totalBytes - maxListBytes;
    const targetBytes = Math.max(
      jsonWireBytes(""),
      Math.min(longestBytes - excess, Math.max(secondBytes - 1, Math.floor(longestBytes / 2))),
    );
    const trimmed = trimJsonText(tool.description!, targetBytes);
    if (trimmed === tool.description) break;
    totalBytes = updateTool(longestIndex, { ...tool, description: trimmed });
  }

  return changed ? working : tools;
};

const compactToolsListMessage = (
  message: Json,
  budget?: CompactMcpToolBudget,
): { readonly value: Json; readonly changed: boolean } => {
  if (Array.isArray(message)) {
    let changed = false;
    const next = message.map((entry) => {
      const updated = compactToolsListMessage(entry, budget);
      if (updated.changed) changed = true;
      return updated.value;
    });
    return { value: changed ? next : message, changed };
  }
  if (
    !Predicate.isObject(message) ||
    !Predicate.isObject(message.result) ||
    !Array.isArray(message.result.tools)
  ) {
    return { value: message, changed: false };
  }
  const indexed: Array<{ readonly index: number; readonly tool: CompactableMcpTool }> = [];
  for (let index = 0; index < message.result.tools.length; index++) {
    const entry = message.result.tools[index];
    if (!Predicate.isObject(entry) || typeof entry.name !== "string") continue;
    indexed.push({
      index,
      tool: {
        ...entry,
        name: entry.name,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        ...(entry.inputSchema === undefined ? {} : { inputSchema: entry.inputSchema }),
      },
    });
  }
  const rawTools = indexed.map((entry) => entry.tool);
  const compactedTools = compactMcpToolsForSizeBudget(rawTools, budget);
  if (compactedTools === rawTools) return { value: message, changed: false };
  const tools = [...message.result.tools];
  for (let i = 0; i < indexed.length; i++) {
    tools[indexed[i]!.index] = compactedTools[i];
  }
  return {
    value: { ...message, result: { ...message.result, tools } },
    changed: true,
  };
};

/**
 * Rewrites JSON or SSE-framed JSON-RPC text containing `result.tools` so oversized
 * MCP tools fit within the client's per-tool budget. Returns `undefined` when unchanged.
 */
export const compactToolsListResponseText = (
  text: string,
  budget?: CompactMcpToolBudget,
): string | undefined => {
  if (!text.includes('"tools"')) return undefined;
  const rewriteJson = (raw: string): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(raw);
      const updated = compactToolsListMessage(parsed, budget);
      return updated.changed ? JSON.stringify(updated.value) : undefined;
    } catch {
      return undefined;
    }
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return rewriteJson(text);
  }
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const prefix = line.startsWith("data: ") ? "data: " : "data:";
    const rewritten = rewriteJson(line.slice(prefix.length));
    if (rewritten === undefined) return line;
    changed = true;
    return `${prefix}${rewritten}`;
  });
  return changed ? lines.join("\n") : undefined;
};
