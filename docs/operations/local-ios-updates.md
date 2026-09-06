# Local iPhone updates

The private iPhone app is built from a separate worktree at `.t3/ios/source`.
This allows updating mobile from `upstream/main` without merging the desktop
panes fork or restarting its server. Keep the existing bundle identifier
`nz.co.hamishgilbert.t3code` and Apple team `XJN9V8FD45` so installing an update
preserves the app's data and keychain access. The target is Hamish's iPhone 15 Pro.

## Check what is installed and missing

From the panes checkout:

```bash
python3 scripts/ios-local.py status --fetch
```

This fetches upstream, reads the phone's app inventory, compares the installed
version with the last verified install, checks local mobile source changes,
and lists upstream commits affecting mobile or its shared dependencies. Without
`--fetch`, it uses the last fetched upstream ref. The phone must be reachable
and paired with this Mac. A matching version relies on using this build ledger;
an app installed independently with the same version cannot be distinguished.

The durable records are gitignored:

- `.t3/ios/installed.json`: last verified installation.
- `.t3/ios/installs/<build>.json`: installation history.
- `.t3/ios/builds/<build>/`: source patch, build log, record, and signed app.
- `.t3/ios/DerivedData`: reusable native build cache.

Each build embeds its source revision and source fingerprint in `Info.plist`.
The fingerprint covers mobile, shared packages, dependency locks, patches,
assets, and shared configuration helpers. The source patch records fork changes
relative to the upstream revision. Generated native files are build outputs.

## Prepare an update

Run `python3 scripts/ios-local.py update` from the panes checkout. It requires
a clean iOS worktree, fetches upstream, merges it into the private iOS branch,
and checks the private source policy. The private changes are local commits,
so normal upstream merges retain them. Resolve conflicts in the iOS worktree
and run `python3 scripts/ios-local.py check` after regenerating the native project.
Do not reset the branch to upstream or replace it with a fresh upstream tree.
Preserve the current signed app and installation record until its replacement
is verified. None of these commands push commits or update the panes server.

The original private changes are `abfab6a77` and `929c7e398`, plus the Live Activity
removal adapted from `911eb17e8`. Only their mobile
files and the direct-notification HTTP contracts are needed for this checkout;
the running panes server already implements those endpoints. Keep the local
`.env.local` values for `T3CODE_MOBILE_SELF_HOSTED`, `T3CODE_IOS_TEAM_ID`,
`T3CODE_IOS_BUNDLE_ID`, and `T3CODE_APNS_ENVIRONMENT`. Do not copy server secrets.

From `.t3/ios/source`, install its pinned dependencies with
`node_modules/.bin/vp install`. For the first install, use the panes checkout's
`node_modules/.bin/vp`.
Then, from its `apps/mobile` directory:

```bash
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 node_modules/.bin/expo prebuild --clean --platform ios --no-install
cd ios
pod install
```

Run the mobile typecheck and focused tests for any adapted private changes.
The ledger's focused tests run with `python3 scripts/ios-local_test.py` from
the panes checkout.
Check that the latest mobile contracts remain compatible with the environments
the phone connects to. A newer mobile build does not update those servers.

## Build and install

From the panes checkout, confirm no actual `xcodebuild` is running, then:

```bash
python3 scripts/ios-local.py build
```

The command chooses a new build number and starts a detached Release build
through `~/.claude/hooks/build-lock`, with two compilation jobs. It prints the
PID and log path. Before compilation, it runs the mobile typecheck and the
focused push/connection tests, writing their results to `validation.log`.
Poll the build log and its sibling `record.json`; wait for status
`built`. Status `failed` includes the error. Do not edit the iOS source while
the build runs. The build verifies its source fingerprint before accepting the
artifact.

The private policy is **normal push notifications, no Live Activities or Dynamic
Island integration**. Keep approval, input, completion, and failure alerts working.
The source check rejects `expo-widgets`, ActivityKit/Dynamic Island implementation,
activity-token registration, and any device registration that can enable Live
Activities. Live Activity settings and preferences must remain removed. The wire
contract retains `liveActivitiesEnabled: false` to opt out on existing servers.

Builds also verify that the generated project has no Live Activity support and
retains sandbox APNs, and that the signed app has the expected APNs entitlement.
Before every build the old derived `.app` is removed, while compilation caches
are retained, so a removed extension cannot survive in the next artifact.
Installation rejects apps with Live Activity support or widget extensions,
including older retained builds that predate this policy. If an upstream update
fails these checks, adapt the removal to that update; do not weaken the checks.

Once the phone is reachable and unlocked:

```bash
python3 scripts/ios-local.py install <build>
python3 scripts/ios-local.py status
```

Installation replaces the existing app without uninstalling it. The ledger is
updated only after `devicectl` reports success and a second inventory query
confirms the expected version and build. Open the app and verify saved
environments and the changed flow. Record any runtime verification limits in
the handoff; successful compilation and installation alone do not prove them.

To reinstall a retained build that satisfies the private policy, use the same
`install` command with that build's number. Do not downgrade after an incompatible
app-data migration without checking the migration's behavior.
