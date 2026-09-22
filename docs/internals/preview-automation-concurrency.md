# Concurrent agents in one collaborative browser

Several provider sessions drive the same browser at once, each in its own tab,
sharing one persistent profile so they share the user's logins. Exclusivity is
split across two layers because the two things that cannot be shared have
different shapes, and putting either guard in the other's place breaks
multi-agent work.

## A tab, for one request

[`PreviewAutomationBroker`](../../apps/server/src/mcp/PreviewAutomationBroker.ts)
claims a tab for the duration of one exclusive request and releases it when that
request settles, however it settles. A tab is what two drivers can corrupt: one
`webContents`, one DOM, one navigation. Passive reads (`status`, `snapshot`,
`waitFor`) never claim and are never refused.

A session with no tab yet claims on its own session key instead, because
subagents share their thread's MCP credential — and therefore its
`providerSessionId` and the tab it resolves to. That is the one case where two
drivers genuinely land on one `webContents`.

Do not widen this to a per-environment lease with an idle window. That shape
blocked sessions whose tabs never touched each other, held the block for seconds
after the holder went quiet, and still let same-thread subagents interleave on
one tab. It also produced a `preview_status` that reported `available: true`
while every interaction failed, which is why status now carries
`heldByAnotherSession`.

## Native focus, for one application

Agent input is the one part of automation that is not per tab.
[`PreviewManager`](../../apps/desktop/src/preview/Manager.ts) hands a guest
native focus to dispatch a click and hands it straight back to whatever the
human was typing in, and native key presses target a guest widget the same way.
There is one focused `webContents` per application, so those dispatch windows
take `nativeInputSemaphore`, and a focused webview belonging to another tab is
never mistaken for the human's caret.

Adding an operation that moves native focus or sends native input means taking
that semaphore. Everything else — control sessions, CDP attachment, focus
emulation, input receipts, surface presentation — is already keyed by tab and
needs no coordination.
