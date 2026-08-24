# Self-host T3 Code Mobile on iPhone

You can build T3 Code Mobile under your own Apple Developer account and connect it directly to
your T3 Code environments over Tailscale. This mode does not use a T3 account, T3 Connect, Clerk,
the hosted relay, Cloudflare, or T3's Expo update channel.

## What you need

- A paid Apple Developer membership.
- Xcode and CocoaPods on the Mac used to build the app.
- Tailscale on the Mac and iPhone, signed into the same tailnet.
- An Apple Push Notification service key (`AuthKey_<KEY_ID>.p8`) if you want notifications and
  Live Activities while the app is closed.

## Build the app

Choose a bundle identifier owned by your Apple team, then run from `apps/mobile`:

```bash
T3CODE_MOBILE_SELF_HOSTED=1 \
T3CODE_IOS_TEAM_ID=YOUR_TEAM_ID \
T3CODE_IOS_BUNDLE_ID=com.example.t3code \
T3CODE_APNS_ENVIRONMENT=sandbox \
vp run ios:release
```

An Xcode-installed development build uses APNs sandbox. Use `production` only when the installed
provisioning profile carries the production APNs entitlement, such as a TestFlight build.

The self-hosted variant has its own app name and bundle identity, so it can coexist with the
official T3 Code app. It retains notifications, widgets, Live Activities, and normal in-app
attachments. It also registers the established `t3code://` deep-link alias so widget taps work.
The optional iOS system Share extension is omitted so a private build does not need a third Apple
App ID and provisioning profile.

## Connect over Tailscale

Start or share the T3 server on the Mac, open its full pairing URL on the iPhone, and save the
connection in T3 Code Mobile. Use the Mac's Tailscale address or MagicDNS name rather than
`localhost`. The pairing bearer token authenticates the phone directly to that environment.

## Enable direct notifications

Create an APNs key in the Apple Developer portal and download its `.p8` file. Configure each T3
environment that should notify the phone:

```bash
t3 notifications configure \
  --team-id YOUR_TEAM_ID \
  --key-id YOUR_KEY_ID \
  --bundle-id com.example.t3code \
  --private-key-file ~/Downloads/AuthKey_YOUR_KEY_ID.p8 \
  --environment sandbox
```

The command imports the private key into that environment's protected T3 secret store. It does not
copy the key into a project or send it to T3. Restart the environment and open the iPhone app. The
first direct connection asks for notification permission and registers the granted APNs token with
the environment; reconnect or foreground the app to retry after a temporary connection failure.
Check the result with:

```bash
t3 notifications status
```

Every saved direct environment can send alerts to the phone. The primary direct environment owns
the current Live Activity; this avoids routing activity tokens through a central service. Opening a
notification deep-links to the relevant environment and thread.

To remove the credentials and phone registration from an environment:

```bash
t3 notifications disable
```

The APNs key remains governed by your Apple Developer account and can also be revoked there.
