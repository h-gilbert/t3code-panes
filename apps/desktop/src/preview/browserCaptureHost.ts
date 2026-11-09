export interface CaptureHostSize {
  readonly width: number;
  readonly height: number;
}

export interface CaptureHostBounds extends CaptureHostSize {
  readonly x: number;
  readonly y: number;
}

const MIN_SIZE: CaptureHostSize = { width: 1280, height: 800 };
// The server clamps viewer sizes to 4K, so a bigger host only costs memory.
const MAX_SIZE: CaptureHostSize = { width: 3840, height: 2160 };
const OFFSCREEN_GAP = 400;

/**
 * Chromium rasterizes a guest shrunk to fit its window at the shrunk scale, so the hidden host
 * grows to the largest page a viewer streams and sits left of every display, where nobody sees it.
 */
export function browserCaptureHostBounds(
  pages: Iterable<CaptureHostSize>,
  displays: ReadonlyArray<{ readonly x: number }>,
): CaptureHostBounds {
  let width = MIN_SIZE.width;
  let height = MIN_SIZE.height;
  for (const page of pages) {
    width = Math.max(width, Math.ceil(page.width));
    height = Math.max(height, Math.ceil(page.height));
  }
  width = Math.min(width, MAX_SIZE.width);
  height = Math.min(height, MAX_SIZE.height);
  const left = Math.min(0, ...displays.map((display) => display.x));
  return { x: left - width - OFFSCREEN_GAP, y: 0, width, height };
}
