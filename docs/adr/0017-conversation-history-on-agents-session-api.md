# 17. Conversation history on the Agents SDK Session API

Date: 2026-06-21
Status: Accepted

Use the Session API for SQLite-backed history, context providers, attachment
storage, and non-destructive compaction. Keeping this in the chat's Durable
Object avoids a second shared history store and custom retention machinery.

- Append linearly to Session history. Persist user content and the assistant's
  [transcript](0021-transcript-reply-multi-message-agentic-turn.md), including
  compact tool summaries; raw tool arguments/results belong in Debug traces.
- Read a byte-budgeted recent window. Session stores native image bytes and
  rehydrates attachments for follow-ups; `/clear` releases history and attachments.
- Freeze the system prefix from context providers. Keep volatile recalled facts
  on the user message; semantic Vectorize retrieval remains distinct from Session
  keyword search and scratchpad context.
- Compact at the chat's configured threshold. Stream text from history into the
  summarizer without accumulating image payloads, then write native Session
  overlays. Extraction reuses the resulting summary.

Session APIs are experimental; check the installed Agents version when changing
the integration. Node fakes do not verify SDK lifecycle or storage behavior.
See [attachment limits](../architecture.md#memory-and-assets) and
[memory lifecycle](0038-layered-memory-auto-recall-and-fact-extraction.md).
