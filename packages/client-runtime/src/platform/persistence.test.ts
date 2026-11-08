import {
  OrchestrationProjectShell,
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/Arbitrary";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
} from "./orchestrationCache.ts";

// Generated values can hold untrimmed strings, which a decoded value never
// has. One encode and decode gives a value a client can hold; values that
// fail are dropped. Size 30 exercises optional fields and nested records.
const sampleDecoded = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);
    const generated = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      count: 1000,
      size: 30,
      seed: "shell-cache-round-trip",
    });
    const decoded = yield* Effect.forEach(generated, (value) =>
      encode(value).pipe(Effect.flatMap(decode), Effect.option),
    );
    return Arr.getSomes(decoded);
  });
const encodeSnapshot = Schema.encodeEffect(OrchestrationV2ShellSnapshotJson);
const StoredShellJson = Schema.fromJsonString(StoredOrchestrationShellSnapshot);
const encodeStoredShell = Schema.encodeEffect(StoredShellJson);
const decodeStoredShell = Schema.decodeEffect(StoredShellJson);

describe("V2 shell cache", () => {
  it.effect("matches the V2 JSON schema and round-trips generated active and archived shells", () =>
    Effect.gen(function* () {
      const threads = yield* sampleDecoded(OrchestrationV2ThreadShell);
      const projects = yield* sampleDecoded(OrchestrationProjectShell);
      const snapshot: OrchestrationV2ShellSnapshot = {
        schemaVersion: 2,
        snapshotSequence: 1,
        // Include the icon variants supported by this fork in the round trip.
        projects: projects.map((project, index) =>
          index % 2 === 0 ? { ...project, projectIcon: { kind: "emoji", emoji: "🚀" } } : project,
        ),
        threads: threads.slice(0, 500),
        archivedThreads: threads.slice(500),
      };

      expect(threads.length).toBeGreaterThan(0);
      expect(projects.length).toBeGreaterThan(0);
      expect(snapshot.archivedThreads.length).toBeGreaterThan(0);
      const envelope = {
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId: EnvironmentId.make("environment-generated-cache"),
        snapshot,
      };
      const encoded = yield* encodeStoredShell(envelope);
      const json = JSON.parse(encoded);
      expect(json.snapshot).toEqual(yield* encodeSnapshot(snapshot));
      expect(yield* decodeStoredShell(encoded)).toEqual(envelope);
      expect(json.snapshot.projects[0].projectIcon).toEqual({ kind: "emoji", emoji: "🚀" });
    }),
  );
});
