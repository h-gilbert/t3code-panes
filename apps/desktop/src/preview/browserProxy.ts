import type { ProxyConfig } from "electron";

/** A single proxy, with no DIRECT fallback or implicit localhost bypass. */
export function browserProxyConfig(value: string): ProxyConfig {
  if (!value.trim()) return { mode: "system" };
  const url = new URL(value);
  if (
    !["socks5:", "http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use a socks5, http or https proxy URL with a port and no credentials or path.",
    );
  return {
    mode: "fixed_servers",
    proxyRules: `${url.protocol}//${url.host}`,
    proxyBypassRules: "<-loopback>",
  };
}
