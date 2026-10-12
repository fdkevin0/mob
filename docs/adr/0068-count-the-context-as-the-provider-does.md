# 68. Count the context as the provider does

Date: 2026-10-11
Status: Accepted

History is fitted to the model's window once, before the first model call,
from an estimate of about three bytes a token. The estimate left out the tool
definitions sent with every call, which for a few MCP servers can be
thousands of tokens, and nothing was counted again within the turn: up to 20
steps of tool results (ADR 0063, ADR 0067) could grow the prompt past the
window until the provider refused it with an error naming neither the model
nor the cause. Providers report how many tokens each request used, and other
agents count from that (see `research/limits-and-context-management.md`).

## Decision

- A prompt may use the model's context window less the reply's reserve
  (ADR 0065). The system prompt, the tool definitions and history count
  against it, as do the notice that history was cut and the note an approved
  call continues with, which are added after history is fitted.
- Within a turn, the prompt's size is what the provider reported for the last
  step, its input and output, plus an estimate of the tool results added
  since. Without a report, every added message is estimated.
- Before each further step, a prompt over that size ends the turn with an
  error naming the model and the size, and asks the user to send another
  message, whose turn fits history to the window again.

## Consequences

A turn ends with a clear error instead of a provider's refusal, and tool
definitions no longer crowd out the reply. History at the start of a turn is
still estimated, as a stored message keeps its turn's total usage rather than
the size of its last prompt.

Clearing old tool results and compacting history, so that a long turn can
continue instead of ending, are the next step.
