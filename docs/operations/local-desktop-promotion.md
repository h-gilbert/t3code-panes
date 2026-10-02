# Local macOS Desktop Promotion

> For maintainers performing an explicitly requested one-off local install from a tested checkout.
> To publish this fork for the Mac and its servers, use [Fork Releases](fork-releases.md).

## Goal

Move a change from the persistent Electron development app into the developer's installed macOS
app with one production build and one controlled restart, while preserving their durable threads,
open pane layout, and work running on this or another environment.

## Vocabulary and authority

A request for a one-off local installation authorizes a local application-bundle replacement.
It does not authorize a commit, push, tag, pull request, GitHub Release, or update-channel
publication. Requests to release or ship this fork use [Fork Releases](fork-releases.md).

The installed app normally uses the developer's live T3 home. Never start a diagnostic server
directly against `~/.t3/userdata`, edit that database, or copy development state over it. The app
itself may reopen its normal home after the bundle replacement.

For updates from the original T3 Code project, complete the
[upstream integration workflow](upstream-integration.md) before preparing an installed build.

## Workflow

### 1. Finish iteration in development

Keep `vp run dev:desktop --home-dir .t3` alive while iterating. Use hot reload for UI changes and
run only focused tests, lint, and type checks for the touched scope. Do not package production
artifacts until the developer is satisfied with the development behavior.

### 2. Establish a restart boundary

Before touching the installed app:

- Record the installed bundle path, current version, and exact processes owned by that app.
- Record the visible workspace and pane-to-thread assignments. Durable thread data and the pane
  layout are different state; preserving the database alone does not prove the workspace reopened.
- Inspect active main turns, subagents, and managed terminals. If the developer asked to preserve
  running work, wait for a safe boundary or confirm that the owning server will remain alive.
- Remember that work may belong to another environment. Closing this Mac's pane or window is not
  permission to stop it.

Never kill by a name/path pattern. Quit the known app normally, or signal only an exact PID that
was captured from the app being replaced.

### 3. Build once

Build the smallest normal macOS artifact needed for local installation:

```sh
vp run dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version <version>-panes.<build>
```

Use the actual host architecture when it is not Apple Silicon. The artifact builder already runs
the desktop/server/web production build and creates a clean production dependency stage, so do not
run the same production build again unless an earlier focused verification requires it.

The production stage should reuse the package manager store. If a large dependency download is
slow or fails, preserve successful build output, diagnose the exact fetch/cache entry, and retry
packaging with `--skip-build` when the existing `apps/desktop/dist-electron` and
`apps/server/dist` outputs are still valid. Do not add temporary dependency overrides or mutate
the lockfile merely to complete a local install.

### 4. Replace safely

- Sign the extracted local app with the same Apple Development certificate on
  every update, preserving its entitlements. Do not use ad hoc signing as a
  fallback: its designated requirement changes with the executable, which can
  make macOS ask again for Downloads and other protected-folder permissions.
  Verify the signature before quitting the installed app. Switching an existing
  ad hoc install to certificate signing may require one new permission grant.
- Fully extract the artifact before installation; do not run the app from the archive or a mounted
  transient location.
- Keep one clearly named backup of the current app bundle until the replacement is verified.
- Replace only the resolved installed bundle. Never use a wildcard or broad recursive target.
- Reopen the new bundle normally so it selects the same production T3 home it used before.

The promotion command stages the replacement on the destination filesystem, records recovery
paths, then renames the old and new bundles. It restores the original if the second rename fails.
Filesystem replacement may require macOS approval for the exact destination.
For an already extracted app signed with the Apple Development certificate, run:

```sh
bash scripts/install-local-desktop-update.sh '/path/to/T3 Code (Alpha).app'
```

The script checks the signature, signing team, and bundle identifier, prints the exact paths,
and asks for a safe restart boundary. It stages the replacement, quits the installed app normally,
refuses to replace it while its processes remain, keeps a timestamped backup, and reopens it.
It does not build, sign, or verify the restored workspace. Filesystem replacement and application
launch may require macOS approval.

### 5. Verify the outcome

Confirm all of the following before reporting success:

- The installed bundle reports the requested new version/build.
- Its bundled server becomes healthy.
- The same workspace shape reappears, including pane-to-thread assignments.
- A renamed thread is identified as the same durable thread rather than reported as missing.
- Work that was meant to persist was not stopped merely because the local app restarted.
- The development app remains available if the developer asked to keep iterating.

Report the focused checks run, the installed version, and the backup path. If turns naturally
finished while waiting, say so rather than claiming they were restored as actively running.

## Promotion commands

Run these from the checkout containing the reviewed changes. Node 24 or newer is required.
The standalone installer tests run with `vp run test:desktop:promotion` and are also part of
preparation. They use temporary app bundles and never replace the installed app.

```sh
T3CODE_LOCAL_SIGNING_IDENTITY=<Apple-Development-certificate-SHA-1> vp run promote:desktop prepare
vp run promote:desktop status
# Finish local work and quit the installed app normally before installing.
vp run promote:desktop install --app '/Applications/T3 Code (Alpha).app'
# Subsequent installs reuse the recorded app and state paths.
vp run promote:desktop install
vp run promote:desktop rollback
```

Use the actual installed bundle path, which may differ from the example. The first installation
requires `--app`; the command does not guess which copy to replace. Supply `--home-dir` if the
installed app uses a T3 home other than `~/.t3`. Ambient `T3CODE_HOME` is deliberately ignored so a
development shell cannot select production state accidentally. The Electron profile is resolved
using the app's legacy `T3 Code (Alpha)` directory preference, then `t3code`, under
`~/Library/Application Support`. `--profile-dir` identifies an existing nonstandard profile for
backup; it does not change the app's profile configuration.

Set `T3CODE_LOCAL_SIGNING_IDENTITY` to the SHA-1 of the Apple Development certificate used by
the installed app. Preparation signs the extracted local bundle with that identity and records its
signed checksum. This local signing step does not require the provisioning profile used for
published passkey builds. Verify the certificate and team match the installed app before installation.

`prepare` runs the promotion tests and desktop/server update safeguard tests, then calls the existing
ZIP artifact builder once. Run the tests, lint and type checks relevant to your actual edits before
preparing. Preparation does not replace that review. It gives the build a unique `-panes` version,
records HEAD and a digest covering tracked, modified and untracked source files, checks that source
did not change during the build, and verifies the extracted bundle version and contents. Uncommitted
changes are supported, including a resolved integration merge. No commit, tag, push or publication
occurs. A failed preparation leaves the previous candidate selected and retains build output for
diagnosis. If packaging fails, use the artifact builder's documented cache recovery above; do not
install an unverified artifact manually just to bypass preparation.

`status` reports the prepared candidate, installation journal and any promotion lock. Detailed source
changes are retained in the candidate manifest. This is recorded build status, not a live server
health report. By default, artifacts and records live in `~/.t3-promotions`. `--store` selects another
private local directory; use it consistently across commands. Storage must be separate from the
checkout, app and production state. Backups contain credentials and conversation data. Keep this
directory private and allow enough disk space for the app and complete state copies.

`install` requires the target app to be fully quit. It refuses if a process is running from that
bundle or has files open in the production home or Electron profile. Inspection errors also block
installation. There is no force flag and the command never signals local or remote processes. Choose
the safe quit boundary yourself after inspecting turns, subagents and managed terminals. Closing
only a window is insufficient. Do not reopen the app while replacement is underway.

Installation verifies the prepared checksum, copies the replacement beside the installed app,
backs up the closed production home and Electron profile, records the migration history, and retains
the old bundle beside the target. A durable journal records each replacement's paths. It verifies
the installed bundle and reopens it through macOS with the same explicit T3 home. `--no-launch` leaves
it closed. No development state is copied into production. If launch fails, the successfully installed
app and all recovery paths remain recorded. Confirm server connection and pane restoration using the
verification list above; the command does not claim to automate those UI checks.

`rollback` restores the previous bundle while retaining current state. It requires the app to be
quit, verifies both bundle checksums, and refuses if migration history changed or another update
replaced the installed app. It never restores an older database automatically. If migrations changed,
a separate recovery decision is required because restoring a snapshot would discard newer work.
Rollback itself saves the replaced app and current state. Only the most recent installation is an
automatic rollback target; earlier records and backups remain available for deliberate recovery.

If the command is interrupted, inspect `installation.json` before retrying. A `staged` journal blocks
further replacements until its recorded app, staged bundle and backup are reconciled. Do not delete
those paths blindly. A surviving `lock/owner.json` records the PID and time; confirm that the owning
process has stopped before removing the lock directory. Backups are not pruned automatically.

One-off local builds use a custom version suffix such as `0.0.44-panes.<timestamp>.<digest>`.
The artifact builder defaults to `-panes.1`. These versions omit update feeds and reject
self-updates. Published fork releases use `-panes.<13-digit timestamp>` and update the Mac
and managed servers from the fork's release feed. Use [Fork Releases](fork-releases.md) to
prepare that signed release; local promotion can install its candidate once to join the feed.
