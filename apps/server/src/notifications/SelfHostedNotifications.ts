// @effect-diagnostics nodeBuiltinImport:off -- APNs requires native HTTP/2 and ES256 P1363 signatures.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import {
  RelayAgentActivityAggregateState,
  type RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateType,
  type RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
  type RelayDeviceRegistrationRequest as RelayDeviceRegistrationRequestType,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as InputNotificationDelay from "./InputNotificationDelay.ts";

import { readRunClientOrigin } from "./turnClientOrigin.ts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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

export class SelfHostedNotificationError extends Schema.TaggedError<SelfHostedNotificationError>()(
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
  readonly inputReady?: boolean;
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
        return input.inputReady === true && input.registration.device.preferences.notifyOnInput;
      case "completed":
      case "failed": {
        const updatedAt = Option.match(DateTime.make(candidate.updatedAt), {
          onNone: () => null,
          onSome: (dateTime) => dateTime.epochMilliseconds,
        });
        const enabled =
          candidate.phase === "completed"
            ? (input.registration.device.preferences.notifyOnCompletion ||
                input.registration.device.preferences.notifyOnIosCompletion === true) &&
              input.iosCompletionThreads?.has(candidate.threadId) === true
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

export function makeNotificationPayload(
  notification: NonNullable<ReturnType<typeof notificationForTransition>>,
) {
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: "default",
      "thread-id": `${notification.row.environmentId}:${notification.row.threadId}`,
    },
    environmentId: notification.row.environmentId,
    threadId: notification.row.threadId,
    deepLink: notification.row.deepLink,
  };
}

function base64UrlJson(value: unknown): string {
  return Base64Url.encode(encodeUnknownJson(value));
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
  const jwt = `${signingInput}.${Base64Url.encode(signature)}`;
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
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
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
    const [snapshot, projectSnapshot] = yield* Effect.all([
      threads.getShellSnapshot(),
      projects.snapshot,
    ]);
    const projectById = new Map(projectSnapshot.projects.map((project) => [project.id, project]));
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
    readyInputRequestId?: string,
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
    // Read the projection after credentials/registration, immediately before APNs.
    // The timer can be due while the worker still has a response event queued.
    if (readyInputRequestId !== undefined) {
      if (!nextThread) return;
      const current = yield* threads.getThreadShell(nextThread.threadId);
      if (!InputNotificationDelay.isDue(current, readyInputRequestId, now.epochMilliseconds))
        return;
    }
    const notification = notificationForTransition({
      inputReady: readyInputRequestId !== undefined,
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
      Effect.Effect<
        { readonly kind: "device" | "activity"; readonly result: ApnsResult },
        Cause.UnknownError
      >
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
            payload: makeNotificationPayload(notification),
          }).then((result) => ({ kind: "device" as const, result })),
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

  const inputDelay = yield* InputNotificationDelay.make(
    (threadId, requestId): Effect.Effect<void> => worker.enqueue({ threadId, requestId }),
  );

  const publishThreadUnsafe = Effect.fn("SelfHostedNotifications.publishThreadUnsafe")(function* (
    threadId: ThreadId,
    readyInputRequestId?: string,
  ) {
    if ((yield* readCredentials) === null) return;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const shell = yield* threads.getThreadShell(threadId);
    const thread = shell === null || shell.archivedAt !== null ? Option.none() : Option.some(shell);
    const project = Option.isSome(thread)
      ? yield* projects.getById(thread.value.projectId)
      : Option.none();
    const snapshot = resolveAgentAwarenessRelayPublishSnapshot({
      environmentId,
      threadId,
      thread,
      project,
    });
    const inputRequest =
      Option.isSome(thread) && thread.value.pendingRuntimeRequest?.kind === "user_input"
        ? thread.value.pendingRuntimeRequest
        : null;
    yield* inputDelay.update(
      threadId,
      snapshot.state?.phase === "waiting_for_input" ? inputRequest : null,
    );
    const inputReady =
      readyInputRequestId !== undefined &&
      inputRequest?.id === readyInputRequestId &&
      snapshot.state?.phase === "waiting_for_input";
    const previousThread = (yield* Ref.get(statesRef)).get(threadId) ?? null;
    const iosCompletionThreads = new Set<ThreadId>();
    if (
      snapshot.state?.phase === "completed" &&
      Option.isSome(thread) &&
      thread.value.latestRunId
    ) {
      const origin = yield* readRunClientOrigin(threadId, thread.value.latestRunId).pipe(
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
    if (inputReady || encodeUnknownJson(previousThread) !== encodeUnknownJson(snapshot.state)) {
      yield* deliver(
        next,
        inputReady ? null : previousThread,
        snapshot.state,
        iosCompletionThreads,
        inputReady ? readyInputRequestId : undefined,
      );
    }
  });
  const publishThread = (threadId: ThreadId, readyInputRequestId?: string) =>
    publishThreadUnsafe(threadId, readyInputRequestId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("self-hosted notification publish failed", { threadId, cause }),
      ),
    );
  const worker = yield* makeDrainableWorker((item: { threadId: ThreadId; requestId?: string }) =>
    publishThread(item.threadId, item.requestId),
  );

  const publicOperation = <A, E>(
    operation: typeof SelfHostedNotificationOperation.Type,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, SelfHostedNotificationError> =>
    effect.pipe(Effect.mapError((cause) => new SelfHostedNotificationError({ operation, cause })));

  const hydrate = Effect.gen(function* () {
    if ((yield* readCredentials) === null) return;
    const states = yield* readProjectedStates;
    yield* Ref.set(statesRef, states);
    for (const state of states.values()) {
      if (state.phase === "waiting_for_input") yield* worker.enqueue({ threadId: state.threadId });
    }
  });

  const start = Effect.fn("SelfHostedNotifications.start")(function* () {
    yield* forkParked(hydrate);
    yield* forkParked(
      Stream.runForEach(threads.streamDomainEvents, (event: OrchestrationV2DomainEvent) => {
        const threadId = eventThreadId(event);
        return threadId !== null && shouldPublishAgentAwarenessEvent(event)
          ? worker.enqueue({ threadId })
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
