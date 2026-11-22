import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopEnvironmentBootstrap,
} from "@t3tools/contracts";

const DESKTOP_LOCAL_CONNECTION_ID_PREFIX = "local:";

export function desktopLocalConnectionId(backendId: string): string {
  return `${DESKTOP_LOCAL_CONNECTION_ID_PREFIX}${backendId}`;
}

export function isDesktopLocalConnectionTarget(
  target: ConnectionTarget,
): target is Extract<ConnectionTarget, { readonly _tag: "BearerConnectionTarget" }> {
  return (
    target._tag === "BearerConnectionTarget" &&
    target.connectionId.startsWith(DESKTOP_LOCAL_CONNECTION_ID_PREFIX)
  );
}

export function desktopLocalBackendId(target: ConnectionTarget): string | null {
  return isDesktopLocalConnectionTarget(target)
    ? target.connectionId.slice(DESKTOP_LOCAL_CONNECTION_ID_PREFIX.length)
    : null;
}

export type DesktopLocalBootstrapsRead =
  | {
      readonly _tag: "Success";
      readonly bootstraps: ReadonlyArray<DesktopEnvironmentBootstrap>;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export type DesktopSecondaryBootstrapsRead = DesktopLocalBootstrapsRead;

type BootstrapsBridge = Pick<DesktopBridge, "getLocalEnvironmentBootstraps">;

/** One synchronous IPC read of every desktop-local bootstrap, primary included. */
export function readDesktopLocalBootstrapsFrom(
  bridge: BootstrapsBridge | undefined,
): DesktopLocalBootstrapsRead {
  if (bridge === undefined) return { _tag: "Success", bootstraps: [] };
  try {
    return { _tag: "Success", bootstraps: bridge.getLocalEnvironmentBootstraps() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

export interface DesktopSecondaryBootstrapsReader {
  /** Pass a read already made this tick to avoid another IPC round trip. */
  readonly readResult: (read?: DesktopLocalBootstrapsRead) => DesktopSecondaryBootstrapsRead;
  readonly readSnapshot: () => ReadonlyArray<DesktopEnvironmentBootstrap>;
}

/** Empty reads clear the snapshot; failed reads retain platform registrations. */
export function createDesktopSecondaryBootstrapsReader(
  resolveBridge: () => BootstrapsBridge | undefined,
): DesktopSecondaryBootstrapsReader {
  let snapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

  const readResult = (
    read: DesktopLocalBootstrapsRead = readDesktopLocalBootstrapsFrom(resolveBridge()),
  ): DesktopSecondaryBootstrapsRead => {
    if (read._tag === "Failure") return read;
    const next = read.bootstraps.filter((entry) => entry.id !== PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (
      next.length !== snapshot.length ||
      next.some((entry, index) => {
        const previous = snapshot[index];
        return (
          previous === undefined ||
          entry.id !== previous.id ||
          entry.label !== previous.label ||
          entry.runningDistro !== previous.runningDistro ||
          entry.httpBaseUrl !== previous.httpBaseUrl ||
          entry.wsBaseUrl !== previous.wsBaseUrl ||
          entry.bootstrapToken !== previous.bootstrapToken
        );
      })
    ) {
      snapshot = next;
    }
    return { _tag: "Success", bootstraps: snapshot };
  };

  return {
    readResult,
    readSnapshot: () => {
      const result = readResult();
      return result._tag === "Success" ? result.bootstraps : snapshot;
    },
  };
}

const desktopSecondaryBootstrapsReader = createDesktopSecondaryBootstrapsReader(
  () => window.desktopBridge,
);

export function readDesktopLocalBootstraps(): DesktopLocalBootstrapsRead {
  return readDesktopLocalBootstrapsFrom(window.desktopBridge);
}

export function readDesktopSecondaryBootstrapsResult(
  read?: DesktopLocalBootstrapsRead,
): DesktopSecondaryBootstrapsRead {
  return desktopSecondaryBootstrapsReader.readResult(read);
}

export function readDesktopSecondaryBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return desktopSecondaryBootstrapsReader.readSnapshot();
}
