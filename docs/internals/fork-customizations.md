# Custom behavior to preserve

These requirements describe this fork's intended behavior. Use them when adapting
upstream changes, including changes that apply without textual conflicts. This
is not an exhaustive file list: inspect local history and uncommitted changes
for other customizations before each update.

## Server ownership

Only one server may open a state directory, including during boot-service,
SSH, desktop, and CLI startup races. Acquire ownership before database and
provider initialization. A discovery-file warning is insufficient: the command
model is process-local, so two servers sharing SQLite can show saved threads
while rejecting commands for them. Reconnecting must not silently retire a live
duplicate and switch to a server with stale command state.

## Agent settings changes

Agents may propose server settings changes through T3, but every proposal needs an
explicit approval showing the target environment, reason and exact changes. Keep
this approval in the app, independent of provider approval policies, so full access
cannot skip it. Approval applies only to the requesting run and the specific change.
Declined, cancelled or interrupted requests must not write settings.

## New-thread model

Selecting the shared default in Settings sets one model and thinking budget across connected
environments. It takes precedence over project and environment defaults, including
when reusing an empty draft or switching projects. Explicit model picks in a draft
remain intact. Pane model pickers only select the current thread model; shared default
controls belong in Settings. Clearing the shared default restores project
and environment defaults. Do not reintroduce a favorites list or a hard-coded
new-thread model. The shared Codex fallback model is Sol, and the provider prefers
GPT-6 Sol over Astra and older Sol when available.

New threads use the resolved project and environment access default. Preserve explicit thread access choices. Provider changes and delegated tasks must not silently substitute a lower access mode when the selected mode is unsupported; report the incompatibility instead.

Workspace panes hide the Git toolbar. Switching a draft to another environment
must clear its old branch and worktree context and use that environment's current
checkout. Restored pane drafts with an incomplete worktree selection can send in
the current checkout too. Preserve explicit branch selections, existing worktrees,
and the full chat view's worktree controls.

Empty panes use one project and thread browser, without a duplicate header picker.
Selecting a project shows its open threads and settled history; All open threads
spans connected projects and environments. Keep search, project hiding and
restoration, and new-thread creation available. Open threads already visible in a pane are excluded from the browser and its
counts. They become available again when that pane is cleared. Settled history
remains available, with pane markers for settled threads still visible in a pane.

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
- Agent HTML file uploads and browser downloads must not open native file dialogs.
  From an agent's latest action until a person next uses the tab, HTML file pickers wait for
  `preview_upload` and downloads wait for
  `preview_download` (`apps/desktop/src/preview/FileTransfer.ts`). Pickers a person opens
  still get an Open dialog, and their downloads still ask where to save. Files cross
  machines over HTTP, never the WebSocket. Shared browser hosts use a private
  HTTP transfer bound to their authenticated connection; never expose a public
  CDP endpoint or assume the two hosts share a disk.
- Keep persistent browser sessions, named profiles, ephemeral sessions, and
  keychain-backed saved logins with the existing autofill/script isolation.
  An explicitly selected shared desktop host uses that host environment's existing
  profile partitions. Disconnection must fail rather than launch headless with
  different logins. The host lives in the desktop renderer, so a hidden window
  must keep its connections: keep Chromium's `IntensiveWakeUpThrottling` disabled
  (`apps/desktop/src/app/DesktopPreReadyPlatform.ts`), or the heartbeat drops it
  each minute. The host must also render tabs of threads nobody has open; it follows
  the hosted environment's preview events in `apps/web/src/browser/RemoteBrowserHosts.tsx`.
  Browser proxy settings apply only to preview sessions, with no direct fallback,
  including for localhost destinations.
- Keep explicit viewport controls and native guest layering, hidden-preview
  performance protections, host recovery, and navigation focus protection.
  Hidden desktop guests must temporarily composite behind the app when a server
  requests capture, then release that activity when the turn ends. Merely disabling
  throttling or leaving an offscreen guest visible does not produce capture frames.
  Preserve local paste and context-menu work when integrating desktop changes.
- Every workspace window can host the browser. A webview tag cannot move between
  windows, so each tab belongs to one window in the desktop process. Other windows
  show no guest for it. Showing the tab in the focused window claims it, which reloads
  the page there; a recording tab stays put. Agent requests for a tab another window
  owns are relayed to that window. Do not reintroduce a single "main window" that
  rejects guests from other windows; that left previews stuck reconnecting.

Simulator and emulator previews open inset inside their owning thread, including embedded panes.
Physical devices stay hidden; their automation sessions and screenshots remain available.
Agents can reveal the same running device again or change its presentation without
rebooting it. Keep reveal requests distinct from device ownership: hiding a preview
must leave the device and agent session running. Fullscreen restores the previous view.
The fork disables the tool sidebar. Targeted device/browser tabs restore inset,
including legacy panel requests; other thread tools use a centered overlay.

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

In web and desktop, dropping, pasting, or choosing image attachments shows their
previews without inserting inline image chips into the prompt, even when it
already contains text. Preserve this when integrating upstream composer changes.

## Other custom behavior

- Preserve pane workspaces, independent window restoration, thread settlement,
  and multi-environment selection described in `docs/user/project-workspaces.md`.
  Web/desktop thread routes must land in panes. Subagents navigate within the originating pane
  with Back history; project lists exclude them and show running descendant counts on parents.
  A single running agent opens directly; multiple agents open a menu of their threads.
  Pane headers omit thread details, terminal and right-panel toggles, and never show the old
  details popover. Message markers fit the pane height with space at both ends and scroll
  independently when they overflow, without scrolling the conversation.
  Navigation and settings overlay the mounted panes instead of replacing the workspace.
  Settings use upstream's section routes and modal sidebar, with the fork's custom controls.
  Opening or dismissing Settings must retain pane drafts and scroll positions.
- Preserve retained terminal sessions and reconnect behavior described in
  `docs/internals/terminal-runtime.md`.
- Preserve the separate private iOS branch and its normal push notifications for approval, input,
  and failure only. Completion alerts stay off, including for turns submitted from iOS, with no
  Live Activities or Dynamic Island integration. Follow
  `docs/operations/local-ios-updates.md` and its existing policy checks. Send the private
  `ios` origin only when the destination advertises `iosTurnOrigin`; older servers reject
  that value, so use `mobile` there.
- Updating source does not authorize replacing or restarting the installed app.
  Follow `docs/operations/fork-releases.md` for an authorized release and
  `docs/operations/local-desktop-promotion.md` for a requested one-off local install.

Queued web and desktop follow-ups wait for the next completed tool call or the end
of the turn, including when the thread is offscreen. Deliver at most one per tool
boundary, and hold delivery during pending approval or input. The server owns the
durable queue; Stop returns messages, attachments and context to the composer,
keeping attachment overflow held. Queue edits retain the original model selection.
