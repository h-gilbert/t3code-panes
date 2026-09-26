import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { isPublishedT3Version } from "@t3tools/shared/releaseVersion";
import { resolveRemoteT3CliPackageSpec } from "@t3tools/ssh/command";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

export function resolveDesktopSshCliRunner(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly devRemoteEntryPath?: string | undefined;
  readonly serverVersion: string;
  readonly nodeEngineRange: string;
  readonly updateChannel: DesktopUpdateChannel;
}): RemoteT3RunnerOptions {
  if (input.isDevelopment && input.devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: input.devRemoteEntryPath,
      nodeEngineRange: input.nodeEngineRange,
    };
  }

  // In an unpackaged Electron run, appVersion can be Electron's version.
  // Only packaged published builds have a matching T3 release archive.
  if (input.isDevelopment || !isPublishedT3Version(input.appVersion)) {
    return {
      packageSpec: resolveRemoteT3CliPackageSpec({
        appVersion: input.isDevelopment ? input.serverVersion : input.appVersion,
        updateChannel: input.updateChannel,
        isDevelopment: input.isDevelopment,
      }),
      nodeEngineRange: input.nodeEngineRange,
    };
  }

  return { archiveVersion: input.appVersion };
}
