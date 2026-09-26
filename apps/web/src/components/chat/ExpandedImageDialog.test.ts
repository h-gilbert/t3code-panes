// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("expanded image dialog layering", () => {
  it("renders above every pane through a document-level portal", () => {
    const source = NodeFS.readFileSync(
      new URL("./ExpandedImageDialog.tsx", import.meta.url),
      "utf8",
    );

    // The dialog primitive owns the document-level portal; what this file still
    // has to get right is stacking above the pane grid on both of its layers.
    expect(source).toContain("<DialogPopup");
    expect(source).toContain('backdropClassName="z-[150]"');
    expect(source).toMatch(/viewportClassName="z-\[150\]/);
  });
});
