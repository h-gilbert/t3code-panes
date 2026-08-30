import { describe, expect, it } from "vite-plus/test";

import { resolveWorkspaceGridColumnCount } from "./workspacePaneLayout";
import { WORKSPACE_PANE_COUNTS } from "./workspacePaneStore";

describe("resolveWorkspaceGridColumnCount", () => {
  it("uses compact landscape grids for every supported pane count", () => {
    const columnsByPaneCount = WORKSPACE_PANE_COUNTS.map((paneCount) =>
      resolveWorkspaceGridColumnCount(paneCount),
    );

    expect(columnsByPaneCount).toEqual([1, 2, 2, 2, 3, 3, 4, 4, 3]);
  });
});
