# 63. Remembered approvals and decisions from any channel

Date: 2026-10-11
Status: Accepted

ADR 0061 let any tool ask for approval, which made approvals the common path
for sending mail and running D1 or Workers AI. Deciding them from Telegram or
WeChat meant approving input the prompt did not show, typing a 32-character ID,
and approving every call again; a denial ended the turn without the model
hearing why. Issue #29 tracks the wider plan.

## Decision

- An approval request carries the tool name and the input to approve.
  `chat.DescribeApproval` renders it as plain text for channels. The AI SDK
  `tool-approval-request` chunk still carries only the approval and call IDs.
- Telegram shows Approve, Always allow and Deny buttons; a tap from the owner
  is handled as the `/approve` or `/deny` message it stands for. WeChat accepts
  a bare reply when one request is pending.
- A denial may carry a reason (`chat.Answer.Reason`). It is written into the
  denial note, and the model answers in a new turn. A denial without a reason
  still ends quietly.
- The owner may remember an approval for the conversation or always
  (`chat.Answer.Remember`). A grant covers the tool's calls whose
  `Tool.Scope` matches the approved input's: the recipients and sender for
  `email_send`, the operation and target for `cloudflare`, any call for a tool
  without `Scope`. Covered calls in the owner's turns run `Approved` at once
  with a fresh approval ID; other callers' turns always ask. `/grants` lists
  grants and `/revoke ID|all` forgets them.
- A single D1 `SELECT` statement runs without approval; SQL the check cannot be
  sure of still asks.

## Consequences

Grants live in a new `grants` table. A grant outlives configuration changes
only as far as its scope does: a new SMTP account or D1 database gives a new
scope, which asks again. Remembering is coarse for tools without `Scope`, so a
tool whose inputs differ in risk should define one.
