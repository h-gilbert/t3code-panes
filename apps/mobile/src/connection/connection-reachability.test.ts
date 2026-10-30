import { describe, expect, it, vi } from "vite-plus/test";
import { checkConnectionRoute } from "./connection-reachability";

describe("connection failure reachability check", () => {
  it("checks the public descriptor without credentials and verifies the environment", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ environmentId: "fred" })));
    const signal = new AbortController().signal;
    expect(
      await checkConnectionRoute(
        "https://user:pass@fred.example/ws?token=secret",
        "fred",
        signal,
        request,
      ),
    ).toMatchObject({ result: "responded", httpStatus: 200 });
    expect(request).toHaveBeenCalledWith("https://fred.example/.well-known/t3/environment", {
      signal,
      credentials: "omit",
      redirect: "error",
    });
  });

  it("distinguishes a network failure from an HTTP error or the wrong environment", async () => {
    const signal = new AbortController().signal;
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ environmentId: "other" })));
    expect(
      await checkConnectionRoute("https://fred.example", "fred", signal, request),
    ).toMatchObject({ result: "request-failed", error: "Network request failed" });
    expect(
      await checkConnectionRoute("https://fred.example", "fred", signal, request),
    ).toMatchObject({ result: "http-error", httpStatus: 503 });
    expect(
      await checkConnectionRoute("https://fred.example", "fred", signal, request),
    ).toMatchObject({ result: "unexpected-response" });
  });
});
