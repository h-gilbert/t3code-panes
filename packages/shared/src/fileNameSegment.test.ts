import { describe, expect, it } from "@effect/vitest";

import { safeFileNameSegment } from "./fileNameSegment.ts";

describe("safeFileNameSegment", () => {
  it("keeps one path segment without control characters", () => {
    expect(safeFileNameSegment("../../etc/passwd")).toBe("passwd");
    expect(safeFileNameSegment("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(safeFileNameSegment("bad\u0000name\u007f.txt")).toBe("badname.txt");
    expect(safeFileNameSegment("..", "download")).toBe("download");
    expect(safeFileNameSegment("   ")).toBe("file");
  });
});
