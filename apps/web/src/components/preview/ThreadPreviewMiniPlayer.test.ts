// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("floating browser fullscreen presentation", () => {
  it("moves fullscreen presentation above the pane grid and fills the viewport", () => {
    const source = NodeFS.readFileSync(
      new URL("./ThreadPreviewMiniPlayer.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("return maximized ? createPortal(player, document.body) : player");
    expect(source).toContain("fitSourceContent={!maximized}");
    expect(source).toContain("zIndex={maximized ? 110 : 30}");
    expect(source).toContain('? "pointer-events-none fixed z-100');
    expect(source).toContain('aria-label={mobileViewport ? "Leave mobile viewport"');
    expect(source).toContain('? "Set viewport dimensions" : "Fill available space"');
  });
});
