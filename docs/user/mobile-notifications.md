# Mobile notifications

The private iPhone app can receive normal push notifications directly from a paired,
self-hosted environment. A T3 Connect account is not required. Allow notifications
in iOS Settings, then open the app and connect to the environment to register the device.

Approval requests, requests for input, and failures send alerts regardless of where
the turn started. Completion alerts are sent only for turns submitted from iOS,
including follow-ups and queued messages. Starting a thread on iOS does not enable
completion alerts for later turns submitted from web or desktop. The private iPhone
app does not use Live Activities or Dynamic Island.

Both the iPhone app and its environment must support iOS-origin completion alerts.
Until an environment is updated, completion alerts remain off there.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. If Live Updates don't appear on Android 16 or newer, check **Live Update Settings** in T3 Code's **Settings → Notifications**. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.
