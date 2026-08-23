// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("chat timeline composer inset", () => {
  it("reserves the measured composer height inside the virtualized timeline", () => {
    const source = NodeFS.readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");

    expect(source).toContain("contentInsetEndAdjustment={composerOverlayHeight}");
    expect(source).toContain("onLiveTailSizeChange={scheduleActiveTimelineEndReveal}");
    expect(source).toContain("composerOverlayHeight,\n        anchorOffset");
    expect(source).toContain("style={{ bottom: composerOverlayHeight + 4 }}");
    expect(source).not.toContain('data-chat-composer-layout-spacer="true"');
  });
});
