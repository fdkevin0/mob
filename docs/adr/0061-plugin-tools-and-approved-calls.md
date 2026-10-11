# 61. Plugins give the model tools; approval is for any tool

Date: 2026-10-11
Status: Accepted

The email and Cloudflare plugins could be used only through `/email`, `/cloud`
and their web panels: the model could not read mail or query D1 for the user.
Approvals existed only for `remember`, whose effect `Store.Decide` wrote in the
same transaction as the decision. This is step four of the extension
architecture after ADR 0058, 0059 and 0060.

## Decision

- A `chat.Tool` may say when it is `Available`; a turn offers only the tools
  available then. Plugin tools are available while their plugin is enabled.
- An `OwnerOnly` tool is offered only to the person who owns this Mob, and
  only they can approve its calls, like the owner-only `/email` and `/cloud`
  commands: another allowed WeChat user cannot read or send the owner's mail.
  A WeChat approval now carries whether its sender is the owner.
- Any tool may ask for approval: `Run` calls `ToolCall.RequestApproval` with
  the input the user will approve, and `Approved` carries out the call once
  the user approves it.
- `Store.Decide` records the decision once and marks an approved call
  `approval-responded`. The service then runs the tool's `Approved` and
  `Store.Complete` records its result. A retried approval is refused as stale,
  so the effect happens at most once. A crash in between leaves the call
  reported as not completed, not repeated. Effects outside Mob can key on the
  approval ID: an approved email's delivery is keyed `email:<approval ID>`.
- The email plugin offers `email_inbox`, `email_read` and `email_send`, and
  the Cloudflare plugin offers `cloudflare`, each defined in its own package
  and owner-only.
  Reading runs at once; sending mail, Workers AI (`ai.run`, and
  `vectorize.query`, which embeds with Workers AI) and D1 queries, which may
  write, wait for approval. The approval names what the call acts on (the
  sender and SMTP account, or the Cloudflare account and model, index or
  database), and an approved call runs only while the configuration still
  names the same target, so changing the configuration cannot redirect it. Mail text and Cloudflare results sent to the model
  are bounded, and the model is told they are untrusted data.
- `remember` is an ordinary approved tool: saving the fact is its `Approved`.

## Consequences

The notes the model receives after a decision now name the tool:
"The user approved remember and it ran. Result: …" and "The user denied the
remember request." The web UI asks "Allow this request?" for tools other than
`remember`. The `/email` and `/cloud` commands and plugin routes are still
written in the server; moving them next to the tools is a later step.
