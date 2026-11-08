import {
  ConnectionDiagnosticObserver,
  type ConnectionDiagnosticEvent,
} from "@t3tools/client-runtime/connection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Network from "expo-network";
import { AppState, Platform } from "react-native";

import { connectionLogRecord, type ConnectionLogRecord } from "./connection-log";
import { connectionLog } from "./connection-log-store";
import { checkConnectionRoute } from "./connection-reachability";

const record = (entry: ConnectionLogRecord) => {
  void connectionLog.append(entry).catch(() => {
    console.warn("[connection-diagnostics] Could not save connection history.");
  });
};

export const layer = Layer.effect(
  ConnectionDiagnosticObserver,
  Effect.acquireRelease(
    Effect.sync(() => {
      let active = true;
      let previous: string | undefined;
      const checks = new Map<
        string,
        { controller: AbortController; timer: ReturnType<typeof setTimeout> }
      >();
      const lastCheck = new Map<string, number>();
      const network = (state: Network.NetworkState) => {
        if (!active) return;
        const fields = {
          type: state.type ?? "unknown",
          connected: state.isConnected ?? null,
          internetReachable: state.isInternetReachable ?? null,
          appState: AppState.currentState ?? "unknown",
        };
        const key = JSON.stringify(fields);
        if (key === previous) return;
        previous = key;
        record({
          timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
          kind: "network",
          environmentId: null,
          fields,
        });
      };
      const refresh = () =>
        void Network.getNetworkStateAsync()
          .then(network)
          .catch(() => {
            if (active)
              record({
                timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
                kind: "network-unavailable",
                environmentId: null,
                fields: {},
              });
          });
      const cancelChecks = () => {
        for (const check of checks.values()) {
          clearTimeout(check.timer);
          check.controller.abort();
        }
        checks.clear();
      };
      record({
        timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
        kind: "app-start",
        environmentId: null,
        fields: {
          appState: AppState.currentState ?? "unknown",
          os: Platform.OS,
          osVersion: String(Platform.Version),
        },
      });
      refresh();
      const networkSubscription = Network.addNetworkStateListener(network);
      const appSubscription = AppState.addEventListener("change", (state) => {
        record({
          timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
          kind: "app-state",
          environmentId: null,
          fields: { appState: state },
        });
        if (state === "active") refresh();
        else cancelChecks();
      });
      return {
        observe: (event: ConnectionDiagnosticEvent) =>
          Effect.sync(() => {
            if (!active) return;
            const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
            record(connectionLogRecord(event, DateTime.formatIso(DateTime.makeUnsafe(now))));
            if (
              event.kind !== "failure" ||
              AppState.currentState !== "active" ||
              now - (lastCheck.get(event.environmentId) ?? 0) < 60_000
            )
              return;
            lastCheck.set(event.environmentId, now);
            refresh();
            for (const baseUrl of [...new Set(event.routes)].slice(0, 3)) {
              const key = `${event.environmentId}:${baseUrl}`;
              const controller = new AbortController();
              let timedOut = false;
              // Native reachability requests outlive the observer Effect and are cancelled on app background.
              // @effect-diagnostics-next-line globalTimersInEffect:off
              const timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
              }, 5000);
              checks.set(key, { controller, timer });
              void checkConnectionRoute(baseUrl, event.environmentId, controller.signal)
                .then((result) => {
                  if (active)
                    record({
                      timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
                      kind: "reachability",
                      environmentId: event.environmentId,
                      fields: {
                        ...result,
                        label: event.label,
                        durationMs: DateTime.toEpochMillis(DateTime.nowUnsafe()) - now,
                        result: timedOut ? "timeout" : (result.result ?? "unknown"),
                      },
                    });
                })
                .catch(() => {
                  if (active)
                    record({
                      timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
                      kind: "reachability",
                      environmentId: event.environmentId,
                      fields: { result: "invalid-route" },
                    });
                })
                .finally(() => {
                  clearTimeout(timer);
                  checks.delete(key);
                });
            }
          }),
        close: () => {
          active = false;
          cancelChecks();
          networkSubscription.remove();
          appSubscription.remove();
        },
      };
    }),
    (observer) => Effect.sync(observer.close),
  ),
);
