// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("chat timeline composer layout", () => {
  it("reserves layout space for the docked composer instead of overlaying the timeline", () => {
    const source = NodeFS.readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

    expect(source).toContain('data-chat-composer-layout={isDraftHeroState ? undefined : "true"}');
    expect(source).toContain('data-chat-composer-overlay={isDraftHeroState ? "true" : undefined}');
    expect(source).toContain(': "pointer-events-none relative z-20 shrink-0 pt-1.5 sm:pt-2"');
    expect(source).toContain("onLiveTailSizeChange={scheduleActiveTimelineEndReveal}");
    expect(source).toContain("animated: false,\n          viewPosition: 0,");
    expect(source).toContain(
      "showScrollDebouncer.current.cancel();\n    setShowScrollToBottom(false);",
    );
    expect(source).toContain("style={{ bottom: 4 }}");
    expect(source).not.toContain("contentInsetEndAdjustment=");
  });
});
