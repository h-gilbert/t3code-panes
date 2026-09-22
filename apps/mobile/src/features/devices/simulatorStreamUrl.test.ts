import { describe, expect, it } from "vite-plus/test";

import { simulatorStreamUrl } from "./simulatorStreamUrl";

describe("simulatorStreamUrl", () => {
  it("keeps the selected host and short-lived media ticket on the proxied stream", () => {
    expect(
      simulatorStreamUrl(
        {
          httpBase: "https://host.example/api/device-hub",
          wsBase: "wss://host.example/api/device-hub",
          query: { wsTicket: "ticket+value", hostId: "local" },
          credentials: false,
        },
        "SIM ID",
      ),
    ).toBe(
      "https://host.example/api/device-hub/vendor/serve-sim/helper/SIM%20ID/stream.mjpeg?wsTicket=ticket%2Bvalue&hostId=local",
    );
  });
});
