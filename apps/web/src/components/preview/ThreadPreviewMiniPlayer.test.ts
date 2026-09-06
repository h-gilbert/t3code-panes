// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("floating browser fullscreen presentation", () => {
  it("keeps floating and fullscreen presentation above the pane grid", () => {
    const source = NodeFS.readFileSync(
      new URL("./ThreadPreviewMiniPlayer.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("{compact ? player : createPortal(player, document.body)}");
    expect(source).toContain("fitSourceContent={compact}");
    expect(source).toContain("zIndex={110}");
    expect(source).toContain('? "pointer-events-none fixed z-100');
  });
});
