import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  resolveWorkspaceDraftThreadRef,
  resolveWorkspacePaneThreadTitle,
} from "./workspacePaneTitle";

describe("resolveWorkspacePaneThreadTitle", () => {
  it("uses the shell title when cached detail metadata is stale", () => {
    const staleDetail = { title: "this is a test, just return something simple" };

    expect(resolveWorkspacePaneThreadTitle(staleDetail, { title: "Simple Test" })).toBe(
      "Simple Test",
    );
  });

  it("falls back to detail while the shell is loading", () => {
    expect(resolveWorkspacePaneThreadTitle({ title: "Cached thread" }, null)).toBe("Cached thread");
  });

  it("has no title while both thread records are loading", () => {
    expect(resolveWorkspacePaneThreadTitle(null, null)).toBeNull();
  });
});

describe("resolveWorkspaceDraftThreadRef", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const threadId = ThreadId.make("thread-draft");

  it("discovers the server thread created from a workspace draft", () => {
    const threadRef = { environmentId, threadId };

    expect(
      resolveWorkspaceDraftThreadRef({ environmentId, threadId, promotedTo: null }, [
        {
          environmentId: EnvironmentId.make("environment-remote"),
          threadId,
        },
        threadRef,
      ]),
    ).toBe(threadRef);
  });

  it("uses the explicit promotion while the shell index catches up", () => {
    const promotedTo = { environmentId, threadId };

    expect(
      resolveWorkspaceDraftThreadRef(
        {
          environmentId,
          threadId: ThreadId.make("thread-old"),
          promotedTo,
        },
        [],
      ),
    ).toBe(promotedTo);
  });
});
