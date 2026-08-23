import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspacePaneThreadTitle } from "./workspacePaneTitle";

describe("resolveWorkspacePaneThreadTitle", () => {
  it("uses the shell title when cached detail metadata is stale", () => {
    const staleDetail = { title: "this is a test, just return something simple" };

    expect(resolveWorkspacePaneThreadTitle(staleDetail, { title: "Simple Test" })).toBe(
      "Simple Test",
    );
  });

  it("falls back to detail while the shell is loading", () => {
    expect(resolveWorkspacePaneThreadTitle({ title: "Cached thread" }, null)).toBe("Cached thread");
  });

  it("has no title while both thread records are loading", () => {
    expect(resolveWorkspacePaneThreadTitle(null, null)).toBeNull();
  });
});
