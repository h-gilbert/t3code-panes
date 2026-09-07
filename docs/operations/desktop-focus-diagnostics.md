# Investigating desktop focus loss

Desktop builds record native focus evidence in the existing rotating
`<T3 home>/userdata/logs/desktop.trace.ndjson` files. Search span names
`desktop.focus.workspace`, `desktop.focus.renderer`, and `desktop.focus.preview`. This requires a build
containing the diagnostics; changing source does not instrument an already
running installed app.

Workspace records identify the window, workspace, renderer WebContents, event
timestamp in Unix milliseconds (`observedAt`), currently focused WebContents,
and the age and kind of the last observed input. Input timestamps update in
memory; individual keystrokes do not produce logs. Records contain no keys,
typed text, selectors, page content, or URLs.

Renderer records capture DOM focus events as well. They classify the target,
related target, and active element as composer, browser, input, or other, and
include pane indices and browser runtime tab IDs where available. This is
necessary because a CDP click can move the renderer's active element from a
composer to a webview without Electron emitting native WebContents focus events.
They retain only the kind and time of the most recent keyboard or pointer input.

Preview records identify the runtime tab and guest WebContents. The runtime
tab ID encodes `[environmentId, threadId, serverEpoch, tabId]`, so it can be
joined to the owning thread's tool history. Records include automation start
and end, guest focus and blur, main-frame navigation start, and focus restored
by the existing automated-click guard. Focus records retain the last action
and its age after completion, allowing investigation of delayed page activity.
Guest input classified as agent input by the existing control logic is excluded
from the human-input timestamp. This classification is heuristic, not proof of
physical input.

For a reported interruption:

1. Find DOM composer blur or workspace renderer/window blur near the reported time. A recent
   key-input timestamp establishes that typing preceded the focus change.
2. Match guest focus by timestamp and WebContents ID, then inspect the action
   and thread. A `click-focus-restored` event distinguishes an attempted transfer
   caught by the existing guard from an uncorrected transfer.
3. For window blur without a corresponding T3 focus destination, inspect thread
   tool calls at that time for external browser activity, such as Playwright
   opening a page. A null focused WebContents is an observation during the
   transition, not proof that an external app took focus.

These diagnostics do not change focus behavior. They do not record element
contents, caret position, or destination application outside Electron, and cannot
alone distinguish every intentional app switch from focus stealing. Native
events cover the desktop shell and its collaborative browser, including tabs
owned by remote environments. Standalone web and mobile clients are not
instrumented by these desktop diagnostics.
