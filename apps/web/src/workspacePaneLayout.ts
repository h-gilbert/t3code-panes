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
