# 40. Deep tasks run in the Conversation Agent

Date: 2026-07-10
Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Run longer model work in a background fiber inside the chat's Durable Object.
Memory and sandbox budgets are chat-local; asset access is bound to the initiating Principal; moving the loop
to a Workflow or another agent would require RPC wrappers around those tools
and another lifecycle. A fiber keeps the tools local without occupying the turn
queue during generation.

[DeepTasks](../../src/features/agent/deep-tasks.ts) owns one active slot per chat,
cancellation state, and partial-result composition. The agent owns fiber startup,
progress edits, checkpoints, recovery, and queued delivery. One slot limits
concurrent background spending and contention for the shared sandbox.

The `schedule_turns` capability permits launching a task. The loop has step and
wall-clock limits and charges sandbox time to the initiator's budget. Its toolset
excludes shell, recursive deep tasks, scheduling, and privileged readers. Shell
would require a second [approval mechanism](0039-tool-approval-as-turn-boundary.md).
Current limits and wiring live in [ConversationAgent](../../src/features/agent/conversation-agent.ts).

Cancellation and timeout preserve accumulated results. Checkpoints allow recovery
to deliver an interrupted report and free the slot after a restart. Completion
joins the serial turn queue to post the report and append task/report provenance
to Session history, making follow-ups possible. Delivery uses the fiber's own
output and costs no additional model call.

Fiber usage is recorded separately in the ledger on clean stream completion.
Aborted runs can lose token accounting when their usage promise never settles.
This design accepts partial recovery rather than step-by-step durable replay.
