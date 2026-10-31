# Schedules

The owner's model can act later on its own: a morning summary of the coding
tasks, a reminder, a check on something that is still running. The code is in
`packages/core/src/app/schedule.ts` and `apps/mob/src/schedules.ts`; schedules are saved in the `schedules` table.

## Scheduling

- `schedule` (prompt, at, optional repeat and timezone) asks the owner to
  approve, then saves the prompt to run in the conversation that asked.
  `at` is RFC 3339 with an offset; the model reads the time with `datetime`
  first. `repeat` is `hourly`, `daily`, `weekdays` or `weekly`; without it the
  prompt runs once. Repeats keep their time of day in `timezone` (an IANA
  name), or in the time zone of the computer Mob runs on, so a daily 09:00
  stays 09:00 across daylight saving changes. On a day that skips that time
  (02:30 when clocks jump from 02:00 to 03:00), that one run moves by the
  hour; the next is back at 02:30.
- A one-off time that has passed is refused. A repeat whose first time has
  passed starts at its next one.
- Always allow covers every later `schedule` call; a prompt is at most 4000
  bytes.
- `schedules` lists them (ID, prompt, next run, repeat) and `schedule_cancel`
  cancels one; both are offered once something is scheduled. `/schedules`
  and `/unschedule ID|all` do the same in Web, TUI and Telegram. All are
  owner-only.

## Running

- The `schedules` background run looks for due schedules every 30 seconds,
  and at once after one is added. A due prompt starts an owner turn in its
  conversation with a note, saved as the turn's message, that names it as
  scheduled and when it was due. The turn has the owner's tools; anything
  that asks for approval still asks.
- A one-off schedule is deleted once its turn starts; a repeat moves to its
  next time. A conversation that is busy leaves the schedule due until the
  next look.
- Times missed while Mob was stopped run once when it starts, not once for
  each missed time.
- When the turn ends, the owner gets a `Notice`, "Scheduled", with the
  first line of the prompt, the turn's conclusion (up to 1200 characters) and
  any approval it waits for; [Telegram](channels.md) sends it with approval
  buttons. A turn that cannot start, such as with no model configured, raises
  a notice with the error instead.

## Managing schedules

Web's **Manage Mob → Schedules** shows each prompt, next run (in the browser's
local time), repeat rule and configured time zone, with a link to its conversation.
Cancelling one or all schedules requires confirmation. Creation still goes
through a conversation and approval. Telegram's **More → Schedules** offers a
paged list and cancellation confirmations; dates there are shown in UTC, with
the configured repeat time zone beside them.
