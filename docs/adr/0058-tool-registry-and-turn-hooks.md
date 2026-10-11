# 58. Tools register once; hooks run around every turn

Date: 2026-10-11
Status: Accepted

The model's tools were one `switch` in `internal/chat/tools.go`, and
`chat.Run` assembled the system prompt itself: the sandbox's instruction and
the saved facts were written into it inline. Adding a tool, or anything that
reads or changes a turn, meant editing the engine. This is the first step of
moving Mob towards a small kernel with extensions registered at compile time
(not loaded at runtime: Go's `plugin` package has no Windows support and
cannot unload, and Mob ships as one binary).

## Decision

- A `chat.Tool` is an `llm.Tool` definition, an optional `Prompt` added to
  the system prompt when the tool is offered, and `Run`. `Run` gets a
  `ToolCall` with the parsed input, the stored part, the message, the store
  and the event sender. Its output and errors go back to the model, except
  `ErrAwaitingApproval`, which ends the turn after an approval request, and
  errors wrapped by `Abort`, which end the turn as failures. A tool error after
  cancellation ends the turn as cancelled.
- `ConversationService.Tools` is a `ToolRegistry`: `datetime` and `remember`
  register in `NewConversation`, and more may register before serving. Names
  are unique. The sandbox tool is added per turn when a sandbox is set.
- `ConversationService.Hooks` runs around every turn, in registration order:
  `BeforeTurn` may add to the request's system prompt before history is fitted
  to the context window, `BeforeTool` may refuse an offered call (its error is
  handled as the tool's own would be), and `AfterTurn` sees the saved reply
  and the turn's error. Recalling saved facts is the first `BeforeTurn` hook.
- `chat.Run` takes an `Agent` (tools and hooks) in place of a sandbox.

## Consequences

The prompt, the tools offered and their results are unchanged, except that a
call to the sandbox while none is set reads `unsupported tool: sandbox`. A
capability, such as a plugin's tool or an MCP server's, now registers beside
its own code instead of in the engine. Later steps give plugins one lifecycle interface and
let them register tools, commands and channels through it.
