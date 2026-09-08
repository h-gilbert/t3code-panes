# Staying in sync with upstream t3code

This is a fork of [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code). Our
own work is concentrated in the coding **workspace / panes** feature, which
lives in exactly the files upstream churns most (the chat composer, message
timeline, chat header, `index.css`). That overlap is the whole risk: a careless
merge can quietly undo pane work.

Before starting, read [custom behavior requirements](../internals/fork-customizations.md),
inspect `git status`, and review local commits affecting the incoming changes.
Preserve uncommitted work. The requirements are a starting point, not an exhaustive
inventory of customizations.

The rule of thumb for this fork:

- **Backend, security, and performance changes** → bring them across. Review their effects on custom behavior,
  including browser routing, provider instructions, and shared contracts.
- **UI changes** → skip by default. Take one only when a feature you actually
  want needs it, and resolve it against the pane layout deliberately.

## The survey tool

`scripts/fork/upstream-sync.sh` fetches upstream and, for every commit this fork
is missing, reports:

- **APPLY** — `CLEAN` or `CONFLICT`, decided by test-applying the commit in a
  throwaway git worktree. Your working tree and branches are never touched.
- **TYPE** — the conventional-commit type (`feat`, `fix`, `perf`, …).
- **SEC/PF** — a security or performance signal parsed from the subject.
- **↳ touches your fork files** — the commit changes a file this fork has
  customized since the fork point. This is the pane-collision warning. It is
  computed live from `git diff <fork-point>..<branch>`, so it always reflects
  whatever you currently customize — no hardcoded list to maintain.
- **↳ CONFLICTS in** — the files that actually failed to merge.

A commit that is `CLEAN` with no file overlap is only a lower-risk candidate.
The survey compares committed file changes, so it can miss uncommitted work,
changes through callers or shared contracts, and behavior reversals that merge
cleanly. Never take the printed set blindly. Review dependencies and intended
behavior before applying it; the survey tests commits individually, not together.

### Commands

```bash
# Full survey of everything you're missing
scripts/fork/upstream-sync.sh

# Just the safe set, with a ready-to-run cherry-pick line
scripts/fork/upstream-sync.sh --safe-only --picks

# Filter to one type
scripts/fork/upstream-sync.sh --type perf
scripts/fork/upstream-sync.sh --type feat
```

The survey uses `git log --cherry-pick`, so commits you already cherry-picked
(under a new SHA) drop off automatically on the next run.

## The routine

Run this roughly weekly — the longer you wait, the more the pane files diverge
and the more conflicts pile up.

1. **Survey.** `scripts/fork/upstream-sync.sh --safe-only --picks`. Review the
   safe set; it's usually backend/CI/perf.

2. **Take the safe set.** Branch first, then paste the printed cherry-pick line:

   ```bash
   git switch -c sync/upstream-$(date +%Y-%m-%d)
   git cherry-pick <the printed SHAs>
   ```

3. **Work the flagged commits deliberately.** Re-run without `--safe-only` to see
   everything. For each `perf`/`fix`/`feat` you want that is flagged:
   - For every overlap, compare the upstream intent with local history and the
     custom behavior requirements. Adapt the upstream fix while retaining the
     custom behavior, even when Git reports no conflict.
   - If it conflicts in a **test file**, preserve coverage of both intended
     behaviors. Do not delete custom regression tests or change their expected
     behavior merely to make the incoming change pass.
   - If it conflicts in a **pane runtime file** (`MessagesTimeline*`,
     `ChatComposer`, `ChatHeader`, `ChatView*`, `composer*`, `workspacePane*`,
     `index.css`), resolve by hand and keep the pane behavior. When in doubt,
     open the upstream PR and understand the intent before resolving.
   - **Migrations always collide.** Upstream and this fork both number migrations
     from the same sequence. Renumber the _incoming_ migration to the next free
     number — never renumber one of ours, since ours may already be applied to
     live databases. Update the file names, the `Migrations.ts` import and
     registration row, and any `toMigrationInclusive:` in its test.

   - Resolve compatible changes without another permission round. If the two
     intended behaviors cannot coexist, explain the concrete tradeoff and ask
     for a decision before removing a customization.

4. **Verify the scope you touched**, including affected custom behavior and
   callers outside the changed files. Targeted only — CI owns the full suite:

   ```bash
   (cd apps/web && node_modules/.bin/tsgo --noEmit)      # or: apps/server
   node_modules/.bin/vp test run <files you touched>
   ```

5. **Report the integration.** State which custom behaviors were preserved, how
   overlapping changes were adapted, what was deferred, and which checks passed.
   Update the custom behavior requirements for intentional behavior changes.
   Land the sync only within the developer's requested scope. Source updates do
   not authorize restarting or replacing the installed app.

   For browser changes or overlapping callers, run `bash scripts/fork/check-browser.sh`.
   Also verify the fixed compact preview, floating movement, fullscreen restoration,
   edge-to-edge content, and uninterrupted composer typing in the desktop dev app.
   Get permission for that interactive check under `AGENTS.md`; if it cannot be run,
   report it as unverified instead of claiming the browser behavior survived.

6. **Skip pure UI.** Leave appearance/menu/polish commits on the shelf unless a
   feature you want depends on one.

## Notes

- `upstream` remote must point at `https://github.com/pingdotgg/t3code.git`.
- Override the remote/branch/base with `UPSTREAM_REMOTE`, `UPSTREAM_BRANCH`,
  `LOCAL_BRANCH` env vars if needed.
- The "touches your fork files" heuristic is intentionally broad: it flags on any
  overlap, including test files and docs. Broad-but-noisy beats missing a real
  pane collision.
