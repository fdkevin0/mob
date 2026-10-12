# 69. Clear old tool outputs to fit the window

Date: 2026-10-12
Status: Accepted

When history did not fit the model's window, whole turns were omitted, oldest
first, even when most of their size was tool output the model no longer
needed. Within a turn, a prompt that outgrew the window ended the turn
(ADR 0068). Tool outputs are usually most of a working conversation's size
and lose value fastest; other agents clear them before dropping or
summarizing anything else (see `research/limits-and-context-management.md`).

## Decision

- When history is fitted to the window and does not fit, tool outputs are
  replaced, oldest first, with a short note naming the tool and the size of
  what was cleared, until it fits. The latest turn keeps its outputs. Only
  then are whole turns omitted.
- Within a turn, a prompt that would outgrow the window first clears the
  outputs the model has already read, oldest first. Outputs from the step
  just run are never cleared. The turn ends with the ADR 0068 error only if
  that is not enough.
- When the output was saved (ADR 0067), the note gives its path, so the model
  can read it again. Otherwise it says to run the tool again.
- Outputs smaller than about twice their note are left as they are. Stored
  messages keep every output; clearing changes only what the model reads.

## Consequences

Long tool-using turns and conversations keep their requests and replies when
they outgrow the window, and the model can recover a cleared output it
needs. Clearing changes the prompt's prefix, so the provider's prompt cache
misses once after each clearing.

Summarizing older history when clearing outputs is not enough (compaction)
is a later step.
