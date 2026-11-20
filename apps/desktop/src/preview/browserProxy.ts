import type { ProxyConfig, Session } from "electron";

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

interface BrowserProxyRoutes {
  configured: ProxyConfig | undefined;
  loopback: ProxyConfig | undefined;
  pending: Promise<void>;
}

const routesBySession = new WeakMap<Session, BrowserProxyRoutes>();
const systemProxy: ProxyConfig = { mode: "system" };

/** An explicit proxy covers all destinations. Removing it restores this session's loopback route. */
export function setBrowserProxy(
  session: Session,
  route: "configured" | "loopback",
  config: ProxyConfig | undefined,
): Promise<void> {
  let routes = routesBySession.get(session);
  if (!routes) {
    routes = { configured: undefined, loopback: undefined, pending: Promise.resolve() };
    routesBySession.set(session, routes);
  }
  const state = routes;
  const pending = state.pending
    .catch(() => {})
    .then(async () => {
      const effective =
        route === "configured" ? (config ?? state.loopback) : (state.configured ?? config);
      await session.setProxy(effective ?? systemProxy);
      await session.closeAllConnections();
      state[route] = config;
    });
  state.pending = pending;
  return pending;
}
