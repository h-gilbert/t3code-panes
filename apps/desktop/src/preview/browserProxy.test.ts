import { describe, expect, it } from "vite-plus/test";
import { browserProxyConfig } from "./browserProxy.ts";

describe("browser proxy", () => {
  it("uses one SOCKS5 proxy for every destination without direct fallback", () => {
    expect(browserProxyConfig("socks5://127.0.0.1:1080")).toEqual({
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:1080",
      proxyBypassRules: "<-loopback>",
    });
  });
  it("restores system networking when cleared", () => {
    expect(browserProxyConfig("")).toEqual({ mode: "system" });
  });
  it.each([
    "direct://localhost:1080",
    "socks5://user:password@localhost:1080",
    "socks5://localhost",
    "http://localhost:1080/path",
    "http://localhost:1080?x=1",
    "http://localhost:1080#x",
    "socks5://localhost:1080,direct://",
  ])("rejects invalid proxy %s", (value) => {
    expect(() => browserProxyConfig(value)).toThrow();
  });
});
