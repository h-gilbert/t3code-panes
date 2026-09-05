import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLAUDE_SPINNER_WORDS,
  ComposerWorkingStatus,
  formatComposerWorkingDuration,
  formatComposerWorkingWord,
} from "./ComposerWorkingStatus";

describe("ComposerWorkingStatus", () => {
  it("formats a running turn duration", () => {
    const startedAt = "2026-08-23T09:00:00.000Z";
    const startedAtMs = Date.parse(startedAt);

    expect(formatComposerWorkingDuration(startedAt, startedAtMs + 42_000)).toBe("42s");
    expect(formatComposerWorkingDuration(startedAt, startedAtMs + 92_000)).toBe("1m 32s");
    expect(formatComposerWorkingDuration(startedAt, startedAtMs + 3_720_000)).toBe("1h 2m");
    expect(formatComposerWorkingDuration("invalid", startedAtMs)).toBe("0s");
  });

  it("keeps one Claude spinner word for the whole response", () => {
    const startedAt = "2026-08-23T09:00:00.000Z";
    const word = formatComposerWorkingWord(startedAt);

    expect(CLAUDE_SPINNER_WORDS).toHaveLength(187);
    expect(CLAUDE_SPINNER_WORDS).toContain(word);
    expect(formatComposerWorkingWord(startedAt)).toBe(word);
    expect(formatComposerWorkingWord("invalid")).toBe("Working");
  });

  it("renders a static working label above the composer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T09:01:32.000Z"));
    const expectedWord = formatComposerWorkingWord("2026-08-23T09:00:00.000Z");
    const markup = renderToStaticMarkup(
      <ComposerWorkingStatus startedAt="2026-08-23T09:00:00.000Z" />,
    );
    vi.useRealTimers();

    expect(markup).toContain('data-composer-working-status="true"');
    expect(markup).toContain('aria-label="Thread is working"');
    expect(markup).toContain(`>${expectedWord}<`);
    expect(markup).toContain("1m 32s");
    expect(markup).not.toContain("composer-working-letter");
    expect(markup).not.toContain("animation");
    expect(markup).not.toContain("live-activity-focus");
  });
});
