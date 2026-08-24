import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldBlockThreadArchive, ThreadArchiveBlockedError } from "./useThreadActions";

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive a running thread.");
  });
});

describe("shouldBlockThreadArchive", () => {
  const runningSession = { status: "running", activeTurnId: "turn-1" };

  it("keeps ordinary archive from hiding active work", () => {
    expect(shouldBlockThreadArchive(runningSession)).toBe(true);
  });

  it("allows the explicit finish action to archive and stop active work", () => {
    expect(shouldBlockThreadArchive(runningSession, { allowRunning: true })).toBe(false);
  });

  it("allows an idle session to be archived normally", () => {
    expect(shouldBlockThreadArchive({ status: "ready", activeTurnId: null })).toBe(false);
  });
});
