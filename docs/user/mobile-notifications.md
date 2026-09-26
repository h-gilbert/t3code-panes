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

On Android, sign in to T3 Connect, link your environments, and enable **Device
Notifications** in Settings. **Ongoing Agent Activity** can show progress without
opening the app. Android background delivery requires T3 Connect; a direct or
Tailscale connection alone does not enable it. Notification permission and channels
are controlled in Android system Settings.
