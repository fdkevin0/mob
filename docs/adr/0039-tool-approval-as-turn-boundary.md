# 39. Tool approval is a turn boundary

Date: 2026-07-10
Status: Accepted

A tool waiting for a human must release the serial turn queue. Suspending the
current stream could block unrelated conversation for hours and require durable
recovery just to preserve that wait.

A gated call stores its argument snapshot and returns a pending-approval result.
The turn finishes, and Telegram offers Approve/Deny buttons. Approval consumes
the snapshot and enqueues execution followed by a model turn that can explain the
result. Denial records a Session note without inference. Both outcomes become
available to later conversation; executing silently on approval would leave the
model unaware of how its call resolved.

[ToolApprovals](../../src/features/agent/tool-approvals.ts) owns request, decision,
and expiry over an injected store and clock. Pending calls use separate rows,
because a later model call must not invalidate earlier visible buttons. Rows
expire after a TTL; `/clear` invalidates them along with their conversation context.

Only the initiating Principal or admin may decide. An admin-initiated call still
needs approval: this confirms the human's intent, rather than requiring a second
person. The core checks authorization before exposing whether a request exists.

The registration wrapper gates `run_shell`. `run_code` retains its runtime budget
without per-call approval. MCP tools are not approval-wrapped. Deep tasks exclude
shell because they cannot use the normal turn-continuation mechanism. See
[the sandbox decision](0019-sandbox-code-interpreter-tool.md) and
[deep tasks](0040-deep-task-runfiber-in-do.md).
