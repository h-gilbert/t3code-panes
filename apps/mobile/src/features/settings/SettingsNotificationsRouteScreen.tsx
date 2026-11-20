import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useGT, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { m as resolveMessage } from "../../i18n/messages";

import { AppText as Text } from "../../components/ui/AppText";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isSelfHostedMobileBuild,
  supportsAgentAwarenessPush,
} from "../agent-awareness/capabilities";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  agentAwarenessNotificationsReady,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";

const notificationStatusAtom = makePermissionStatusAtom<NotificationStatus>({
  label: "mobile:notification-permission",
  initial: "checking",
  read: async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return "unsupported";
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      return "disabled";
    }
    return result.value.granted ? "enabled" : "disabled";
  },
});

function useNotificationsReady(): boolean {
  return useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    agentAwarenessNotificationsReady,
    () => false,
  );
}

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  if (isSelfHostedMobileBuild()) {
    return <ConfiguredSettingsNotificationsRouteScreen selfHosted />;
  }
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title={gt("Notifications")}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            {gt("Notifications require {product} in this app build.", { product: "T3 Connect" })}
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <CloudSettingsNotificationsRouteScreen />;
}

function CloudSettingsNotificationsRouteScreen() {
  const auth = useAuth({ treatPendingAsSignedOut: false });
  return <ConfiguredSettingsNotificationsRouteScreen isSignedIn={auth.isSignedIn} />;
}

function ConfiguredSettingsNotificationsRouteScreen({
  isSignedIn,
  selfHosted = false,
}: {
  readonly isSignedIn?: boolean | undefined;
  readonly selfHosted?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS, m);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? gt("Install a newer app build to enable notifications")
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const notificationStatus = useAtomValue(notificationStatusAtom);
  const setNotificationStatus = useAtomSet(notificationStatusAtom);
  const notificationsReady = useNotificationsReady();

  const requestNotifications = async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Notifications unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not request notification permission."),
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (!agentAwarenessNotificationsReady()) {
        Dialog.alert(
          gt("Couldn't finish enabling notifications"),
          selfHosted
            ? gt(
                "Notification access was granted. Connect to a paired environment to register this device.",
              )
            : gt(
                "Notification access was granted, but this device could not be registered with {product}. Notifications will start once registration succeeds.",
                { product: "T3 Connect" },
              ),
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Dialog.alert(
        gt("Notifications unavailable"),
        gt("Agent notifications are unavailable on this platform."),
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Dialog.alert(gt("Notifications disabled"), gt("Notifications were not enabled."));
      return;
    }
    Dialog.alert(
      gt("Notifications disabled"),
      gt("Notifications were denied for this app. Open Settings to enable them."),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const promptSignIn = () => {
    Dialog.alert(
      gt("Sign in to {product}", { product: "T3 Connect" }),
      gt("Sign in to register this device for notifications."),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Continue"),
          onPress: () => navigation.navigate("SettingsAuth"),
        },
      ],
    );
  };

  const handleDeviceNotificationsChange = (enabled: boolean) => {
    if (enabled) {
      if (!selfHosted && !isSignedIn) {
        promptSignIn();
        return;
      }
      void requestNotifications();
      return;
    }

    Dialog.alert(
      gt("Disable notifications"),
      gt("Open system Settings to disable notifications for {product}.", { product: "T3 Code" }),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
  };

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={gt("Agent activity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && notificationsReady
            }
            onValueChange={handleDeviceNotificationsChange}
          />
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
