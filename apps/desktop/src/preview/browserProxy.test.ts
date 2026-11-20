import { describe, expect, it, vi } from "vite-plus/test";
import { browserProxyConfig, setBrowserProxy } from "./browserProxy.ts";

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
  it("keeps a configured proxy when routing loopback and restores the tunnel when cleared", async () => {
    const setProxy = vi.fn(async (_config: Electron.ProxyConfig) => {});
    const closeAllConnections = vi.fn(async () => {});
    const session = { setProxy, closeAllConnections } as unknown as Electron.Session;
    const configured = browserProxyConfig("socks5://127.0.0.1:1080");
    const tunnel: Electron.ProxyConfig = {
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:1081",
      proxyBypassRules: "*,<-loopback>,169.254.0.0/16,fe80::/10",
    };

    await setBrowserProxy(session, "configured", configured);
    await setBrowserProxy(session, "loopback", tunnel);
    await setBrowserProxy(session, "configured", undefined);

    expect(setProxy.mock.calls).toEqual([[configured], [configured], [tunnel]]);
    expect(closeAllConnections).toHaveBeenCalledTimes(3);
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
