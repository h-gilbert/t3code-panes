---
name: update
description: Update this fork from upstream T3 Code (pingdotgg/t3code) while keeping every custom behavior, then optionally release it to Jeff, Fred, the Air and the private iPhone. Use for /update or a request to bring the fork up to date with upstream.
---

# Update the fork from upstream

Arguments (optional, any order): a target (`nightly`, `stable`, or a full tag such as
`v0.1.12-nightly.20261123.5165`) and a scope (`integrate`, `release`, `everywhere`).

The rules live in four docs. Read them before touching anything; this skill is the order of
work plus the failures earlier updates hit:

- [upstream integration runbook](../../../docs/operations/upstream-integration.md)
- [fork compatibility](../../../docs/internals/fork-compatibility.md)
- [custom behavior to preserve](../../../docs/internals/fork-customizations.md)
- [sync runbook](../../../docs/fork/upstream-sync.md) (selective cherry-picks; a full update is a merge)

Release and phone steps follow [fork releases](../../../docs/operations/fork-releases.md) and
[local iPhone updates](../../../docs/operations/local-ios-updates.md).

## 1. Survey, then ask once

Run on Jeff, from the primary checkout, which must be on clean `main`:

```sh
git fetch origin
git fetch upstream '+refs/heads/*:refs/remotes/upstream/*' '+refs/tags/*:refs/upstream-tags/*'
gh release list --repo pingdotgg/t3code --limit 5
gh release list --repo pingdotgg/t3code --exclude-pre-releases --limit 2
git merge-base origin/main upstream/main     # last integrated upstream commit
git rev-list --count origin/main..upstream/main
```

Also check `git worktree list`, `git status` and running T3 threads in this project for an
update already in progress or unpushed fork work. Continue an existing integration instead of
starting a second one. Never reset, stash or overwrite another task's work.

Unless the arguments already settle them, ask these in one question batch, then work without
further check-ins:

1. **Target.** The runbook prefers the latest stable release; Hamish chose the latest published
   nightly for the November updates. Offer both with tag, commit and date. Never use unpublished
   `upstream/main`. Choosing a nightly is the explicit approval `ios-local.py --allow-nightly` needs.
2. **Scope.** `integrate` (merge, verify, push to `main`), `release` (also `vp run release:panes`),
   or `everywhere` (also the private iPhone build and install). Pushing, publishing and restarting
   are separate authorities: never restart an installed app or server in any scope. Hamish uses
   the app's update button.

Report the pinned tag and commit in your first message after the answers.

## 2. Inventory what must survive

Before merging, list the fork's own behavior so you can check each item afterwards:

- `git log --no-merges --format='%h %s' <merge-base>..origin/main` (everything since the last update)
- the custom behavior doc, and any handoff messages in this thread about bugs to fix or preserve

Keep this list outside the repo. It is the checklist for step 5.

## 3. Merge in an isolated worktree

```sh
git worktree add ../t3code-panes-update-<tag-short> -b integrate/<tag-short> origin/main
cd ../t3code-panes-update-<tag-short> && vp i
git merge --no-ff <pinned upstream commit>
```

Expect hundreds of conflicts (nightly 4979 had 278). Resolve change by change, never with
`--ours`, `--theirs` or a file copied wholesale from upstream. One agent owns the merge commit
and its verification; disjoint file groups (for example `apps/mobile`) may go to subagents.

Commit message shape: `feat: integrate T3 Code nightly <date>.<run>` with the upstream SHA and
what was preserved in the body.

## 4. Known traps, from earlier updates

- **Clean merges still drop behavior.** v0.1.5 merged cleanly and lost secondary-window restore,
  palette actions, browser host and proxy settings, and keybinding search terms. Nightly 4340
  duplicated the docked composer in `ChatView.tsx` after an indentation-only upstream change.
  Diff the result against the step 2 list, follow renamed callers and moved files, and
  read the merged pane runtime files (`ChatView*`, `ChatComposer`, `MessagesTimeline*`,
  `ChatHeader`, `workspacePane*`, `index.css`) even where Git reported no conflict.
- **Startup crashes from MCP tool validation.** v0.1.5 and 4979 both failed to boot on a fork-only
  MCP tool (`t3_environment_preferences_update`, then `t3_settings_update` caller identity) after
  upstream changed tool registration. Boot the server before declaring the merge done.
- **Migrations.** The fork ledger differs from upstream only at 41, 42 and 44 (fork: title source,
  auth client connection, linked pull request; upstream's 44 `ClearAutomaticProjectModelDefaults`
  is intentionally omitted). From 45 the numbers match, so upstream migrations keep their numbers.
  Never renumber or edit an applied migration. If upstream reuses a number the fork already
  uses for something else, renumber the incoming one and update `Migrations.ts`, its test and any
  `toMigrationInclusive`. Prove the upgrade on a disposable copy of real state
  (`vp run migrate-dev-db` into the worktree's `.t3`), never on `~/.t3/userdata`.
- **Browser identity.** Preview sessions keep Electron's native User-Agent, apart from upstream's
  Teams-only rewrite. Keeping an old Chrome impersonation broke Google sign-in after 4340.
- **Provider permission semantics.** After 4979, upstream switched Codex approval policy to
  granular, and full-access threads started asking for approvals again. Read provider adapter
  and approval-policy changes with the fork's Full access default in mind.
- **Fork behaviors that regressed before:** compact composer `/plan`, draft retention across panes
  and Settings, scheduled Claude delivery, provider delegation, PR watches waking on merge
  (`PullRequestWatchReactor` `merged`), floating and fullscreen preview keeping composer focus, and
  capture host recovery after its renderer dies (`DesktopBrowserCaptureHost.ts`).
- **Antigravity tool budget.** `agy` silently drops MCP tools whose declaration exceeds about
  2 KiB after it adds its own description prefix, a `toolSummary` parameter (about 300 B together)
  and `<`/`>` escaping. Upstream often adds or grows tools. After merging, check the
  compact sizes in `apps/server/src/mcp/advertisedJsonSchema.ts` against that real ceiling, not the
  current constants, and keep the compaction described in the custom behavior doc.
- **Dependencies.** Use the repo's package manager and `engines.node` (26.13.1), not the shell's
  Node: local tests failed under Node 24 and Linux packaging under 26.12.1. Keep the patched
  `node-pty` pin and matching Effect patches; regenerate the lockfile only through `vp i`.

## 5. Verify

Targeted checks only; CI owns the full suites. Per AGENTS.md:

- `vp run check:changed` and `vp run typecheck` for affected packages
- `bash scripts/fork/check-browser.sh`
- focused tests for every conflict you hand-resolved and every step 2 item the merge touched,
  including `apps/server/src/mcp/advertisedJsonSchema.test.ts` and the capture host test
- a live boot: `vp run dev` (or `dev:desktop --home-dir .t3` for desktop-only behavior) on the
  migrated copy, then exercise the step 4 hotspots with the `test-t3-app` skill. The live check
  caught floating fullscreen stealing composer focus after source had already landed.

Fix regressions on the integration branch as separate commits
(`fix: preserve <behavior> across the <tag> update`). Update the custom behavior doc for any
intentional change. Do not change a custom test's expectation to make upstream pass.

## 6. Land

Rebase or merge onto current `origin/main` if it moved, rerun `vp run check:changed`, then
fast-forward `main` in the primary checkout and push. No PR unless Hamish asks. Remove the
worktree and branch after the push.

## 7. Release (scope `release` or `everywhere`)

From Jeff's own login session, not over SSH (signing fails with `errSecInternalComponent`):

```sh
readlink ~/.t3-promotions; df -h ~       # must be a real internal directory with room
vp run release:panes --preseed fred      # never with --no-wait, which skips the preseed
```

Fred downloads GitHub assets slowly, which is why the preseed exists. Wait for the workflow to
publish, then confirm with `gh release view <tag> --repo h-gilbert/t3code-panes` that the release
is not a draft and has the Mac zip, `latest-mac.yml`, the Linux archive and `SHA256SUMS`.
If the signing preflight asks for `--allow-signing-change`, stop and ask Hamish: that path needs
a one-time local promotion. The release version takes upstream's desktop package version, so it
can lag the nightly's version number; that is expected. Do not improvise installers
(`launchctl submit` restarted Jeff repeatedly) or bypass the published-release flow.

## 8. iPhone (scope `everywhere`)

Follow the iPhone runbook with the same pinned tag:
`python3 scripts/ios-local.py update --upstream-tag <tag> [--allow-nightly]`, then `check`,
`build`, `install`. Preserve uncommitted work in `.t3/ios/source` before updating, never reset the
private branch, and keep approval, input and failure alerts only (no completion alerts, no Live
Activities). `prebuild --clean` resets manual signing: reapply the existing development profile.
If Jeff cannot reach the phone, install the recorded build through the Air.

## 9. Report

Report each machine separately: source merged, pushed, published, preseeded, installed and
running are different states. Include the upstream tag and SHA, what was adapted by hand,
intentional omissions, checks that ran, what is unverified, and what waits on Hamish's update
button. Do not use `scripts/fork/apply-browser-update.py`; it targets a retired Alpha build.
