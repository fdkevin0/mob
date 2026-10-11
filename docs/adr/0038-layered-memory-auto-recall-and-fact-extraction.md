# 38. Layered memory, extraction, and auto-recall

Date: 2026-07-08
Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Tool-only memory was rarely recalled or written. Extract facts from Session
compaction summaries and retrieve relevant facts for incoming messages, accepting
an embedding per eligible turn and an extraction call per compaction. Reuse the
existing summary rather than maintain a second summarizer.

## Storage and lifecycle

DO SQLite is the source of truth; Vectorize is a chat-scoped retrieval index.
Working and Knowledge are states of the same fact, so promotion updates metadata
rather than copying between stores. Each fact records its source, confirmations,
and last-seen time.

- Extraction confirms a sufficiently similar fact or creates a Working fact.
  Updated wording keeps the fact ID and confirmation count while replacing text
  and vector. Repeated confirmations promote it to Knowledge; explicit `remember`
  writes Knowledge directly. Confirmations count extraction runs, not sessions.
- Extraction prunes stale Working facts. Knowledge does not automatically expire.
  Thresholds and retention constants live in the memory implementation; retrieval
  count is configurable per chat.
- Auto-recall queries both layers with a chat filter and score cutoff. Timestamped
  hits join the incoming user message, outside the stable system prompt. The
  `recall` tool remains available for deliberate searches; Debug traces expose hits.
- `/forget` removes both layers from SQLite and Vectorize. `/clear` only clears
  conversation state. Vectorize visibility is eventually consistent, so rapid
  extraction can produce duplicates; dissimilar contradictions are not resolved
  automatically.

## Mini App

The private chat's Memory tab groups facts by layer, with counts in headings,
dates, and confirmations. A native confirmation dialog provides
explicit Cancel and Forget all actions. Charts and an inferred relationship graph
add no useful information for inspecting these facts and are omitted. Group-chat
memory is managed from the group itself.

Saved source content uses the separate unified asset service and search index.
Fact extraction does not automatically create assets.
See [Session history](0017-conversation-history-on-agents-session-api.md) and
[saved assets](0014-unified-saved-assets.md).
