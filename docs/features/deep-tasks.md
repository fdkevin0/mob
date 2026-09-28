# Deep tasks

A deep task moves work that needs more than a normal reply allows, such as
research across sources or report writing, into a background fiber inside the
chat's Durable Object. The task posts its report to the chat when it finishes.

## How it works

1. The model calls `deep_task` with a short description and self-contained
   instructions. The current turn finishes straight away.
2. [DeepTasks](../../src/features/agent/deep-tasks.ts) claims the chat's one
   active slot. The agent starts a fiber that runs its own tool loop and
   updates a progress message.
3. The fiber checkpoints as it goes. After a restart, recovery delivers the
   interrupted report and frees the slot.
4. When the task finishes, it joins the serial turn queue to post the report
   and add the task and report to Session history. Delivery uses the fiber's
   own output; no extra model call is made.

Cancelling or timing out keeps the results gathered so far.

### Deep-task toolset

The fiber gets the normal built-in tools **except**:

- `run_shell`: the approval continuation can't run in a fiber
- `deep_task`: no recursive tasks
- scheduling tools
- privileged readers

Sandbox time is charged to the budget of the person who started the task.

## Usage

`deep_task` is offered to people with the `schedule_turns` capability, the
same trust level as scheduled turns, since both allow open-ended model
spending.

## Limits

| Limit | Value |
| --- | --- |
| Active deep tasks per chat | 1 |
| Tool steps | 20 (a normal turn allows 5) |
| Wall-clock time | 15 minutes |

## Design decisions

- **A fiber inside the Conversation Agent.** Memory and the sandbox budget are
  local to the chat, and asset access is tied to the person who started the
  task. A Workflow or a separate agent would need RPC wrappers around those
  tools and another lifecycle to manage. The fiber doesn't hold the turn queue
  while it generates
  ([ADR-0040](../adr/0040-deep-task-runfiber-in-do.md)).
- **One slot per chat.** This limits concurrent background spending and
  contention for the shared sandbox.
- **Partial recovery instead of durable replay.** Checkpoints let an
  interrupted report be delivered; steps aren't replayed one by one.

## Known limitations

- Fiber usage is recorded in the ledger only when the stream completes
  cleanly. Aborted runs can lose token accounting.

## Source

- [`deep-tasks.ts`](../../src/features/agent/deep-tasks.ts),
  [`tools/deep-task.ts`](../../src/features/agent/tools/deep-task.ts),
  [`stores/deep-task-store.ts`](../../src/features/agent/stores/deep-task-store.ts)
- Fiber startup, progress and recovery are in
  [`conversation-agent.ts`](../../src/features/agent/conversation-agent.ts)
- Tests: `deep-tasks` in [`src/tests/`](../../src/tests/)
