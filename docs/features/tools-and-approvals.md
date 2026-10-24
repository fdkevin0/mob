# Tools and approvals

The model works through tools. Any tool may ask the owner to approve a call
before it has an effect, and the owner can decide from any client or channel.

## Built-in and plugin tools

- Built in: `datetime`, `remember` (saves a fact after approval, below), when the
  [sandbox](sandbox.md) is enabled, `sandbox`, and, while there are tools to
  load, `tool_search` (below).
- The email plugin offers `email_inbox`, `email_read` and `email_send`; the
  Cloudflare plugin offers `cloudflare`. Each is defined in its own package and
  offered only while its plugin is enabled.
- [Coding agents](coding-agents.md) add `task_start` (asks for approval),
  `tasks`, `task_message`, `task_stop`, `task_diff` and `task_check` (asks
  for approval).
- [Schedules](schedules.md) add `schedule` (asks for approval), `schedules`
  and `schedule_cancel`.
- [MCP servers](mcp.md) add `mcp__<server>__<tool>` tools, and `tool_install`
  installs a remote server from the catalog.
- While any [skill](skills.md) is installed, the `skill` tool loads one; it
  reads without approval.
- An `OwnerOnly` tool is offered only to the owner's turns, and only the owner
  can approve its calls: another allowed WeChat user cannot read or send the
  owner's mail. Plugin and MCP tools are owner-only.
- Mail text and Cloudflare results sent to the model are bounded, and the model
  is told they are untrusted data.

## Saved facts

- `remember` saves one fact (up to 2000 bytes) once it is approved. A fact the
  owner approved is read in every one of the owner's turns, in any
  conversation, client or channel; one another caller approved is read only
  in the conversation that saved it. Other callers' turns never read the
  owner's facts from elsewhere.
- Facts go into the system prompt as data, not instructions. `/memories`
  lists them with where each is read, and `/forget ID|all` deletes them; both
  are owner-only.
- Facts saved before 2026-10-20 stay with their conversation: Mob cannot tell
  who approved them. Ask the model to remember one again to share it.

## Exposure and tool_search

Registering a tool and declaring it to the model are separate, so many tools
cost the prompt nothing until a task needs them. `Tool.Exposure` is one of:

- `Direct`, the default: declared to every turn that may use the tool.
  Built-in and plugin tools are direct.
- `Deferred`: declared once `tool_search` loads it. [MCP](mcp.md) tools are
  deferred unless their server's configuration says otherwise.
- `Hidden`: never declared and never found.

While a turn has deferred tools to load, or entries such as skills to find, it
offers `tool_search`, and the system prompt names how many wait in each
namespace ("MCP server github (12)"). `tool_search` takes keywords and ranks
what is waiting with BM25 over the tool's name, namespace, description and
parameters (camelCase and `_` split, Han characters one word each); a query
naming a tool exactly finds it first. It returns up to five results, ten when
asked, and loads the tools among them: they are declared, with their prompts,
from the turn's next step. Calling a deferred tool that is not loaded, even
beside the search that loads it, fails with an unsupported-tool error.

A conversation keeps the tools it loaded, and those it called before, declared
in its later turns: they are read back from its history, so nothing else is
stored. Loading changes no approval: a loaded MCP tool asks as it always does.

`ToolRegistry.RegisterEntries` adds things `tool_search` finds that are not
tools to load, each with a kind, a description and how to use it, such as a
skill and the tool that loads it. Owner-only entries are found only in the
owner's turns.

## What asks for approval

- Reading runs at once. Sending mail, Workers AI (`ai.run`, and
  `vectorize.query`, which embeds with Workers AI), D1 queries that may write,
  `remember`, every MCP call, installing an MCP server with `tool_install`,
  starting a coding task, running a `task_check` command and scheduling a
  prompt wait for approval. A single D1 `SELECT`
  statement runs without approval; SQL the check cannot be sure of still asks.
- The approval names what the call acts on (the sender and SMTP account, or the
  Cloudflare account and model, index or database), and an approved call runs
  only while the configuration still names the same target, so changing the
  configuration cannot redirect it.

## Deciding

- An approval request carries the tool name and the input to approve.
  `chat.DescribeApproval` renders it as plain text for channels. The AI SDK
  `tool-approval-request` chunk carries only the approval and call IDs.
- The web UI and TUI show the request in the conversation; `/approve` and
  `/deny` work in every client. Telegram shows Approve, Always allow and Deny
  buttons; WeChat iLink accepts 批准 and 拒绝, or a bare reply when one request is
  pending. `/approve` and `/deny` without an ID decide the only pending request.
- A denial may carry a reason (`chat.Answer.Reason`). It is written into the
  denial note, and the model answers in a new turn. A denial without a reason
  ends quietly.
- An approval left undecided past its hour is marked expired and its call
  failed, so the model and channels stop waiting on it.
- Web and the terminal UI share the approval/denial stream
  orchestration in `@mob/client`. Their controls still send the same approval ID,
  reason and remembered scope to the service. They display service results and failures;
  neither retries stale decisions nor makes authorization policy locally.

## Exactly once

- `Store.Decide` records the decision once and marks an approved call
  `approval-responded`. The service then runs the tool's `Approved` and
  `Store.Complete` records its result. A retried approval is refused as stale,
  so the effect happens at most once. After a crash between those steps, startup
  marks the call failed with an unknown outcome. Check the external result before asking again; Mob never
  repeats the approved call automatically. Completed and undecided calls keep
  their state.
- Effects outside Mob can key on the approval ID: an approved email's delivery
  is keyed `email:<approval ID>`.
- After a decision the model receives a note naming the tool: "The user
  approved remember and it ran. Result: …" or "The user denied the remember
  request."

## Remembered approvals

- The owner may remember an approval for the conversation or always
  (`chat.Answer.Remember`). A grant covers the tool's calls whose `Tool.Scope`
  matches the approved input's: the recipients and sender for `email_send`, the
  operation and target for `cloudflare`, the server configuration for MCP tools,
  any call for a tool without `Scope`.
- Covered calls in the owner's turns run `Approved` at once with a fresh
  approval ID; other callers' turns always ask.
- Grants live in the `grants` table. `/grants` lists them and `/revoke ID|all`
  forgets them. A grant outlives configuration changes only as far as its scope
  does: a new SMTP account or D1 database gives a new scope, which asks again.
  Remembering is coarse for tools without `Scope`, so a tool whose inputs differ
  in risk should define one.

Writing a tool, including `RequestApproval`, `Approved` and `Scope`, is covered
in [Extensions](extensions.md).
