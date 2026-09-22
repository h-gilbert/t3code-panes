import type { DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "../../state/device";
import { simulatorStreamUrl } from "./simulatorStreamUrl";

/** Read-only live view. Simulator control stays in the Mac app and T3's desktop Device panel. */
export function SimulatorViewer(props: {
  readonly environmentId: EnvironmentId;
  readonly device: DeviceSummary;
  readonly onClose: () => void;
}) {
  const access = useDeviceHubAccess(props.environmentId, props.device.hostId);
  const insets = useSafeAreaInsets();
  const [streamFailed, setStreamFailed] = useState(false);
  const url = access ? simulatorStreamUrl(access, props.device.id) : null;
  const html = useMemo(() => {
    if (!url) return null;
    const safeUrl = JSON.stringify(url).replaceAll("<", "\\u003c");
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:#000}body{display:flex;align-items:center;justify-content:center}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img id="screen" alt="Live simulator screen"><script>const screen=document.getElementById('screen');screen.onerror=()=>window.ReactNativeWebView.postMessage('stream-error');screen.src=${safeUrl};</script></body></html>`;
  }, [url]);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-black"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <View className="flex-row items-center justify-between px-4 py-3">
          <Text className="min-w-0 flex-1 text-base font-t3-bold text-white" numberOfLines={1}>
            {props.device.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry simulator stream"
            onPress={() => {
              setStreamFailed(false);
              refreshDeviceHubAccess(props.environmentId);
            }}
            className="px-3 py-2"
          >
            <Text className="text-sm text-white">Retry</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close simulator viewer"
            onPress={props.onClose}
            className="px-3 py-2"
          >
            <Text className="text-sm text-white">Done</Text>
          </Pressable>
        </View>
        {html && !streamFailed ? (
          <WebView
            key={url}
            source={{ html }}
            originWhitelist={["*"]}
            setSupportMultipleWindows={false}
            onMessage={(event) => {
              if (event.nativeEvent.data === "stream-error") setStreamFailed(true);
            }}
            onError={() => setStreamFailed(true)}
            style={{ flex: 1, backgroundColor: "black" }}
          />
        ) : (
          <View className="flex-1 items-center justify-center gap-3 px-6">
            {streamFailed ? null : <ActivityIndicator color="white" />}
            <Text className="text-center text-sm text-white">
              {streamFailed
                ? "The simulator stream stopped. Tap Retry to reconnect."
                : "Connecting to simulator…"}
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
