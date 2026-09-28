# 28. Scheduled prompts run as serial chat turns

Date: 2026-07-02
Status: Accepted

A scheduled turn is a stored prompt run once or recurrently through the normal
agentic path. This permits reminders that also use tools without separate briefing
or reminder implementations, at the cost of a model call for each firing.

## Scheduling and cancellation

The `schedule_turn`, `list_scheduled`, and `cancel_scheduled` tools require the
initiator's `schedule_turns` capability. The Mini App provides list/cancel actions
that do not depend on model interpretation. Creation stays conversational.

Store recurring rules as local-time cron plus an IANA timezone. Croner calculates
the next occurrence, registered as a one-off SDK schedule; a UTC recurrence would
drift from the requested local hour across DST. Query SDK schedules by callback
and task ID for cancellation/replacement, without a parallel alarm mapping table.

Register the next occurrence before executing the current one so model or tool
failure does not stop recurrence. A failed firing is visible and is not retried
automatically; a failed one-off remains inspectable. Active-task and recurrence
limits live in [scheduled-turns.ts](../../src/features/agent/scheduled-turns.ts).

## Execution

All entry points share the SDK's persisted serial turn queue with `maxAttempts: 1`.
Replaying a whole turn could repeat tool side effects. A maximum-wait escape that
runs work concurrently would reintroduce history races, so it is omitted.

A scheduled turn includes its provenance and persists in conversation history for
follow-ups. Recheck the initiating Principal's access when work runs. Feed and
email reader tools remain independently capability-gated; scheduling does not
expand permission. See [Principal](0031-principal-module-invited-allowlist.md) and
[transcript delivery](0021-transcript-reply-multi-message-agentic-turn.md).
