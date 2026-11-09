import { describe, expect, it } from "vite-plus/test";

import { browserCaptureHostBounds } from "./browserCaptureHost.ts";

describe("browserCaptureHostBounds", () => {
  it("fits the largest streamed page, within the 4K cap, left of every display", () => {
    expect(
      browserCaptureHostBounds(
        [
          { width: 2337, height: 1210 },
          { width: 1402, height: 1577.4 },
        ],
        [{ x: 0 }, { x: -2560 }],
      ),
    ).toEqual({ x: -2560 - 2337 - 400, y: 0, width: 2337, height: 1578 });
    expect(browserCaptureHostBounds([{ width: 9000, height: 9000 }], [{ x: 0 }])).toEqual({
      x: -3840 - 400,
      y: 0,
      width: 3840,
      height: 2160,
    });
  });

  it("keeps a default size with no viewers", () => {
    expect(browserCaptureHostBounds([], [])).toEqual({ x: -1680, y: 0, width: 1280, height: 800 });
  });
});
