# Fork compatibility

This fork keeps pane workspaces, independent desktop windows, saved browser logins and a private
mobile build alongside the upstream clients and provider adapters. Follow the
[upstream integration runbook](../operations/upstream-integration.md) when bringing in original
T3 Code changes. Refresh this document as lasting custom constraints change; it is not an exhaustive
inventory of every change in the fork.

## Threads and windows

Pane assignments, draft state and focused panes belong to a workspace window. Changing the sidebar
project scope also changes that window's focused pane. Closing a view or window leaves thread work
running. The browser host moves to a surviving window when its original window closes.

The server owns automatic settlement. Settling releases provider sessions and managed terminals;
a queued settlement cleanup checks that the thread has not resumed before stopping resources.
The separate archive worker archives threads only after they have remained settled for seven days.
Clients must not materialize a time-derived settlement themselves.

The composer is docked below the timeline and reserves its own layout space. Only the empty-draft
hero overlays the view. Live-tail size changes keep following active until the user navigates away.

Conversation folding keeps the first assistant message visible. Changed-file cards remain hidden
in the conversation; file changes are available through the diff panel. New threads use Codex GPT-6 Sol at medium reasoning effort for every project. Saved defaults do not override it;
explicit model picks in a draft remain intact. The default permission mode remains Auto unless an
environment or project explicitly overrides it; existing draft choices stay intact. Mobile's default active order follows prompts and completed turns, never streaming
or tool activity. Explicit manual ordering remains available.

Saved streaming choices survive upgrades to the turn/paragraph/token selector. The disk loader
maps either legacy Boolean to token or turn mode; an explicit new mode takes precedence. Do not
import upstream's intentional reset to paragraphs over saved preferences.

## Browser presentation

Browser automation stays in the background by default, including when only external browser tools
are available. Preserve saved auto-show preferences and explicit visibility overrides.

Visible previews start at a fixed 320 × 200 in the pane's top-right corner. Only the floating window
can move or resize, with handles outside the native guest rectangle on every edge. Fullscreen
restores the preceding mode. Compact previews scale the source; floating and fullscreen views fill
the available space. Keep the header reachable and the three actions for floating, fullscreen,
and closing the session. Browser interaction and automation must preserve composer focus and text.
Device streams use their own aspect-ratio-aware floating viewer; they must not replace the browser's
fixed-preview and window restoration behavior.

## Browser storage

Snapshots carry both legacy `browserScope` and managed `profileId`. A legacy scope takes precedence
when both are present. Its partition hash remains unchanged so existing cookies survive upgrades.
The built-in default profile keeps the original environment partition. Other managed profiles use
a separate partition namespace with a JSON tuple of environment and profile IDs.

Saved credentials remain bound to an environment and exact origin. Legacy profile names and managed
profile IDs are separate identity fields, even when their text matches. Credential document version
3 reads versions 1 and 2, preserving their identities. Old unclaimed entries can only be claimed by
a matching legacy or shared session. Passwords remain in the desktop process, protected by the OS
keychain. Autofill keeps the document-level script guard until full navigation.

Clearing cookies or cache from a tab targets its actual storage scope. Explicit managed profile
requests cannot reuse a tab from another profile, including a provider's pinned tab.

## Database migrations

Migrations 1 through 43 keep their existing numbers and contents. In particular, 41 records title
source, 42 adds authentication client connections and 43 records when a thread was unsettled.
The linked-pull-request migration is 44, followed by project auto-pull at 45, settlement timestamp
repair at 46, project icons at 47, branch pull requests at 48 and manual active ordering at 49. Multiple thread pull requests use migration 50; message context uses 51; thread title state uses 52. The upstream migration that clears automatic project model
defaults is omitted so saved project choices remain intact. Manually assigned titles remain protected
from automatic title generation.

## Distribution

Self-hosted mobile builds retain direct pairing and APNs registration, private signing identifiers,
and no managed Clerk, relay or OTA configuration. Live Activities remain removed. Personal and
self-hosted iOS builds do not include the share extension.

Custom desktop artifacts use a local version suffix and omit stock update feeds. Desktop and server
update handlers reject stock self-updates for custom versions. Use the
[local promotion runbook](../operations/local-desktop-promotion.md) for installed app updates.
SSH launch still resolves published server packages when the desktop version is unpublished.
