# Local macOS Desktop Promotion

> For maintainers updating the developer's installed T3 Code app from a tested checkout. This is
> not the public release process; see [Release Checklist](release.md) for published releases.

## Goal

Move a change from the persistent Electron development app into the developer's installed macOS
app with one production build and one controlled restart, while preserving their durable threads,
open pane layout, and work running on this or another environment.

## Vocabulary and authority

A request to “update the running release,” “update my release version,” or similar authorizes a
local application-bundle replacement. It does not authorize a commit, push, tag, pull request,
GitHub Release, or update-channel publication.

The installed app normally uses the developer's live T3 home. Never start a diagnostic server
directly against `~/.t3/userdata`, edit that database, or copy development state over it. The app
itself may reopen its normal home after the bundle replacement.

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
vp run dist:desktop:artifact --platform mac --target zip --arch arm64 --build-version <version>
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

- Fully extract the artifact before installation; do not run the app from the archive or a mounted
  transient location.
- Keep one clearly named backup of the current app bundle until the replacement is verified.
- Replace only the resolved installed bundle. Never use a wildcard or broad recursive target.
- Reopen the new bundle normally so it selects the same production T3 home it used before.

An atomic helper command does not exist yet, so filesystem replacement and application launch may
require macOS approval. Resolve and report the exact source, destination, and backup paths.

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

## Intended automation

The desired future interface is a command such as `vp run promote:desktop`. It should perform this
same workflow: focused preflight, one cached production build, direct unpacked-app packaging where
supported, a graceful exact-process restart, atomic replacement with one backup, reopening against
the same T3 home, and health/workspace verification.

Until that command is implemented and listed in `package.json`, do not invoke it or tell the
developer it exists. Keep public distributable artifact and GitHub release workflows separate from
this local promotion path.
