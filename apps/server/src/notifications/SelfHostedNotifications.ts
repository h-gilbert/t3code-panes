import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import {
  RelayAgentActivityAggregateState,
  type RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateType,
  type RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
  type RelayDeviceRegistrationRequest as RelayDeviceRegistrationRequestType,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { readTurnClientOrigin } from "./turnClientOrigin.ts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  eventThreadId,
  resolveAgentAwarenessRelayPublishSnapshot,
  shouldPublishAgentAwarenessEvent,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  APNS_BUNDLE_ID_SECRET,
  APNS_DEVICE_REGISTRATION_SECRET,
  APNS_ENVIRONMENT_SECRET,
  APNS_KEY_ID_SECRET,
  APNS_PRIVATE_KEY_SECRET,
  APNS_TEAM_ID_SECRET,
} from "./config.ts";

export {
  APNS_BUNDLE_ID_SECRET,
  APNS_DEVICE_REGISTRATION_SECRET,
  APNS_ENVIRONMENT_SECRET,
  APNS_KEY_ID_SECRET,
  APNS_PRIVATE_KEY_SECRET,
  APNS_TEAM_ID_SECRET,
} from "./config.ts";

const StoredRegistration = Schema.Struct({
  device: RelayDeviceRegistrationRequest,
  activityPushToken: Schema.NullOr(Schema.String),
  lastAggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  lastDeliveryAt: Schema.NullOr(Schema.String),
});
type StoredRegistration = typeof StoredRegistration.Type;

const decodeStoredRegistration = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredRegistration),
);
const encodeStoredRegistration = Schema.encodeEffect(Schema.fromJsonString(StoredRegistration));
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeAggregateJson = Schema.encodeSync(
  Schema.fromJsonString(Schema.NullOr(RelayAgentActivityAggregateState)),
);
const decodeApnsResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.optional(Schema.String) })),
);

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: "sandbox" | "production";
}

export interface ApnsResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason: string | null;
}

const SelfHostedNotificationOperation = Schema.Literals([
  "read-configuration",
  "read-registration",
  "register-device",
  "unregister-device",
  "register-live-activity",
  "read-aggregate",
]);

export class SelfHostedNotificationError extends Schema.TaggedErrorClass<SelfHostedNotificationError>()(
  "SelfHostedNotificationError",
  {
    operation: SelfHostedNotificationOperation,
    cause: Schema.Defect(),
  },
) {}

export class SelfHostedNotifications extends Context.Service<
  SelfHostedNotifications,
  {
    readonly configured: Effect.Effect<boolean, SelfHostedNotificationError>;
    readonly getRegistration: Effect.Effect<StoredRegistration | null, SelfHostedNotificationError>;
    readonly registerDevice: (
      device: RelayDeviceRegistrationRequestType,
    ) => Effect.Effect<RelayAgentActivityAggregateStateType | null, SelfHostedNotificationError>;
    readonly unregisterDevice: (
      deviceId: string,
    ) => Effect.Effect<RelayAgentActivityAggregateStateType | null, SelfHostedNotificationError>;
    readonly registerLiveActivity: (input: {
      readonly deviceId: string;
      readonly activityPushToken: string;
    }) => Effect.Effect<RelayAgentActivityAggregateStateType | null, SelfHostedNotificationError>;
    readonly getAggregate: Effect.Effect<
      RelayAgentActivityAggregateStateType | null,
      SelfHostedNotificationError
    >;
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/notifications/SelfHostedNotifications") {}

const TERMINAL_DISPLAY_TTL_MS = 15 * 60 * 1_000;
const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;
const MAX_ACTIVITY_ROWS = 5;

function isTerminal(state: RelayAgentActivityState): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

function stateTimeMs(state: RelayAgentActivityState): number | null {
  return Option.match(DateTime.make(state.updatedAt), {
    onNone: () => null,
    onSome: (dateTime) => dateTime.epochMilliseconds,
  });
}

function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRow(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

export function makeEnvironmentAggregate(
  states: ReadonlyArray<RelayAgentActivityState>,
  nowMs: number,
): RelayAgentActivityAggregateStateType | null {
  const active = states.filter((state) => !isTerminal(state));
  const recentTerminal = states
    .filter((state) => {
      const updatedAt = stateTimeMs(state);
      return (
        isTerminal(state) && updatedAt !== null && nowMs - updatedAt <= TERMINAL_DISPLAY_TTL_MS
      );
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const displayed = [...active, ...recentTerminal].slice(0, MAX_ACTIVITY_ROWS);
  const newest = displayed.reduce<RelayAgentActivityState | null>(
    (latest, state) =>
      latest === null || state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
    null,
  );
  if (newest === null) {
    return null;
  }
  return {
    title: "T3 Code",
    subtitle:
      active.length > 0
        ? "Agent work in progress"
        : newest.phase === "failed"
          ? "Agent work failed"
          : "Agent work completed",
    activeCount: active.length,
    updatedAt: newest.updatedAt,
    activities: displayed.map(aggregateRow),
  };
}

export function notificationForTransition(input: {
  readonly iosCompletionThreads?: ReadonlySet<ThreadId>;
  readonly previous: RelayAgentActivityAggregateStateType | null;
  readonly next: RelayAgentActivityAggregateStateType | null;
  readonly registration: StoredRegistration;
  readonly nowMs: number;
}): {
  readonly title: string;
  readonly body: string;
  readonly row: RelayAgentActivityAggregateStateType["activities"][number];
} | null {
  if (!input.registration.device.preferences.notificationsEnabled || input.next === null) {
    return null;
  }
  const previousPhaseByThread = new Map(
    input.previous?.activities.map((row) => [row.threadId, row.phase]) ?? [],
  );
  const row = input.next.activities.find((candidate) => {
    const previousPhase = previousPhaseByThread.get(candidate.threadId);
    if (previousPhase === candidate.phase) return false;
    switch (candidate.phase) {
      case "waiting_for_approval":
        return input.registration.device.preferences.notifyOnApproval;
      case "waiting_for_input":
        return input.registration.device.preferences.notifyOnInput;
      case "completed":
      case "failed": {
        const updatedAt = Option.match(DateTime.make(candidate.updatedAt), {
          onNone: () => null,
          onSome: (dateTime) => dateTime.epochMilliseconds,
        });
        const enabled =
          candidate.phase === "completed"
            ? input.registration.device.preferences.notifyOnCompletion ||
              (input.registration.device.preferences.notifyOnIosCompletion === true &&
                input.iosCompletionThreads?.has(candidate.threadId) === true)
            : input.registration.device.preferences.notifyOnFailure;
        return (
          enabled &&
          previousPhase !== undefined &&
          previousPhase !== "completed" &&
          previousPhase !== "failed" &&
          updatedAt !== null &&
          input.nowMs - updatedAt <= TERMINAL_NOTIFICATION_FRESHNESS_MS
        );
      }
      default:
        return false;
    }
  });
  return row ? { title: row.threadTitle, body: `${row.status}: ${row.projectTitle}`, row } : null;
}

function base64UrlJson(value: unknown): string {
  return Encoding.encodeBase64Url(encodeUnknownJson(value));
}

let cachedProviderToken: {
  readonly key: string;
  readonly issuedAt: number;
  readonly jwt: string;
} | null = null;

export function makeApnsProviderToken(credentials: ApnsCredentials, nowSeconds: number): string {
  const issuedAt = Math.floor(nowSeconds / (45 * 60)) * (45 * 60);
  const privateKey = Redacted.value(credentials.privateKey).replace(/\\n/g, "\n");
  const key = `${credentials.teamId}:${credentials.keyId}:${NodeCrypto.createHash("sha256")
    .update(privateKey)
    .digest("hex")}`;
  if (cachedProviderToken?.key === key && cachedProviderToken.issuedAt === issuedAt) {
    return cachedProviderToken.jwt;
  }
  const header = base64UrlJson({ alg: "ES256", kid: credentials.keyId });
  const payload = base64UrlJson({ iss: credentials.teamId, iat: issuedAt });
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const jwt = `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
  cachedProviderToken = { key, issuedAt, jwt };
  return jwt;
}

export function sendApns(input: {
  readonly credentials: ApnsCredentials;
  readonly token: string;
  readonly pushType: "alert" | "liveactivity";
  readonly payload: unknown;
  readonly priority: "5" | "10";
  readonly nowSeconds: number;
}): Promise<ApnsResult> {
  const host =
    input.credentials.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  const providerToken = makeApnsProviderToken(input.credentials, input.nowSeconds);
  return new Promise((resolve, reject) => {
    const session = NodeHttp2.connect(host);
    let settled = false;
    const finish = (result: ApnsResult) => {
      if (settled) return;
      settled = true;
      session.close();
      resolve(result);
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      session.destroy();
      reject(cause);
    };
    session.once("error", fail);
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${input.token}`,
      authorization: `bearer ${providerToken}`,
      "apns-priority": input.priority,
      "apns-push-type": input.pushType,
      "apns-topic":
        input.pushType === "liveactivity"
          ? `${input.credentials.bundleId}.push-type.liveactivity`
          : input.credentials.bundleId,
      "content-type": "application/json",
    });
    let status = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("error", fail);
    request.on("end", () => {
      let reason: string | null = null;
      if (body.trim()) {
        reason = Option.match(decodeApnsResponse(body), {
          onNone: () => body,
          onSome: (parsed) => parsed.reason ?? body,
        });
      }
      finish({ ok: status >= 200 && status < 300, status, reason });
    });
    request.end(encodeUnknownJson(input.payload));
  });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const statesRef = yield* Ref.make(new Map<ThreadId, RelayAgentActivityState>());

  const readSecret = (name: string) =>
    secrets
      .get(name)
      .pipe(
        Effect.map((value) =>
          Option.isSome(value) ? new TextDecoder().decode(value.value).trim() || null : null,
        ),
      );
  const writeRegistration = (registration: StoredRegistration | null) =>
    registration === null
      ? secrets.remove(APNS_DEVICE_REGISTRATION_SECRET)
      : encodeStoredRegistration(registration).pipe(
          Effect.flatMap((json) =>
            secrets.set(APNS_DEVICE_REGISTRATION_SECRET, new TextEncoder().encode(json)),
          ),
        );
  const getRegistration = secrets.get(APNS_DEVICE_REGISTRATION_SECRET).pipe(
    Effect.map((value) => {
      if (Option.isNone(value)) return null;
      return Option.getOrNull(decodeStoredRegistration(new TextDecoder().decode(value.value)));
    }),
  );
  const readCredentials = Effect.gen(function* () {
    const [teamId, keyId, privateKey, bundleId, environment] = yield* Effect.all([
      readSecret(APNS_TEAM_ID_SECRET),
      readSecret(APNS_KEY_ID_SECRET),
      readSecret(APNS_PRIVATE_KEY_SECRET),
      readSecret(APNS_BUNDLE_ID_SECRET),
      readSecret(APNS_ENVIRONMENT_SECRET),
    ]);
    if (
      !teamId ||
      !keyId ||
      !privateKey ||
      !bundleId ||
      (environment !== "sandbox" && environment !== "production")
    ) {
      return null;
    }
    return {
      teamId,
      keyId,
      privateKey: Redacted.make(privateKey),
      bundleId,
      environment,
    } satisfies ApnsCredentials;
  });
  const getAggregateFromRef = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return makeEnvironmentAggregate(
      [...(yield* Ref.get(statesRef)).values()],
      now.epochMilliseconds,
    );
  });
  const readProjectedStates = Effect.gen(function* () {
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
    const states = new Map<ThreadId, RelayAgentActivityState>();
    for (const thread of snapshot.threads) {
      const project = projectById.get(thread.projectId);
      if (!project) continue;
      const projected = resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId: thread.id,
        thread: Option.some(thread),
        project: Option.some(project),
      }).state;
      if (projected !== null) states.set(thread.id, projected);
    }
    return states;
  });
  const getAggregate = Effect.gen(function* () {
    const [states, now] = yield* Effect.all([readProjectedStates, DateTime.now]);
    return makeEnvironmentAggregate([...states.values()], now.epochMilliseconds);
  });

  const deliver = Effect.fn("SelfHostedNotifications.deliver")(function* (
    next: RelayAgentActivityAggregateStateType | null,
    previousThread: RelayAgentActivityState | null,
    nextThread: RelayAgentActivityState | null,
    iosCompletionThreads: ReadonlySet<ThreadId>,
  ) {
    const [registration, credentials, now] = yield* Effect.all([
      getRegistration,
      readCredentials,
      DateTime.now,
    ]);
    if (registration === null || credentials === null) return;
    const targetCredentials = {
      ...credentials,
      bundleId: registration.device.bundleId ?? credentials.bundleId,
      environment: registration.device.apsEnvironment ?? credentials.environment,
    };
    const notification = notificationForTransition({
      iosCompletionThreads,
      previous: makeEnvironmentAggregate(
        previousThread ? [previousThread] : [],
        now.epochMilliseconds,
      ),
      next: makeEnvironmentAggregate(nextThread ? [nextThread] : [], now.epochMilliseconds),
      registration,
      nowMs: now.epochMilliseconds,
    });
    const deliveries: Array<
      Effect.Effect<{ readonly kind: "device" | "activity"; readonly result: ApnsResult }>
    > = [];
    if (notification && registration.device.pushToken) {
      deliveries.push(
        Effect.tryPromise(() =>
          sendApns({
            credentials: targetCredentials,
            token: registration.device.pushToken!,
            pushType: "alert",
            priority: "10",
            nowSeconds: Math.floor(now.epochMilliseconds / 1_000),
            payload: {
              aps: {
                alert: { title: notification.title, body: notification.body },
                sound: "default",
              },
              environmentId: notification.row.environmentId,
              threadId: notification.row.threadId,
              deepLink: notification.row.deepLink,
            },
          }).then((result) => ({ kind: "device" as const, result })),
        ),
      );
    }
    if (registration.activityPushToken && registration.device.preferences.liveActivitiesEnabled) {
      const event = next === null || next.activeCount === 0 ? "end" : "update";
      const aps =
        event === "end"
          ? {
              timestamp: Math.floor(now.epochMilliseconds / 1_000),
              event,
              ...(next
                ? { "content-state": { name: "AgentActivity", props: encodeAggregateJson(next) } }
                : {}),
              "dismissal-date": Math.floor(now.epochMilliseconds / 1_000) + 5 * 60,
            }
          : {
              timestamp: Math.floor(now.epochMilliseconds / 1_000),
              event,
              "content-state": { name: "AgentActivity", props: encodeAggregateJson(next) },
              "stale-date": Math.floor(now.epochMilliseconds / 1_000) + 10 * 60,
            };
      deliveries.push(
        Effect.tryPromise(() =>
          sendApns({
            credentials: targetCredentials,
            token: registration.activityPushToken!,
            pushType: "liveactivity",
            priority: notification ? "10" : "5",
            nowSeconds: Math.floor(now.epochMilliseconds / 1_000),
            payload: { aps },
          }).then((result) => ({ kind: "activity" as const, result })),
        ),
      );
    }
    const results = yield* Effect.all(deliveries, { concurrency: 2 });
    for (const { kind, result } of results) {
      if (!result.ok) {
        yield* Effect.logWarning("self-hosted APNs delivery rejected", {
          kind,
          status: result.status,
          reason: result.reason,
        });
      }
    }
    const activityResult = results.find(({ kind }) => kind === "activity")?.result;
    const activityEnded = (next === null || next.activeCount === 0) && activityResult?.ok === true;
    const permanentDeviceRejection = results.some(
      ({ kind, result }) =>
        kind === "device" &&
        !result.ok &&
        (result.reason === "BadDeviceToken" ||
          result.reason === "DeviceTokenNotForTopic" ||
          result.reason === "Unregistered"),
    );
    const permanentActivityRejection = results.some(
      ({ kind, result }) =>
        kind === "activity" &&
        !result.ok &&
        (result.reason === "BadDeviceToken" ||
          result.reason === "DeviceTokenNotForTopic" ||
          result.reason === "Unregistered"),
    );
    yield* writeRegistration({
      ...registration,
      device: permanentDeviceRejection
        ? { ...registration.device, pushToken: undefined }
        : registration.device,
      activityPushToken:
        activityEnded || permanentActivityRejection ? null : registration.activityPushToken,
      lastAggregate: next,
      lastDeliveryAt: DateTime.formatIso(now),
    });
  });

  const publishThreadUnsafe = Effect.fn("SelfHostedNotifications.publishThreadUnsafe")(function* (
    threadId: ThreadId,
  ) {
    if ((yield* readCredentials) === null) return;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const thread = yield* snapshotQuery.getThreadShellById(threadId);
    const project = Option.isSome(thread)
      ? yield* snapshotQuery.getProjectShellById(thread.value.projectId)
      : Option.none();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      threadId,
      thread,
      project,
    });
    const previousThread = (yield* Ref.get(statesRef)).get(threadId) ?? null;
    const iosCompletionThreads = new Set<ThreadId>();
    if (snapshot.state?.phase === "completed" && Option.isSome(thread) && thread.value.latestTurn) {
      const origin = yield* readTurnClientOrigin(threadId, thread.value.latestTurn.turnId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (origin === "ios") iosCompletionThreads.add(threadId);
    }
    yield* Ref.update(statesRef, (states) => {
      const next = new Map(states);
      if (snapshot.state === null) next.delete(threadId);
      else next.set(threadId, snapshot.state);
      return next;
    });
    const next = yield* getAggregateFromRef;
    if (encodeUnknownJson(previousThread) !== encodeUnknownJson(snapshot.state)) {
      yield* deliver(next, previousThread, snapshot.state, iosCompletionThreads);
    }
  });
  const publishThread = (threadId: ThreadId) =>
    publishThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("self-hosted notification publish failed", { threadId, cause }),
      ),
    );
  const worker = yield* makeDrainableWorker(publishThread);

  const publicOperation = <A, E>(
    operation: typeof SelfHostedNotificationOperation.Type,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, SelfHostedNotificationError> =>
    effect.pipe(Effect.mapError((cause) => new SelfHostedNotificationError({ operation, cause })));

  const hydrate = Effect.gen(function* () {
    if ((yield* readCredentials) === null) return;
    const states = yield* readProjectedStates;
    yield* Ref.set(statesRef, states);
  });

  const start = Effect.fn("SelfHostedNotifications.start")(function* () {
    yield* forkParked(hydrate);
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) => {
        const threadId = eventThreadId(event);
        return threadId !== null && shouldPublishAgentAwarenessEvent(event)
          ? worker.enqueue(threadId)
          : Effect.void;
      }),
    );
  });

  return SelfHostedNotifications.of({
    configured: publicOperation(
      "read-configuration",
      readCredentials.pipe(Effect.map((credentials) => credentials !== null)),
    ),
    getRegistration: publicOperation("read-registration", getRegistration),
    registerDevice: (device) =>
      publicOperation(
        "register-device",
        Effect.gen(function* () {
          const current = yield* getRegistration;
          yield* writeRegistration({
            device,
            activityPushToken:
              current?.device.deviceId === device.deviceId ? current.activityPushToken : null,
            lastAggregate: current?.lastAggregate ?? null,
            lastDeliveryAt: current?.lastDeliveryAt ?? null,
          });
          return yield* getAggregate;
        }),
      ),
    unregisterDevice: (deviceId) =>
      publicOperation(
        "unregister-device",
        Effect.gen(function* () {
          const current = yield* getRegistration;
          if (current?.device.deviceId === deviceId) yield* writeRegistration(null);
          return yield* getAggregate;
        }),
      ),
    registerLiveActivity: (input) =>
      publicOperation(
        "register-live-activity",
        Effect.gen(function* () {
          const current = yield* getRegistration;
          if (current?.device.deviceId === input.deviceId) {
            yield* writeRegistration({ ...current, activityPushToken: input.activityPushToken });
          }
          return yield* getAggregate;
        }),
      ),
    getAggregate: publicOperation("read-aggregate", getAggregate),
    publishThread,
    start,
  });
});

export const layer = Layer.effect(SelfHostedNotifications, make);
