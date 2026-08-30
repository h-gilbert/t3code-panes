// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

describe("expanded image dialog layering", () => {
  it("renders above every pane through a document-level portal", () => {
    const source = NodeFS.readFileSync(
      new URL("./ExpandedImageDialog.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("return createPortal(");
    expect(source).toContain("document.body");
    expect(source).toContain("fixed inset-0 z-[150]");
  });
});
