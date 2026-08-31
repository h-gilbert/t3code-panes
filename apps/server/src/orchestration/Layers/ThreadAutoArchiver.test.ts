import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_THREAD_AUTO_ARCHIVE_AFTER_MS,
  isThreadEligibleForAutoArchive,
} from "./ThreadAutoArchiver.ts";

const NOW = Date.parse("2026-09-01T00:00:00.000Z");

const thread = (
  overrides: Partial<{
    archivedAt: string | null;
    settledAt: string | null;
    settledOverride: "settled" | "active" | null;
  }> = {},
) => ({
  archivedAt: null,
  settledAt: "2026-08-24T23:59:59.999Z",
  settledOverride: "settled" as const,
  ...overrides,
});

describe("thread auto-archive eligibility", () => {
  it("archives explicitly settled threads once seven days have elapsed", () => {
    expect(
      isThreadEligibleForAutoArchive(thread(), {
        nowMs: NOW,
        archiveAfterMs: DEFAULT_THREAD_AUTO_ARCHIVE_AFTER_MS,
      }),
    ).toBe(true);
    expect(
      isThreadEligibleForAutoArchive(thread({ settledAt: "2026-08-25T00:00:00.001Z" }), {
        nowMs: NOW,
        archiveAfterMs: DEFAULT_THREAD_AUTO_ARCHIVE_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("never archives active, unstamped, or archived threads", () => {
    const ineligible = [
      thread({ settledOverride: null }),
      thread({ settledOverride: "active" }),
      thread({ settledAt: null }),
      thread({ archivedAt: "2026-08-31T00:00:00.000Z" }),
    ];
    for (const candidate of ineligible) {
      expect(
        isThreadEligibleForAutoArchive(candidate, {
          nowMs: NOW,
          archiveAfterMs: DEFAULT_THREAD_AUTO_ARCHIVE_AFTER_MS,
        }),
      ).toBe(false);
    }
  });
});
