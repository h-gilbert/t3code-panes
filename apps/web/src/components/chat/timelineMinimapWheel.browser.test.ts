import { describe, expect, it, vi } from "vite-plus/test";

function setup() {
  const timeline = document.createElement("div");
  const minimap = document.createElement("div");
  Object.defineProperty(timeline, "clientHeight", { value: 500 });
  const scrollBy = vi.fn();
  timeline.scrollBy = scrollBy as typeof timeline.scrollBy;
  const seen: WheelEvent[] = [];
  timeline.addEventListener("wheel", (event) => seen.push(event));
  minimap.addEventListener("wheel", (event) => forwardWheelToTimeline(event, timeline));
  document.body.append(timeline, minimap);
  const wheel = (init: WheelEventInit) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "wheelDeltaY", { value: -(init.deltaY ?? 0) });
    minimap.dispatchEvent(event);
    return event;
  };
  return { timeline, minimap, scrollBy, seen, wheel };
}

describe("forwardWheelToTimeline forwarding", () => {
  it("replays the wheel on the timeline and scrolls it instead of the minimap", () => {
    const { timeline, scrollBy, seen, wheel } = setup();
    const original = wheel({ deltaY: -120, clientX: 20, clientY: 300 });

    expect(original.defaultPrevented).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.target).toBe(timeline);
    expect(seen[0]?.deltaY).toBe(-120);
    expect(seen[0]?.clientY).toBe(300);
    expect(scrollBy).toHaveBeenCalledWith({ top: -120 });
  });

  it.each([
    { deltaMode: WheelEvent.DOM_DELTA_LINE, top: 48 },
    { deltaMode: WheelEvent.DOM_DELTA_PAGE, top: 1500 },
  ])("converts delta mode $deltaMode to pixels", ({ deltaMode, top }) => {
    using _motion = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    const { scrollBy, wheel } = setup();
    wheel({ deltaY: 3, deltaMode });
    expect(scrollBy).toHaveBeenCalledWith({ top });
  });

  it("lets a timeline listener cancel the scroll", () => {
    const { timeline, scrollBy, wheel } = setup();
    timeline.addEventListener("wheel", (event) => event.preventDefault());
    wheel({ deltaY: 40 });
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it.each([{ deltaY: 40, ctrlKey: true }, { deltaX: 40 }])(
    "leaves pinch zoom and horizontal wheels alone: %j",
    (init) => {
      const { scrollBy, seen, wheel } = setup();
      expect(wheel(init).defaultPrevented).toBe(false);
      expect(seen).toHaveLength(0);
      expect(scrollBy).not.toHaveBeenCalled();
    },
  );
});

it.each([false, true])(
  "uses native marker scrolling only when the rail overflows: %s",
  (overflow) => {
    const { minimap, scrollBy, seen } = setup();
    const viewport = document.createElement("div");
    viewport.dataset.minimapScroll = "";
    Object.defineProperties(viewport, {
      clientHeight: { value: 160 },
      scrollHeight: { value: overflow ? 800 : 160 },
    });
    const strip = document.createElement("span");
    viewport.append(strip);
    minimap.append(viewport);
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    Object.defineProperty(event, "wheelDeltaY", { value: -80 });
    strip.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(!overflow);
    expect(scrollBy).toHaveBeenCalledTimes(overflow ? 0 : 1);
    expect(seen).toHaveLength(overflow ? 0 : 1);
  },
);
import { fakeTimers } from "../../../test/render";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";

function mountTimeline() {
  const timeline = document.createElement("div");
  timeline.style.cssText = "height: 200px; overflow-y: auto;";
  const content = document.createElement("div");
  content.style.height = "2000px";
  timeline.append(content);
  document.body.append(timeline);
  return Object.assign(timeline, { [Symbol.dispose]: () => timeline.remove() });
}

function wheel(deltaY: number, wheelDeltaY: number): WheelEvent {
  const init = { cancelable: true, deltaY, wheelDeltaY };
  return new WheelEvent("wheel", init);
}

describe("forwardWheelToTimeline", () => {
  it.each([
    ["macOS", -360],
    ["Linux and Windows", -120],
  ])("scrolls %s trackpad deltas immediately", (_platform, wheelDeltaY) => {
    using timeline = mountTimeline();
    forwardWheelToTimeline(wheel(120, wheelDeltaY), timeline);
    expect(timeline.scrollTop).toBe(120);
  });

  it("glides mouse wheel notches and accumulates them", () => {
    using timeline = mountTimeline();
    using _timers = fakeTimers();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    forwardWheelToTimeline(wheel(100, -120), timeline);
    expect(timeline.scrollTop).toBe(0);
    vi.advanceTimersByTime(75);
    expect(timeline.scrollTop).toBeGreaterThan(0);
    expect(timeline.scrollTop).toBeLessThan(200);
    vi.advanceTimersByTime(100);
    expect(timeline.scrollTop).toBe(200);
  });

  it("stops gliding when the user clicks or navigates", () => {
    using timeline = mountTimeline();
    using _timers = fakeTimers();
    forwardWheelToTimeline(wheel(100, -120), timeline);
    vi.advanceTimersByTime(50);
    timeline.scrollTop = 1000;
    window.dispatchEvent(new PointerEvent("pointerdown"));
    vi.advanceTimersByTime(200);
    expect(timeline.scrollTop).toBe(1000);
  });
});
