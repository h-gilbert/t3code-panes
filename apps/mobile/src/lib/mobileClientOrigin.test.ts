import { describe, expect, it } from "vite-plus/test";

import { resolveMobileCreationSource } from "./mobileClientOrigin";

describe("mobile turn origin", () => {
  it.each([undefined, null, {}, { iosTurnOrigin: false }])(
    "uses the stock mobile origin when the destination does not advertise support: %j",
    (capabilities) => {
      expect(resolveMobileCreationSource(capabilities, "ios")).toBe("mobile");
    },
  );

  it("selects each destination independently for queued follow-ups", () => {
    const capable = { iosTurnOrigin: true };
    expect(resolveMobileCreationSource(capable, "ios")).toBe("ios");
    expect(resolveMobileCreationSource({}, "ios")).toBe("mobile");
    expect(resolveMobileCreationSource(capable, "ios")).toBe("ios");
  });

  it("keeps Android under mobile even on a capable server", () => {
    expect(resolveMobileCreationSource({ iosTurnOrigin: true }, "android")).toBe("mobile");
  });
});
