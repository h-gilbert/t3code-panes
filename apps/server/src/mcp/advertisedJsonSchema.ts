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
 * Antigravity (`agy`) silently drops eager MCP tools whose serialized JSON exceeds ~2 KiB.
 * Stay strictly below the largest tool verified to load (`delegate_task`: 1,937 B / 1,692 B params).
 */
export const COMPACT_MCP_TOOL_MAX_JSON_BYTES = 1_900;
export const COMPACT_MCP_TOOL_MAX_PARAMS_BYTES = 1_650;

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

const trimUtf8Text = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = text.slice(0, mid);
    if (utf8Bytes(`${slice}…`) <= maxBytes) low = mid;
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
  if (utf8Bytes(JSON.stringify(inputSchema)) > maxParamsBytes) return false;
  const serialized = JSON.stringify(
    description === undefined
      ? { name, parameters: inputSchema }
      : { name, description, parameters: inputSchema },
  );
  return utf8Bytes(serialized) <= maxToolBytes;
};

export interface CompactMcpToolBudget {
  readonly maxToolBytes?: number;
  readonly maxParamsBytes?: number;
}

/**
 * Compacts an MCP tool descriptor only when it exceeds a client's per-tool size ceiling.
 * Preserves top-level tool description, parameter names, types, enums, and required keys
 * wherever possible; tools already under budget are returned untouched.
 */
export const compactMcpToolForSizeBudget = <
  T extends {
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema?: Json;
  },
>(
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
    const overhead = utf8Bytes(
      JSON.stringify({ name: tool.name, description: "", parameters: schema }),
    );
    description = trimUtf8Text(description, Math.max(0, maxToolBytes - overhead));
  }
  return { ...tool, ...(description === undefined ? {} : { description }), inputSchema: schema };
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
  let changed = false;
  const tools = message.result.tools.map((entry) => {
    if (!Predicate.isObject(entry) || typeof entry.name !== "string") return entry;
    const compacted = compactMcpToolForSizeBudget(
      entry as {
        readonly name: string;
        readonly description?: string | undefined;
        readonly inputSchema?: Json;
      },
      budget,
    );
    if (compacted !== entry) changed = true;
    return compacted;
  });
  if (!changed) return { value: message, changed: false };
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
