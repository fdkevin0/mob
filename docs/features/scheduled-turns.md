# Scheduled turns

A scheduled turn is a stored prompt that runs later, once or on a recurring
schedule, through the normal agentic turn with full tool access. It is used
for reminders and briefings, such as "every weekday at 8, summarize my feeds
and email".

## How it works

- The model creates a task with `schedule_turn`, passing exactly one of:
  - `when.at`: an ISO 8601 time, for a one-off; or
  - `when.recurrence`: a 5-field cron expression in **local time**, plus an
    IANA `timezone` (the default is `BOT_TIMEZONE`).
- [Croner](https://github.com/hexagon/croner) calculates the next occurrence,
  which is registered as a one-off Agents SDK schedule.
- When a recurring task fires, its next occurrence is registered **before**
  the current one runs, so a failure doesn't stop the series.
- The firing joins the chat's serial turn queue like any other turn. It is
  labelled as scheduled and saved to history, so follow-up questions work.
- The initiator's access is checked again when the task fires. Scheduling
  never grants extra permissions: tools like `list_recent_emails` still need
  their own capability.

## Usage

| Surface | Action |
| --- | --- |
| `schedule_turn` | Create a task (in conversation only) |
| `list_scheduled` | List tasks: ID, description, next run, recurrence, last error |
| `cancel_scheduled` | Cancel a task by ID |
| Mini App → Settings → Schedules | List and cancel without going through the model |

All three tools require the `schedule_turns` capability.

## Limits

| Limit | Value |
| --- | --- |
| Active tasks per chat | 10 |
| Minimum interval between recurrences | 15 minutes |
| Retries of a failed firing | None (the failure is visible; a failed one-off stays listed) |

## Design decisions

- **Reuse the agentic turn.** Reminders can use tools, and there's no separate
  reminder or briefing implementation. The cost is one model call per firing
  ([ADR-0028](../adr/0028-scheduled-turns.md)).
- **Local-time cron with a timezone.** A UTC recurrence would drift from the
  requested local hour across daylight-saving changes.
- **No parallel alarm table.** Cancellation and replacement query SDK
  schedules by callback and task ID.
- **No forced concurrency.** A "maximum wait" escape hatch that ran work
  alongside the queue would bring back history races, so there isn't one.
  Turns use `maxAttempts: 1`.

## Source

- [`scheduled-turns.ts`](../../src/features/agent/scheduled-turns.ts),
  [`schedule-tools.ts`](../../src/features/agent/tools/schedule-tools.ts),
  [`stores/scheduled-turn-store.ts`](../../src/features/agent/stores/scheduled-turn-store.ts)
- Tests: `scheduled-turns`, `schedule-tools` in
  [`src/tests/`](../../src/tests/)
