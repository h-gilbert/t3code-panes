# Updating this fork from upstream

Use this workflow when asked to check for or integrate changes from the original T3 Code project.
The objective is current upstream functionality while retaining the developer's custom behavior.
Read [fork compatibility](../internals/fork-compatibility.md) before choosing an integration strategy,
then use [local desktop promotion](local-desktop-promotion.md) for installation.

## Scope and authority

A request to check for updates authorizes discovery and comparison. A request to implement upstream
updates authorizes integration and focused verification. A request that also includes updating the
installed app authorizes local promotion after the changes are reviewed and a safe restart boundary
is established. Honor approval already given in the conversation; do not ask for it again. These
requests do not by themselves authorize commits, pushes, tags, PRs or public releases.

Do not remove or change a custom behavior simply to match upstream. Hand-adapt overlapping changes
to preserve the behavior. If the two requirements cannot coexist, complete independent work and
explain the concrete tradeoff before asking the developer to choose. Do not silently skip the
upstream feature or silently replace the custom one.

## Establish the starting point

1. Inspect repository instructions, branch, worktrees, working tree, index and any merge or rebase
   already in progress. Preserve uncommitted work. Continue an existing integration when that is the
   active task; do not start a second merge over it. Never reset, clean, overwrite or automatically
   stash another task's work.
2. Verify remote URLs. The original project is `https://github.com/pingdotgg/t3code.git`; this fork's
   origin is separate. Do not infer upstream from the name `origin`, and do not rewrite a remote to
   make it match expectations without understanding the checkout.
3. Fetch upstream branch and tag information without pulling it into the working branch. Fetch tags
   into a separate namespace to avoid collisions with fork tags, for example:

   ```sh
   git fetch upstream '+refs/heads/*:refs/remotes/upstream/*' '+refs/tags/*:refs/upstream-tags/*'
   ```

   Check the original repository's current published releases as well as the fetched refs. Record
   the chosen release tag and resolved commit SHA. Prefer the latest stable published release;
   assess nightly and unreleased fixes separately and include them only when the requested scope
   or an identified dependency justifies it. Do not guess the newest release by lexical tag order.
   If network access fails, state that the comparison uses cached refs rather than calling it current.

4. Determine what has actually landed using ancestry, prior integration commits and patch-equivalent
   cherry-picks. A merge base alone does not describe manually adapted or selectively imported work.
   A fetched commit or an unfinished merge is not evidence that the installed app contains it.
5. For a new integration, use a separate worktree and branch based on the intended fork revision.
   Keep the original checkout and installed app available. If necessary source changes are still
   uncommitted, preserve their exact state and establish the intended base before branching; do not
   create a supposedly complete update from an older clean HEAD.

## Review upstream changes and custom behavior together

Read the release notes and the actual source diff, including provider protocols, contracts, migrations,
settings, defaults, packaging and dependency changes. Review changes beyond textual conflict files.
A clean merge can remove behavior just as easily as a conflicted one.

Refresh the custom-behavior inventory from the current fork diff, history, tests and developer
instructions. The compatibility document is a starting point, not proof that its list is exhaustive.
In particular, inspect these areas when affected:

- Workspace panes, independent windows, drafts, focus and thread identity; closing a view must not
  stop work and browser ownership must survive a host window closing.
- Browser mini preview, movable window and fullscreen transitions, viewport controls, origin-bound
  credentials, persistent cookies, legacy storage scopes and managed profile isolation.
- Provider/model/effort defaults, Astra capabilities, questions answered while a turn continues,
  pending input and approvals, background work, settlement, resume and cancellation semantics.
- Saved settings, manual thread titles, migrations, direct remote connections and private mobile
  distribution choices.
- Custom build identity, stock-update rejection and the local promotion workflow itself.

For each substantive upstream change, record whether it is already present, directly integrated,
manually adapted, intentionally omitted to preserve an explicit custom choice, or unresolved. Group
related commits by behavior so duplicate or superseded patches are not counted as missing features.
Keep working comparisons outside the repository; summarize the final decisions in the user report
or an already-authorized tracking item. Do not commit a second implementation checklist.

## Integrate without replacing custom behavior

Use a three-way comparison of the shared base, fork and pinned upstream target. A normal merge is
acceptable in the isolated worktree when it represents the intended scope. Selective patches are
appropriate for explicitly selected fixes. Neither strategy replaces behavioral review.

Never resolve broad conflicts with `--ours`, `--theirs`, a file wholesale copied from upstream, or
an upstream checkout over custom files. Resolve individual changes with an explanation of which
behavior each side contributes. Prefer adapting upstream's implementation to the fork's boundaries;
avoid maintaining two competing implementations of the same feature.

Preserve already-applied migration numbers and contents. Allocate new fork migration numbers for
new schema work and update the loader and tests consistently. Check the compatibility document's
intentional omissions before importing data resets or default-setting migrations. Test upgrade
paths against a disposable, consistent copy of existing state, never the live database.

Follow AGENTS.md for the full set of clients, providers, entry points and connection modes. Provider
protocol changes need explicit treatment of asynchronous questions and background work, including
what each adapter supports. Review changed contracts on server, web, desktop and mobile together.
Regenerate lockfiles only for intended dependency changes using the repository's package manager.
Do not work around integration failures by disabling safeguards or dropping regression tests.

## Prove both sides still work

Run focused tests for imported behavior and affected custom behavior, targeted lint and package-level
type checks. Add meaningful regression coverage for manually adapted backend behavior. Do not run
repo-wide checks unless the developer requests them. Select tests based on the changes, not a static
list that becomes stale as files move.

For touched workflows, test the state transitions that commonly disappear during updates: reopen
after close, restore a pane after restart, return from fullscreen to a movable browser, retain an
existing browser login, answer a question while background work continues, and resume a thread before
queued settlement cleanup executes. Test stored-data upgrades with existing records, not only an
empty database. Distinguish automated proof from behavior that still needs a real-client check.

Use the development desktop app for the integrated review before packaging. When another dev
instance is running, set `T3CODE_DESKTOP_DEV_USER_DATA_DIR` to a directory inside the isolated
T3 home so Chromium storage stays separate. Follow the repository's
permission rules for computer use and browser verification. Do not launch diagnostic servers against
production state or stop remote work to make verification easier. Preserve the original failing test
until the intended behavior is understood; do not change expectations merely to make upstream pass.

Update the compatibility document when a lasting custom constraint changes or a new one is added.
Keep it about intended behavior and compatibility traps rather than a list of copied commits.

## Hand off to local promotion

Report the upstream release and SHA, what was imported, what needed manual adaptation, intentional
omissions, validation results and remaining gaps. Do not describe the fork as fully compatible if
required checks failed or relevant behavior remains unverified.

When the developer is satisfied, follow the promotion runbook exactly:

```sh
vp run promote:desktop prepare
vp run promote:desktop status
# After a safe normal quit, and within the authorized installation scope:
vp run promote:desktop install --app '/absolute/path/to/installed/T3 Code.app'
```

Preparation does not commit or publish source. Install the prepared candidate without rebuilding it
from a different checkout. Keep the old bundle and state backups and verify the actual installed
version, server connection and pane restoration. Use the runbook's schema-aware rollback if needed;
never overwrite current state with an older backup automatically. Record source integration,
preparation and actual installation as distinct outcomes so the next agent can tell what remains.
