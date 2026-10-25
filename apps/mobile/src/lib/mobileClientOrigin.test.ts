import { describe, expect, it, vi } from "vite-plus/test";

import { resolveMobileCreationSource } from "./mobileClientOrigin";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

describe("mobile turn origin", () => {
  it.each([undefined, null, {}, { iosTurnOrigin: false }])(
    "uses the stock mobile origin when the destination does not advertise support: %j",
    (capabilities) => {
      expect(resolveMobileCreationSource(capabilities)).toBe("mobile");
    },
  );

  it("selects each destination independently for queued follow-ups", () => {
    const capable = { iosTurnOrigin: true };
    expect(resolveMobileCreationSource(capable)).toBe("ios");
    expect(resolveMobileCreationSource({})).toBe("mobile");
    expect(resolveMobileCreationSource(capable)).toBe("ios");
  });

  it("keeps Android under mobile even on a capable server", () => {
    expect(resolveMobileCreationSource({ iosTurnOrigin: true }, "android")).toBe("mobile");
  });
});
