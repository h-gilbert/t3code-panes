# Custom behavior to preserve

These requirements describe this fork's intended behavior. Use them when adapting
upstream changes, including changes that apply without textual conflicts. This
is not an exhaustive file list: inspect local history and uncommitted changes
for other customizations before each update.

## New-thread model

New threads follow the saved default model (project override, then environment
setting), as upstream does, including when reusing an empty draft or switching its
project; explicit model picks in a draft remain intact. The developer sets the
default in Settings, so do not reintroduce a hard-coded new-thread model. The shared
Codex fallback model is Sol, and the provider prefers GPT-6 Sol over Astra and
older Sol when available.

Workspace panes hide the Git toolbar. Switching a draft to another environment
must clear its old branch and worktree context and use that environment's current
checkout. Restored pane drafts with an incomplete worktree selection can send in
the current checkout too. Preserve explicit branch selections, existing worktrees,
and the full chat view's worktree controls.

## Collaborative browser

- Agent browser automation defaults to background work. Preserve Playwright availability
  and use headless automation for routine checks. Codex and Claude receive this guidance
  even without the T3 MCP attached. Show pages for explicit user requests or necessary
  human interaction. Auto-show defaults off; preserve saved preferences and explicit
  `open`/`show` overrides.
- Visible agent-opened previews start at a fixed 320 × 200 in the owning pane's top-right
  corner. They cannot be dragged or resized. Their only toolbar actions are open
  a floating window above the panes, fullscreen, and close.
- Only the explicit floating window can be dragged and resized across pane boundaries.
  It can return to the compact preview. Fullscreen restores the previous mode.
  Keep floating resize targets at the outer edge of the native guest rectangle; neither
  mode has a resize footer. Scale the page into the compact preview; floating and fullscreen
  views fill the content area without letterboxing. Hide the device toolbar in these views.
- Coalesce drag movement to display frames. Do not read layout or rerun the window
  clamping effect for every pointer event.
- Browser chrome interaction must not select its owning pane through React portal events.
- Agent clicks, typing, key presses, scrolling, and navigation must leave the user's
  composer focus and text intact, including when the browser belongs to the same
  pane. Preserve intentional human focus when the user clicks into the browser.
- The preview header stays reachable. Its close button immediately ends the browser session.
  Agent `preview_close` also ends the shared session across connected clients.
- Localhost URLs on remote environments resolve to that environment's private
  host, preserving port, path, query, and fragment. Local environments remain
  local. Unsupported public relay port routing must report an error.
- Keep persistent browser sessions, named profiles, ephemeral sessions, and
  keychain-backed saved logins with the existing autofill/script isolation.
- Keep explicit viewport controls and native guest layering, hidden-preview
  performance protections, host recovery, and navigation focus protection.
  Preserve local paste and context-menu work when integrating desktop changes.
- Every workspace window can host the browser. A webview tag cannot move between
  windows, so each tab belongs to one window in the desktop process. Other windows
  show no guest for it. Showing the tab in the focused window claims it, which reloads
  the page there; a recording tab stays put. Agent requests for a tab another window
  owns are relayed to that window. Do not reintroduce a single "main window" that
  rejects guests from other windows; that left previews stuck reconnecting.

The opening default lives in `apps/web/src/previewMiniPlayerStore.ts`, the header
and fullscreen presentation in `components/preview/ThreadPreviewMiniPlayer.tsx`
under that same `src` directory, and routing in `browser/browserTargetResolver.ts`.
Desktop session and login behavior lives in `apps/desktop/src/preview/`, including
tab ownership in `Manager.ts`; the cross-window request relay is
`components/preview/previewAutomationRelay.ts`.

Run the affected tests, starting with `previewMiniPlayerStore.test.ts`,
`ThreadPreviewMiniPlayer.test.ts`, `browserTargetResolver.test.ts`, and
`hostedBrowserWebviewStyle.test.ts` in `apps/web/src`. Tests must protect these
requirements; changing assertions to accept a regression is not a resolution.

## Mobile thread order

The mobile home list and iPad sidebar sort active threads by the latest user
prompt or turn completion. Intermediate tool activity, streaming messages, and
metadata updates must not reorder rows or reset their relative age labels.
Explicitly un-settling a thread still brings it to the top. Preserve pinned ordering and the separate snoozed and settled
sections. Explicit manual active ordering takes precedence over the default activity order.
This differs from the web and desktop creation-based default order. Keep the
private iOS source in sync when changing this behavior.

## Conversation layout

The composer occupies layout space below the timeline after the first message.
Only the empty-draft hero overlays the view. Keep the latest streamed content
visible without covering it, and stop following when the user navigates history.
Changed-file cards stay out of assistant messages; file changes remain available
through the diff panel.

## Other custom behavior

- Preserve pane workspaces, independent window restoration, thread settlement,
  and multi-environment selection described in `docs/user/project-workspaces.md`.
- Preserve retained terminal sessions and reconnect behavior described in
  `docs/internals/terminal-runtime.md`.
- Preserve the separate private iOS branch and its normal push notifications for approval, input,
  failure, and completion of turns submitted from iOS. Web/desktop completions stay quiet, with no Live Activities or Dynamic Island integration. Follow
  `docs/operations/local-ios-updates.md` and its existing policy checks.
- Updating source does not authorize replacing or restarting the installed app.
  Follow `docs/operations/local-desktop-promotion.md` for a requested promotion.
