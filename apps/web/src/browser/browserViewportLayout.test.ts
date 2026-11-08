import { describe, expect, it } from "vite-plus/test";

import {
  fitWithin,
  resizeBrowserViewportFromRail,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";

describe("resolveBrowserViewportLayout", () => {
  it("preserves the last logical viewport when fitting a fill-mode surface", () => {
    expect(
      resolveFittedBrowserViewport({ _tag: "fill" }, { width: 320, height: 200, scale: 0.25 }),
    ).toEqual({ _tag: "freeform", width: 1280, height: 800 });
  });

  it("keeps the grabbed rail under the pointer across centered layout boundaries", () => {
    const available = { width: 1120, height: 818 };
    expect(
      resizeBrowserViewportFromRail(
        { width: 1120, height: 818 },
        { x: -100, y: -50 },
        available,
        1,
        "southeast",
      ),
    ).toEqual({ width: 920, height: 718 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 800, height: 600 },
        { x: 300, y: 0 },
        { width: 1200, height: 800 },
        1,
        "east",
      ),
    ).toEqual({ width: 1300, height: 600 });
    expect(
      resizeBrowserViewportFromRail(
        { width: 560, height: 409 },
        { x: -100, y: 0 },
        available,
        2,
        "east",
      ),
    ).toEqual({ width: 460, height: 409 });
  });
});

describe("fitWithin", () => {
  it.each([
    {
      size: { width: 2560, height: 1360 },
      bounds: { width: 1920, height: 969 },
      fit: { width: 1824, height: 969 },
    },
    {
      size: { width: 1100, height: 675 },
      bounds: { width: 1920, height: 969 },
      fit: { width: 1100, height: 675 },
    },
  ])(
    "keeps the shape of $size.width x $size.height within the host window",
    ({ size, bounds, fit }) => {
      expect(fitWithin(size, bounds)).toEqual(fit);
    },
  );
});
