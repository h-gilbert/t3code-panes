# Fork Releases

> For maintainers shipping this fork to the developer's own machines. Stock T3 Code releases are
> covered by [Release Checklist](release.md); one-off local installs by
> [Local macOS Desktop Promotion](local-desktop-promotion.md).

A fork release is published once and then installed everywhere from the app: the Mac updates
itself, and servers running the managed `t3` service update themselves with rollback.

## Release

From a clean, pushed `main` on the Apple Silicon Mac:

```sh
vp run release:panes
```

It builds the macOS app in a temporary worktree with every package stamped
`<upstream core>-panes.<millisecond timestamp>`, signs it with the certificate that signed the
installed app (override with `T3CODE_LOCAL_SIGNING_IDENTITY`), and attaches it with its
`latest-mac.yml` to a draft release on `h-gilbert/t3code-panes`. It then starts
`.github/workflows/release-panes.yml`, which builds the Linux x64 server archive, attaches it with
`SHA256SUMS`, and publishes the release. Updaters only read published releases, so no machine sees
half a release. The command waits for the workflow unless given `--no-wait`.

`--no-publish` builds and signs only. Either way the signed app also becomes the local promotion
candidate, so `vp run promote:desktop install` can install it on a Mac still running a local build.

After an [upstream integration](upstream-integration.md) is reviewed, committed and pushed, release
it the same way.

## Update everywhere

When an installed app sees the release, its update button installs it. Before restarting, it updates
every connected saved server that is behind and can update itself (the managed service) to the same
version, then restarts this app. The confirmation names those servers. Settings → Connections
"Update all" updates servers alone.

A fork release only updates to another fork release. Local promotion builds
(`-panes.<timestamp>.<digest>`) and the artifact builder's default `-panes.1` never self-update.

### Update Fred independently

When a server update is authorized separately from the Mac restart, use Fred's installed
managed CLI. Confirm no turns are active immediately before restarting, and preserve a consistent
read-only SQLite snapshot and its service state first. Do not stop processes by name or start a
diagnostic server against live state.

Read the current version from `~/.t3/runtime/service-state.json` on Fred, then run:

```sh
ssh fred '/home/fred/.t3/runtime/versions/<current-version>/t3 update <published-fork-version> --base-dir /home/fred/.t3 --yes'
```

Use the full version, such as `0.0.45-panes.1791172705900`. An unqualified update can choose the
stock feed. The managed updater downloads and verifies the release, updates its launcher and
restarts `t3code.service`. Keep the service's network override and existing T3 home.
Verify `systemctl --user is-active t3code.service`, the active version in service state, the actual
running executable recorded by `userdata/server-runtime.json`, remote HTTP reachability and
retained projects and conversations. Do not infer the running version from the unit's original
`ExecStart` path alone.

The private iPhone app has its own source, build and installation ledger. A panes release does
not update it; follow [local iPhone updates](local-ios-updates.md).

## One-time setup

1. The repository must be public: the desktop and server updaters download release assets
   anonymously.
2. Set the T3 Connect public identifiers as repository variables so the Linux server matches the
   Mac build: `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
   `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` and `T3CODE_RELAY_URL`, with the values in the main
   checkout's `.env`.
3. Join the feed on the Mac by installing the first release with local promotion
   (`vp run promote:desktop install` after `release:panes`). Earlier local builds have no feed.
4. Move each server to the managed service, which is what can update itself. On Fred, with no turns
   running there:

   ```sh
   V=<release version>
   curl -fsSLO "https://github.com/h-gilbert/t3code-panes/releases/download/v$V/t3-$V-linux-x64.tar.gz"
   tar -xzf "t3-$V-linux-x64.tar.gz"
   # The old unit's override would keep starting the hand-built release.
   mkdir -p ~/t3code-backups && mv ~/.config/systemd/user/t3code.service.d/gate-latest.conf ~/t3code-backups/
   printf '[Service]\nEnvironment=T3CODE_HOST=0.0.0.0\n' > ~/.config/systemd/user/t3code.service.d/network.conf
   "./t3-$V-linux-x64/t3" service install --base-dir /home/fred/.t3
   "./t3-$V-linux-x64/t3" service status --base-dir /home/fred/.t3
   ```

   The managed unit keeps the `t3code.service` name, so the `network.conf` override still applies.
   To return to the previous release, move `gate-latest.conf` back, run
   `systemctl --user daemon-reload` and restart `t3code.service`.
