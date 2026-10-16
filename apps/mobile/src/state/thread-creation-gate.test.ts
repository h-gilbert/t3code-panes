import {
  EnvironmentId,
  ThreadId,
  MessageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createThreadCreationGatedStateAtoms } from "./thread-creation-gate";
import type { PendingThreadCreationOutcome } from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Investigate the alert",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "local",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-10-15T08:33:55.000Z",
};
const key = `${message.environmentId}:${message.threadId}`;

function harness(creation = true) {
  const registry = AtomRegistry.make();
  const queued = Atom.make<Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>>({
    [key]: [creation ? message : { ...message, creation: undefined }],
  });
  const outcomes = Atom.make<Readonly<Record<string, PendingThreadCreationOutcome>>>({});
  const shell = Atom.make<{ readonly id: ThreadId } | null>(null);
  let subscriptions = 0;
  const live = AsyncResult.success({ ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "live" as const });
  const state = Atom.make(() => {
    subscriptions++;
    return live;
  });
  const gated = createThreadCreationGatedStateAtoms({
    stateAtom: () => state,
    queuedMessagesAtom: queued,
    outcomesAtom: outcomes,
    shellAtom: () => shell,
  }).stateAtom(message.environmentId, message.threadId);
  const unmount = registry.mount(gated);
  return {
    registry,
    queued,
    outcomes,
    shell,
    gated,
    live,
    subscriptions: () => subscriptions,
    dispose: () => {
      unmount();
      registry.dispose();
    },
  };
}

describe("thread creation subscription gate", () => {
  it("does not request missing detail before creation, then loads when delivery completes", () => {
    const h = harness();
    try {
      expect(h.registry.get(h.gated)).toMatchObject({
        _tag: "Success",
        value: EMPTY_ENVIRONMENT_THREAD_STATE,
      });
      expect(h.subscriptions()).toBe(0);
      h.registry.set(h.outcomes, { [key]: { kind: "delivered", message } });
      expect(h.registry.get(h.gated)).toBe(h.live);
      expect(h.subscriptions()).toBe(1);
      h.registry.set(h.queued, {});
      expect(h.registry.get(h.gated)).toBe(h.live);
      expect(h.subscriptions()).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("loads once an authoritative shell arrives even while the outbox awaits acknowledgement", () => {
    const h = harness();
    try {
      expect(h.subscriptions()).toBe(0);
      h.registry.set(h.shell, { id: message.threadId });
      expect(h.registry.get(h.gated)).toBe(h.live);
      expect(h.subscriptions()).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("keeps failed creation unsubscribed after removal and starts on a successful retry", () => {
    const h = harness();
    try {
      h.registry.set(h.queued, {});
      expect(h.registry.get(h.gated)).toMatchObject({
        _tag: "Success",
        value: EMPTY_ENVIRONMENT_THREAD_STATE,
      });
      expect(h.subscriptions()).toBe(0);
      h.registry.set(h.outcomes, { [key]: { kind: "failed", message, reason: "Setup failed" } });
      expect(h.registry.get(h.gated)).toMatchObject({
        _tag: "Success",
        value: EMPTY_ENVIRONMENT_THREAD_STATE,
      });
      expect(h.subscriptions()).toBe(0);
      h.registry.set(h.queued, { [key]: [message] });
      h.registry.set(h.outcomes, { [key]: { kind: "delivered", message } });
      expect(h.registry.get(h.gated)).toBe(h.live);
      expect(h.subscriptions()).toBe(1);
    } finally {
      h.dispose();
    }
  });

  it("subscribes normally for existing threads without a local creation", () => {
    const h = harness(false);
    try {
      h.registry.set(h.queued, { [key]: [{ ...message, creation: undefined }] });
      expect(h.registry.get(h.gated)).toBe(h.live);
      expect(h.subscriptions()).toBe(1);
    } finally {
      h.dispose();
    }
  });
});
