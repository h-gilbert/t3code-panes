import {
  type DeviceError,
  type DeviceHostId,
  type DeviceId,
  type DevicePlatform,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../../../config.ts";
import { ensureAgentDeviceShim } from "../../../device/AgentDeviceShim.ts";
import { nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";

import * as DeviceService from "../../../device/DeviceService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
  cloud = false,
): string {
  const executable = /^[a-zA-Z0-9_./:-]+$/.test(command)
    ? command
    : "'" + command.replaceAll("'", "'\"'\"'") + "'";
  const target = targetArgs
    .map((arg) =>
      /^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\"'\"'") + "'",
    )
    .join(" ");
  const platformNotes = cloud
    ? "This is an EAS Simulator session in the cloud. It bills the Expo account per minute until it stops, so call device_close with shutdown: true when you are done. It starts with no apps installed: install-from-source <url> installs a build from a URL (iOS needs a .tar.gz containing a .app), and install uploads one from this machine."
    : device.platform === "ios"
      ? device.physical
        ? "Physical iOS requires trust, Developer Mode, and a signed XCTest runner. Run this launcher's help physical-device for signing setup. Use the configured Apple Development team and respect the shared compilation lock. First use may build the runner; a missing runner is a setup step. Do not restart another thread's daemon to configure yours."
        : "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.";
  return [
    device.physical
      ? `Physical device: ${device.name} (${device.version}). Live video may be unavailable; continue with screenshots and snapshots.`
      : `Opened ${device.name} (${device.version}) for this thread.`,
    `Drive it with ${executable}. Use this exact executable path; login shells may reset PATH. Always pass ${target}.`,
    device.physical
      ? "Physical devices stay hidden in T3. Automation and screenshots remain available."
      : 'Call device_open again with presentation: "inset", "floating", "fullscreen", or "hidden" to change this thread\'s view without restarting the device. Default: inset. Hidden keeps the device session and automation running.',
    "Typical loop:",
    `  ${executable} open <bundle-or-package-id> ${target}     # or: open <app> <deep-link-url>`,
    `  ${executable} snapshot -i ${target}                     # accessibility tree with @eN refs`,
    `  ${executable} click @e3 ${target}`,
    `  ${executable} fill @e5 "text" ${target}`,
    `  ${executable} screenshot /tmp/shot.png ${target}        # or call device_screenshot`,
    `  ${executable} install <app> <path-to-.app-or-.apk> ${target}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help for workflow guides and ${executable} <command> --help for flags.`,
    "Prefer this agent-device launcher. If T3 discovery, streaming, or control fails on connected physical hardware, report the error and continue with device-pinned agent-device or native tools. adb UI control is allowed. Never bypass disabled device/agent access or a permission denial.",
    "A requested device test includes installing development apps and automation helpers, signing in, taps, typing, captures, and task-related settings. Respect build locks and preserve unrelated apps/data. Ask only for trust, Developer Mode, or credentials you cannot supply.",
    "If another thread owns the physical device, coordinate with it before taking control.",
    "For remote hosts, arrange builds, app installation, and any Metro reverse forwarding yourself. T3 provides discovery, streaming, and control only.",
    "Keep the returned --config and --session flags on every command. Other hosts can be used concurrently; opening one does not switch these commands.",
    `Before releasing physical hardware, run ${executable} close ${target}, then call device_close.`,
    platformNotes,
  ].join("\n");
}

const requireDeviceAccess = McpInvocationContext.requireThreadMcpCapability("device").pipe(
  Effect.mapError(
    () =>
      new DeviceToolUnavailableError({
        reason: "Agent device access is turned off for this environment.",
      }),
  ),
);

const pickDevice = Effect.fn("handlers.pickDevice")(function* (
  devices: ReadonlyArray<DeviceSummary>,
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
    readonly physical?: boolean | undefined;
  },
  owned: ReadonlyArray<{ readonly hostId: string; readonly deviceId: string }> = [],
): Effect.fn.Return<DeviceSummary, DeviceToolUnavailableError> {
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  if (input.deviceId !== undefined) {
    const match = devices.find(
      (device) => device.hostId === hostId && device.id === input.deviceId,
    );
    if (match) return match;
    return yield* new DeviceToolUnavailableError({
      reason: `No device ${input.deviceId} on host ${hostId}. Call device_list for current ids.`,
    });
  }
  const previous = owned.findLast(
    (session) =>
      (input.hostId === undefined || session.hostId === input.hostId) &&
      devices.some(
        (device) =>
          device.hostId === session.hostId &&
          device.id === session.deviceId &&
          (input.platform === undefined || device.platform === input.platform) &&
          (input.physical === undefined || device.physical === input.physical),
      ),
  );
  if (previous)
    return devices.find(
      (device) => device.hostId === previous.hostId && device.id === previous.deviceId,
    )!;
  const candidates = devices.filter(
    (device) =>
      device.hostId === hostId &&
      (input.platform === undefined || device.platform === input.platform) &&
      (input.physical === undefined || device.physical === input.physical),
  );
  if (candidates.length === 0) {
    return yield* new DeviceToolUnavailableError({
      reason:
        input.platform === undefined
          ? "No matching devices were found. Call device_list to see why."
          : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const platforms = new Set(candidates.map((device) => device.platform));
  if (input.platform === undefined && platforms.size > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: "Both iOS and Android devices are available; pass platform or deviceId.",
    });
  }
  if (candidates.length > 1 && candidates.some((device) => device.physical)) {
    return yield* new DeviceToolUnavailableError({
      reason:
        "Several devices match. Ask which physical device to use, then pass its deviceId and hostId from device_list.",
    });
  }
  return candidates.find((device) => device.booted) ?? candidates[0]!;
});

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = input?.hostId;
      const open = state.sessions
        .filter((session) => session.threadId === scope.thread.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
        inUse: state.sessions.filter((session) => !hostId || session.hostId === hostId),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const target = yield* pickDevice(
        state.devices,
        input,
        state.sessions.filter((session) => session.threadId === scope.thread.threadId),
      );
      // Resolve consent and agent connectivity before booting or registering a session.
      if (!(yield* devices.agentReadinessIfSupported(target.hostId))) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Agent device access requires enabled device support, agent access, and an available device platform on this host.",
        });
      }
      const session = yield* devices.open(
        {
          threadId: scope.thread.threadId,
          hostId: target.hostId,
          deviceId: target.id,
          platform: target.platform,
          ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
        },
        { workspaceRoot: yield* threadWorkspaceRoot(scope.thread.threadId) },
      );
      const after = yield* devices.state;
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      // Target the opened device: an EAS device and its agent-device daemon
      // exist only once its session runs, and Android ids change on boot.
      const agent = yield* devices.agentTarget({
        threadId: scope.thread.threadId,
        hostId: device.hostId,
        deviceId: device.id,
      });
      const cloud = after.hosts.some((host) => host.id === device.hostId && host.kind === "eas");
      const targetArgs = [
        ...agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId }),
        ...agent.args,
      ];
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const shimDir = yield* ensureAgentDeviceShim({
        entryPath: yield* devices.agentCli,
        stateDir: config.stateDir,
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeviceToolUnavailableError({
              reason:
                error._tag === "NodeRuntimeUnavailableError"
                  ? nodeRuntimeUnavailableMessage("Device automation")
                  : "Could not prepare the agent-device launcher.",
              cause: error,
            }),
        ),
      );
      const command = path.join(
        shimDir,
        platform === "win32" ? "agent-device.cmd" : "agent-device",
      );
      return {
        device,
        agentDevice: { command, targetArgs },
        quickStart: agentDeviceQuickStart(device, targetArgs, command, cloud),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const sessions = yield* devices.sessionsForThread(scope.thread.threadId);
      const hostId =
        input.deviceId === undefined ? input.hostId : (input.hostId ?? LOCAL_DEVICE_HOST_ID);
      const target = sessions.findLast(
        (session) =>
          (hostId === undefined || session.hostId === hostId) &&
          (input.deviceId === undefined || session.deviceId === input.deviceId),
      );
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason:
            input.deviceId === undefined
              ? "No device is open in this thread. Call device_open first."
              : `Device ${input.deviceId} on host ${hostId} is not open in this thread. Call device_open first.`,
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(DeviceStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(DeviceScreenshotToolkit, {
  device_screenshot,
});
