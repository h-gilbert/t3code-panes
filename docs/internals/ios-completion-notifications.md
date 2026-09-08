# iOS turn completion notifications

The private mobile app supplies `clientOrigin` on each start-turn command. Both
immediate project creation and outbox delivery supply the submitting platform.
The decider persists this field in `thread.turn-start-requested`; older commands
and events omit it and do not qualify as iOS submissions.

Self-hosted APNs delivery resolves the completed turn through `projection_turns`.
Its `pending_message_id` identifies the persisted start request. This avoids
treating thread creation, the latest connected client, or an in-memory flag as
the origin, and continues working after a server restart. Provider adapters do
not need changes.

The private device registers `notifyOnCompletion: false` and the optional
`notifyOnIosCompletion: true`. Existing servers ignore the new preference and
keep completion alerts off. Updated self-hosted servers check the exact turn's
origin before sending its completion alert. Managed relay notification delivery
does not implement the new preference and remains silent for completions.

Notification transitions use the changed thread's state rather than the five-row
Live Activity display aggregate, so that display limit cannot hide an alert.
Existing freshness and phase-transition checks still suppress stale or repeated
completion alerts. Approval, input, and failure preferences are unchanged.

Deploy the server support to each connected self-hosted environment, then open
the updated phone app to refresh device registration. A mobile binary update
alone cannot change an environment's push delivery policy.
