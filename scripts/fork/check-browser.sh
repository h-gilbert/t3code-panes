#!/usr/bin/env bash
# Focused checks for this fork's collaborative browser behavior.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo_root="$PWD"
cd "$repo_root/apps/web"
"$repo_root/node_modules/.bin/vp" test run \
  src/previewMiniPlayerStore.test.ts \
  src/components/preview/ThreadPreviewMiniPlayer.test.ts \
  src/components/preview/previewMiniPlayerLayout.test.ts \
  src/browser/browserSurfaceStore.test.ts \
  src/browser/browserViewportLayout.test.ts \
  src/browser/browserTargetResolver.test.ts \
  src/browser/hostedBrowserWebviewStyle.test.ts
cd "$repo_root/apps/desktop"
"$repo_root/node_modules/.bin/vp" test run \
  src/preview/Manager.test.ts src/preview/WebviewPreferences.test.ts
