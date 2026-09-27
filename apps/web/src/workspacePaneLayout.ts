import type { WorkspacePaneCount } from "./workspacePaneStore";

export function resolveWorkspaceGridColumnCount(paneCount: WorkspacePaneCount): number {
  const squareColumns = Math.ceil(Math.sqrt(paneCount));
  let bestColumns = squareColumns;
  let fewestEmptyCells = squareColumns * squareColumns - paneCount;

  for (let rows = 1; rows <= squareColumns; rows += 1) {
    const columns = Math.ceil(paneCount / rows);
    if (columns < rows || columns > rows * 2) continue;

    const emptyCells = rows * columns - paneCount;
    if (emptyCells < fewestEmptyCells) {
      bestColumns = columns;
      fewestEmptyCells = emptyCells;
    }
  }

  return bestColumns;
}

// Rows the first grid pane spans so an uneven pane count fills the grid
// instead of leaving an empty cell, e.g. five panes become one tall pane
// beside a 2×2 grid.
export function resolveWorkspaceGridLeadRowSpan(paneCount: WorkspacePaneCount): number {
  const columns = resolveWorkspaceGridColumnCount(paneCount);
  const rows = Math.ceil(paneCount / columns);
  const emptyCells = rows * columns - paneCount;
  return emptyCells > 0 && emptyCells < rows ? emptyCells + 1 : 1;
}
