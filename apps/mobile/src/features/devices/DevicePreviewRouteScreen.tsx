import { SheetCloseButton } from "../../components/ui/SheetHeader";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import {
  deviceToolVersionLabels,
  deviceToolUpdateOwnership,
  deviceToolUpdatePolicy,
} from "@t3tools/client-runtime/state/device";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { msg, T, useGT } from "gt-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { GlassSurface } from "../../components/ui/GlassSurface";
import {
  findAppBarMenuItem,
  menuActionsFromAppBarItems,
} from "../../components/ui/menuActionItems";
import { AppBar } from "../../components/ui/AppBar";
import { m } from "../../i18n/messages";
import { useBarOverlap } from "../../components/ui/useBarInset";
import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { useAppForeground } from "../../lib/appState";
import { uuidv4 } from "../../lib/uuid";
import { deviceEnvironment, useDeviceHubAccess } from "../../state/device";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DeviceStreamWebView, type DeviceStreamRef } from "./DeviceStreamWebView";
import {
  selectedThreadDevicePreview,
  threadDevicePreviews,
  type ThreadDevicePreview,
} from "./threadDevicePreviews";

type DevicePreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly deviceKey?: string;
}>;

/** Keep navigation outside the stream so a failed device cannot trap the viewer. */
export function DevicePreviewRouteScreen({ route }: DevicePreviewRouteScreenProps) {
  const navigation = useNavigation();
  const onClose = () => navigation.goBack();
  const { environmentId, threadId } = route.params;
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops a deep-linked route with a blank environment or thread off the navigator
  useEffect(() => {
    if (isBlankLink) onClose();
  }, [isBlankLink, onClose]);
  if (isBlankLink) return null;
  return (
    <DevicePreviewScreen
      environmentId={EnvironmentId.make(environmentId)}
      threadId={ThreadId.make(threadId)}
      initialDeviceKey={route.params.deviceKey}
      onClose={onClose}
    />
  );
}

export function DevicePreviewScreen({
  environmentId,
  threadId,
  onClose,
  onMaximize,
  initialDeviceKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
  readonly onMaximize?: (deviceKey: string | null) => void;
  readonly initialDeviceKey?: string;
}) {
  const embedded = onMaximize !== undefined;
  const insets = useSafeAreaInsets();
  const barOverlap = useBarOverlap();
  const { themeVariables } = useAppearancePreferences();
  const focused = useIsFocused();
  const foreground = useAppForeground();
  const [selectedKey, setSelectedKey] = useState<string | null>(initialDeviceKey ?? null);
  const [inputConnected, setInputConnected] = useState(false);
  const [inputDetail, setInputDetail] = useState<string | null>(null);
  const gt = useGT();
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [shuttingDown, setShuttingDown] = useState(false);
  const retryHost = useAtomCommand(deviceEnvironment.list);
  const shutdown = useAtomCommand(deviceEnvironment.shutdown, { reportFailure: false });
  const streamRef = useRef<DeviceStreamRef>(null);
  const state = useEnvironmentQuery(deviceEnvironment.state({ environmentId, input: {} }));
  const previews = threadDevicePreviews(state.data, threadId);
  const preview = selectedThreadDevicePreview(previews, selectedKey);
  const onInputConnected = useCallback(async (connected: boolean, detail?: string) => {
    setInputConnected(connected);
    setInputDetail(connected ? null : (detail ?? null));
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the focused route through the navigator once the thread has no device previews
  useEffect(() => {
    if (focused && state.data !== null && previews.length === 0) onClose();
  }, [focused, state.data, previews.length, onClose]);
  const shutDownDevice = async () => {
    if (!preview || shuttingDown) return;
    setShuttingDown(true);
    const result = await shutdown({
      environmentId,
      input: {
        hostId: preview.session.hostId,
        deviceId: preview.session.deviceId,
        platform: preview.session.platform,
      },
    }).finally(() => setShuttingDown(false));
    if (result._tag === "Failure") {
      Dialog.alert(m(msg("Could not shut down device")), String(Cause.squash(result.cause)));
    }
  };

  const controls: AppBarMenuItem[] = [
    ...(state.data?.hosts
      .filter(
        (host) =>
          state.data?.supportsHostRetry && state.data.hostStatuses[host.id]?.status === "failed",
      )
      .map((host) => ({
        id: `retry-${host.id}`,
        title: gt("Retry {host}", { host: host.label }),
        icon: "arrow.clockwise" as const,
        onPress: () => {
          void retryHost({ environmentId, input: { retryHostId: host.id } });
        },
      })) ?? []),
    ...(state.data?.supportsToolInspection
      ? [
          {
            id: "check-device-tools",
            title: gt("Check device tool versions"),
            icon: "arrow.clockwise" as const,
            onPress: () => {
              void retryHost({ environmentId, input: { inspectOnly: true } });
            },
          },
        ]
      : []),
    {
      id: "device-tools",
      title: gt("Device tool versions"),
      icon: "info.circle",
      onPress: () =>
        Dialog.alert(
          m(msg("Device tool versions")),
          m(deviceToolUpdateOwnership) +
            "\n\n" +
            deviceToolUpdatePolicy(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
              m,
            ) +
            "\n\n" +
            deviceToolVersionLabels(
              state.data?.hosts.find((host) => host.id === preview?.session.hostId)?.tools,
              m,
            ).join("\n") +
            "\n" +
            (state.data?.hosts.find((host) => host.id === preview?.session.hostId)
              ?.toolInspectionError ??
              state.data?.hostStatuses[preview?.session.hostId ?? ""]?.detail ??
              ""),
        ),
    },
    {
      id: "reload",
      title: gt("Reload stream"),
      icon: "arrow.clockwise" as const,
      disabled: !preview || shuttingDown,
      onPress: () => {
        setInputConnected(false);
        setStreamAttempt((attempt) => attempt + 1);
      },
    },
    ...(preview?.session.platform === "android"
      ? [
          {
            id: "back",
            title: gt("Back", { $context: "Android back button" }),
            icon: "arrow.left",
            disabled: !inputConnected,
            onPress: () => streamRef.current?.back(),
          },
        ]
      : []),
    {
      id: "app-switcher",
      title: gt("App switcher"),
      icon: "square.on.square",
      disabled: !inputConnected,
      onPress: () => streamRef.current?.appSwitcher(),
    },
    ...(preview?.session.platform === "ios"
      ? [
          {
            id: "rotate",
            title: gt("Rotate device"),
            icon: "arrow.clockwise" as const,
            disabled: !inputConnected,
            onPress: () => streamRef.current?.rotate(),
          },
        ]
      : []),
    {
      id: "shutdown",
      title: shuttingDown ? gt("Shutting down…") : gt("Shut down device"),
      icon: "power",
      disabled: !preview || shuttingDown,
      onPress: () => void shutDownDevice(),
    },
  ];
  const pressHome = () => streamRef.current?.home();
  const menuItems: AppBarMenuItem[] = [
    ...(previews.length > 1
      ? [
          {
            id: "devices",
            title: gt("Devices", { $context: "device list heading" }),
            inline: true,
            items: previews.map((device) => ({
              id: device.key,
              title: device.name,
              subtitle: device.description,
              selected: device.key === preview?.key,
              onPress: () => setSelectedKey(device.key),
            })),
          },
        ]
      : []),
    ...controls,
  ];
  return (
    <View className="flex-1" style={{ backgroundColor: themeVariables["--color-sheet-solid"] }}>
      {embedded ? (
        <>
          <AppBar
            title={preview?.name ?? gt("Devices", { $context: "screen title" })}
            actions={[
              {
                accessibilityLabel: gt("Maximize device"),
                icon: "arrow.up.left.and.arrow.down.right",
                onPress: () => onMaximize(preview?.key ?? null),
              },
            ]}
          />
          <View style={{ height: barOverlap }} />
        </>
      ) : null}
      {inputDetail ? (
        <AppText className="px-6 py-2 text-center text-sm text-foreground-muted">
          {m(inputDetail)}
        </AppText>
      ) : null}
      {preview && focused && foreground ? (
        <OpenDevicePreview
          key={`${preview.key}:${streamAttempt}`}
          environmentId={environmentId}
          preview={preview}
          streamRef={streamRef}
          onInputConnected={onInputConnected}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-4 px-6">
          {state.error ? (
            <>
              <AppText selectable className="text-center text-sm text-foreground-muted">
                {state.error}
              </AppText>
              <View className="items-center">
                <Button label={gt("Retry")} tone="secondary" onPress={state.refresh} />
              </View>
            </>
          ) : focused && foreground ? (
            <AppActivityIndicator color={themeVariables["--color-icon"]} />
          ) : null}
        </View>
      )}
      {embedded ? (
        <View
          className="flex-row items-center justify-center gap-2 px-3 py-2"
          style={{ paddingBottom: Math.max(insets.bottom, 8) }}
        >
          <ControlPill
            accessibilityLabel={gt("Home", { $context: "device home button" })}
            icon="house"
            disabled={!inputConnected}
            onPress={pressHome}
          />
          <DeviceOptionsMenu items={menuItems} />
        </View>
      ) : (
        <View pointerEvents="box-none" className="absolute inset-x-0 top-0">
          <View className="px-3" style={{ paddingTop: Math.max(insets.top, 12) }}>
            <GlassSurface className="flex-row items-center gap-1 p-1">
              <SheetCloseButton accessibilityLabel={gt("Close device preview")} onClose={onClose} />
              <AppText numberOfLines={1} className="flex-1 text-center font-t3-medium text-base">
                {preview?.name ?? gt("Devices", { $context: "screen title" })}
              </AppText>
              <ControlPill
                accessibilityLabel={gt("Home", { $context: "device home button" })}
                icon="house"
                disabled={!inputConnected}
                onPress={pressHome}
              />
              <DeviceOptionsMenu items={menuItems} />
            </GlassSurface>
          </View>
        </View>
      )}
    </View>
  );
}

function DeviceOptionsMenu({ items }: { readonly items: ReadonlyArray<AppBarMenuItem> }) {
  const gt = useGT();
  return (
    <Menu
      actions={menuActionsFromAppBarItems(items)}
      isAnchoredToRight
      title={gt("Device options")}
      onPressAction={({ nativeEvent }) => {
        const action = findAppBarMenuItem(items, nativeEvent.event);
        if (action && !action.disabled) action.onPress();
      }}
    >
      <ControlPill icon="ellipsis" accessibilityLabel={gt("Device options")} />
    </Menu>
  );
}

function OpenDevicePreview({
  environmentId,
  preview,
  streamRef,
  onInputConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly preview: ThreadDevicePreview;
  readonly streamRef: RefObject<DeviceStreamRef | null>;
  readonly onInputConnected: (connected: boolean, detail?: string) => Promise<void>;
}) {
  const { session } = preview;
  const { themeVariables } = useAppearancePreferences();
  const gt = useGT();
  const [viewer] = useState(uuidv4);
  const { access, error, refresh } = useDeviceHubAccess(environmentId, session.hostId, viewer);
  const onUnauthorized = async () => refresh();
  return access ? (
    <DeviceStreamWebView
      ref={streamRef}
      access={access}
      platform={session.platform}
      deviceId={session.deviceId}
      serveSimOnly={preview.serveSimOnly}
      colors={{
        background: themeVariables["--color-sheet-solid"],
        foreground: themeVariables["--color-foreground"],
        muted: themeVariables["--color-foreground-muted"],
        buttonBackground: themeVariables["--color-secondary"],
        buttonForeground: themeVariables["--color-secondary-foreground"],
        buttonBorder: themeVariables["--color-secondary-border"],
      }}
      onUnauthorized={onUnauthorized}
      onInputConnected={onInputConnected}
    />
  ) : (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      {error ? (
        <>
          <AppText selectable className="text-center text-sm text-foreground-muted">
            {error}
          </AppText>
          <View className="items-center">
            <Button label={gt("Retry")} tone="secondary" onPress={refresh} />
          </View>
        </>
      ) : (
        <>
          <AppActivityIndicator color={themeVariables["--color-icon"]} />
          <AppText className="text-sm text-foreground-muted">
            <T>Connecting to device...</T>
          </AppText>
        </>
      )}
    </View>
  );
}
