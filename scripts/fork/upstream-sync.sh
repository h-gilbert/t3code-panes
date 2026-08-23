#!/usr/bin/env bash
#
# upstream-sync.sh — survey upstream commits this fork is missing and report,
# for each one, whether it applies cleanly and whether it touches files this
# fork has customized (e.g. the pane work).
#
# Read-only by default: it fetches upstream and test-applies each candidate in a
# throwaway git worktree, so your working tree and branches are never touched.
#
# Usage:
#   scripts/fork/upstream-sync.sh                # report everything missing
#   scripts/fork/upstream-sync.sh --safe-only    # only CLEAN commits that don't touch fork files
#   scripts/fork/upstream-sync.sh --type feat    # filter by conventional-commit type (feat/fix/perf/...)
#   scripts/fork/upstream-sync.sh --picks         # print ready-to-run `git cherry-pick` lines for the safe set
#
# Env:
#   UPSTREAM_REMOTE (default: upstream)
#   UPSTREAM_BRANCH (default: main)
#   LOCAL_BRANCH    (default: current branch)

set -euo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
LOCAL_BRANCH="${LOCAL_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

SAFE_ONLY=0
PICKS=0
TYPE_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --safe-only) SAFE_ONLY=1 ;;
    --picks) PICKS=1 ;;
    --type) shift; TYPE_FILTER="${1:-}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo "Fetching ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}..." >&2
git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
FORK_POINT="$(git merge-base "$LOCAL_BRANCH" "$UPSTREAM_REF")"

# Files this fork has customized since the fork point. A commit that touches any
# of these is flagged as potentially colliding with your work (e.g. panes).
FORK_FILES="$(git diff --name-only "$FORK_POINT".."$LOCAL_BRANCH" | sort -u)"

# --cherry-pick --right-only omits upstream commits whose patch already landed on
# this fork under a different SHA (i.e. earlier cherry-picks), so re-running the
# survey after a sync doesn't re-list what you already took.
MISSING="$(git log --reverse --no-merges --cherry-pick --right-only --format='%H' "${LOCAL_BRANCH}...${UPSTREAM_REF}")"

if [ -z "$MISSING" ]; then
  echo "Up to date with ${UPSTREAM_REF}. Nothing to sync." >&2
  exit 0
fi

# Isolated worktree so the live tree is never touched.
WT="$(mktemp -d -t t3-forksync.XXXXXX)"
rm -rf "$WT"
git worktree add --detach "$WT" "$LOCAL_BRANCH" --quiet
cleanup() { cd "$REPO_ROOT"; git worktree remove --force "$WT" >/dev/null 2>&1 || true; git worktree prune >/dev/null 2>&1 || true; }
trap cleanup EXIT
(
  cd "$WT"
  git config user.email fork-sync@local >/dev/null
  git config user.name fork-sync >/dev/null
)

SAFE_PICKS=""

printf '\n%-9s %-7s %-6s %s\n' "APPLY" "TYPE" "SEC/PF" "COMMIT"
printf '%s\n' "--------------------------------------------------------------------------------"

while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  subj="$(git log -1 --format='%s' "$sha")"

  # Conventional-commit type from the subject, e.g. feat(web): ... -> feat
  type="$(printf '%s' "$subj" | sed -n 's/^\([a-z]*\)\(([^)]*)\)\{0,1\}!\{0,1\}:.*/\1/p')"
  [ -n "$type" ] || type="?"
  if [ -n "$TYPE_FILTER" ] && [ "$type" != "$TYPE_FILTER" ]; then
    continue
  fi

  # Security / performance signal from the subject line.
  secpf=""
  case "$subj" in
    perf*|*perf\(*) secpf="PERF" ;;
  esac
  if printf '%s' "$subj" | grep -qiE 'crash|oversiz|overflow|leak|hang|stuck|lingering|\bkill|auth|credential|token|secret|sanitiz|escap|inject|https|CVE|vuln|denial|dos\b'; then
    [ -n "$secpf" ] && secpf="SEC/PF" || secpf="SEC?"
  fi
  [ -n "$secpf" ] || secpf="-"

  # Which files does this commit change, and do any overlap fork-customized files?
  commit_files="$(git show --no-renames --name-only --format='' "$sha" | sed '/^$/d' | sort -u)"
  overlap="$(comm -12 <(printf '%s\n' "$commit_files") <(printf '%s\n' "$FORK_FILES") || true)"

  # Test-apply in the isolated worktree.
  apply="CLEAN"
  conflict_files=""
  (
    cd "$WT"
    git reset --hard "$LOCAL_BRANCH" --quiet
    git cherry-pick -n "$sha" >/dev/null 2>&1 || true
    git diff --name-only --diff-filter=U
    git cherry-pick --abort >/dev/null 2>&1 || true
  ) >"$WT/.conflicts" 2>/dev/null || true
  conflict_files="$(sed '/^$/d' "$WT/.conflicts" | sort -u)"
  [ -n "$conflict_files" ] && apply="CONFLICT"

  touches="no"
  [ -n "$overlap" ] && touches="YES"

  if [ "$SAFE_ONLY" -eq 1 ] && { [ "$apply" != "CLEAN" ] || [ "$touches" = "YES" ]; }; then
    continue
  fi

  short="$(git rev-parse --short "$sha")"
  printf '%-9s %-7s %-6s %s\n' "$apply" "$type" "$secpf" "$short $subj"
  if [ "$touches" = "YES" ]; then
    printf '          ↳ touches your fork files: %s\n' "$(printf '%s' "$overlap" | tr '\n' ' ')"
  fi
  if [ "$apply" = "CONFLICT" ]; then
    printf '          ↳ CONFLICTS in: %s\n' "$(printf '%s' "$conflict_files" | tr '\n' ' ')"
  fi

  if [ "$apply" = "CLEAN" ] && [ "$touches" = "no" ]; then
    SAFE_PICKS="$SAFE_PICKS $short"
  fi
done <<EOF
$MISSING
EOF

if [ "$PICKS" -eq 1 ] && [ -n "$SAFE_PICKS" ]; then
  printf '\n# Safe set (CLEAN + does not touch fork files), oldest-first:\n'
  printf 'git cherry-pick%s\n' "$SAFE_PICKS"
fi

printf '\nLegend: APPLY=isolated cherry-pick result | SEC/PF=security or perf signal | ↳ lines = manual attention.\n' >&2
