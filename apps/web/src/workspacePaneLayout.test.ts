import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkspaceGridColumnCount,
  resolveWorkspaceGridLeadRowSpan,
} from "./workspacePaneLayout";
import { WORKSPACE_PANE_COUNTS } from "./workspacePaneStore";

describe("resolveWorkspaceGridColumnCount", () => {
  it("uses compact landscape grids for every supported pane count", () => {
    const columnsByPaneCount = WORKSPACE_PANE_COUNTS.map((paneCount) =>
      resolveWorkspaceGridColumnCount(paneCount),
    );

    expect(columnsByPaneCount).toEqual([1, 2, 2, 2, 3, 3, 4, 4, 3]);
  });
});

describe("resolveWorkspaceGridLeadRowSpan", () => {
  it("stretches the first pane to fill the cell an uneven pane count leaves empty", () => {
    const spansByPaneCount = WORKSPACE_PANE_COUNTS.map((paneCount) =>
      resolveWorkspaceGridLeadRowSpan(paneCount),
    );

    expect(spansByPaneCount).toEqual([1, 1, 2, 1, 2, 1, 2, 1, 1]);
  });
});
