import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { ConnectionAttemptError, SupervisorConnectionState } from "./model.ts";

export interface ConnectionDiagnosticEvent {
  readonly environmentId: string;
  readonly label: string;
  readonly kind: "state" | "signal" | "failure";
  readonly state: SupervisorConnectionState;
  readonly routes: ReadonlyArray<string>;
  readonly signal?: string;
  readonly failure?: ConnectionAttemptError;
}

export class ConnectionDiagnosticObserver extends Context.Reference<{
  readonly observe: (event: ConnectionDiagnosticEvent) => Effect.Effect<void>;
}>("@t3tools/client-runtime/connection/ConnectionDiagnosticObserver", {
  defaultValue: () => ({ observe: () => Effect.void }),
}) {}
