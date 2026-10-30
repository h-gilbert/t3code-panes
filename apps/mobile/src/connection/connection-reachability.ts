import { redactConnectionDetail } from "./connection-log";

export async function checkConnectionRoute(
  baseUrl: string,
  environmentId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<Readonly<Record<string, string | number>>> {
  const url = new URL(baseUrl);
  url.username = "";
  url.password = "";
  url.pathname = "/.well-known/t3/environment";
  url.search = "";
  url.hash = "";
  const route = url.origin;
  try {
    const response = await request(url.toString(), {
      signal,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) return { route, result: "http-error", httpStatus: response.status };
    const descriptor: unknown = await response.json();
    const matches =
      typeof descriptor === "object" &&
      descriptor !== null &&
      "environmentId" in descriptor &&
      descriptor.environmentId === environmentId;
    return {
      route,
      result: matches ? "responded" : "unexpected-response",
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      route,
      result: signal.aborted ? "cancelled" : "request-failed",
      error: redactConnectionDetail(
        error instanceof Error ? error.message : "Network request failed",
      ),
    };
  }
}
