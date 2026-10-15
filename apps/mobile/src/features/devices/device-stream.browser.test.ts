import { afterEach, expect, it, vi } from "vite-plus/test";
import { command, start, stop } from "./device-stream.browser";

class Element extends EventTarget {
  readonly style = {};
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  append() {}
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 400, height: 800 };
  }
  setPointerCapture() {}
  focus() {}
}

async function setup() {
  vi.useFakeTimers();
  const elements: Element[] = [];
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, replaceChildren() {} },
    createElement: (tag: string) => {
      const element = new Element(tag);
      elements.push(element);
      return element;
    },
  });
  const postMessage = vi.fn();
  vi.stubGlobal("window", { ReactNativeWebView: { postMessage }, addEventListener() {} });
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("prime")));
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const configuration = {
    platform: "ios" as const,
    deviceId: "fixture-device",
    access: {
      httpBase: "https://device.test",
      wsBase: "wss://device.test",
      credentials: false,
      query: {},
    },
    colors: {
      background: "white",
      foreground: "black",
      muted: "gray",
      buttonBackground: "gray",
      buttonForeground: "black",
      buttonBorder: "gray",
    },
  };
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  return {
    configuration,
    elements,
    sockets,
    messages: () =>
      postMessage.mock.calls.map(
        ([message]) => JSON.parse(message as string) as { type: string; status?: string },
      ),
  };
}

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bridges shared first-frame readiness, image failure, and a successful fresh attempt to native", async () => {
  const { elements, messages, sockets, configuration } = await setup();
  sockets[0]!.onopen?.();
  expect(messages()).not.toContainEqual({ type: "status", status: "streaming" });
  expect(messages()).not.toContainEqual({ type: "input", connected: true });
  sockets[0]!.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  expect(messages()).toContainEqual({ type: "input", connected: true });
  const image = elements.find((element) => element.tag === "img")!;
  image.naturalWidth = 400;
  image.naturalHeight = 800;
  await vi.advanceTimersByTimeAsync(250);
  expect(messages()).toContainEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(messages()).toContainEqual({
    type: "status",
    status: "error",
    detail: "Could not receive the device stream. Reconnect to try again.",
  });
  expect(messages()).toContainEqual({ type: "input", connected: false });
  expect(messages()).not.toContainEqual({ type: "unauthorized" });
  expect(image.src).toBe("");
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  const replacement = elements.findLast((element) => element.tag === "img")!;
  replacement.naturalWidth = 400;
  replacement.naturalHeight = 800;
  replacement.dispatchEvent(new Event("load"));
  expect(messages().at(-1)).toEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(sockets[1]!.close).not.toHaveBeenCalled();
  stop();
  expect(replacement.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("delivers admitted taps, swipes, and hardware buttons through the native viewer bridge", async () => {
  const { elements, sockets } = await setup();
  const socket = sockets[0]!;
  const frame = elements.filter((element) => element.tag === "div")[1]!;
  const pointer = (type: string, x: number, y: number) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 7, clientX: 10 + x * 400, clientY: 20 + y * 800 });
    frame.dispatchEvent(event);
  };
  pointer("pointerdown", 0.5, 0.6);
  pointer("pointerup", 0.5, 0.6);
  expect(socket.send).not.toHaveBeenCalled();
  socket.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  pointer("pointerdown", 0.5, 0.6);
  pointer("pointerup", 0.5, 0.6);
  pointer("pointerdown", 0.4, 0.8);
  pointer("pointermove", 0.4, 0.5);
  pointer("pointerup", 0.4, 0.2);
  command("home");
  const messages = socket.send.mock.calls.map(([data]) => ({
    tag: (data as Uint8Array)[0],
    payload: JSON.parse(new TextDecoder().decode((data as Uint8Array).subarray(1))),
  }));
  expect(messages).toEqual([
    { tag: 3, payload: { type: "begin", x: 0.5, y: 0.6 } },
    { tag: 3, payload: { type: "end", x: 0.5, y: 0.6 } },
    { tag: 3, payload: { type: "begin", x: 0.4, y: 0.8 } },
    { tag: 3, payload: { type: "move", x: 0.4, y: 0.5 } },
    { tag: 3, payload: { type: "end", x: 0.4, y: 0.2 } },
    { tag: 4, payload: { button: "home" } },
  ]);
});

it("reports simulator input failures instead of hiding them behind a working video stream", async () => {
  const { elements, sockets, messages } = await setup();
  const socket = sockets[0]!;
  socket.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  const config = new TextEncoder().encode(
    JSON.stringify({ width: 400, height: 800, orientation: "portrait", inputUnavailable: true }),
  );
  const frame = new Uint8Array(config.length + 1);
  frame[0] = 0x82;
  frame.set(config, 1);
  socket.onmessage?.({ data: frame.buffer });
  expect(messages()).toContainEqual({
    type: "input",
    connected: false,
    detail: "Simulator input is unavailable",
  });
  expect(elements.findLast((element) => element.tag === "div")).toMatchObject({
    textContent: "Simulator input is unavailable",
  });
});
