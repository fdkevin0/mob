# 21. A multi-message transcript for the agentic turn

Date: 2026-06-24
Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Render a tool-using turn as interleaved text segments and tool-status messages.
A single draft hides tool activity after completion and makes intermediate prose
indistinguishable from the final answer.

- Each text segment gets a fresh draft ID and a finalized Rich Message.
- Each tool call gets one silent message, edited in place on success or failure.
  Labels and summaries are bounded; full arguments and results belong in debug
  traces. [ADR-0026](0026-enriched-tool-line.md) defines labels and timing.
- Hold a finished segment until the next event establishes whether it is final.
  Intermediate segments and tool messages are silent; the final answer notifies.
  Outbound transcript messages stack without quote-reply anchors.
- Persist the flattened transcript: prose interleaved with tool-summary
  blockquotes. This lets the model recall what it did without storing raw tool
  payloads or elapsed durations in history.
- A stream failure retains any partial transcript with an interruption marker.
  A tool-only turn persists its summaries and sends an empty-reply notice;
  a truly empty turn sends the notice without writing history.

[Turn events](../../src/features/agent/turn-events.ts) own orchestration;
[Transcript](../../src/features/agent/transcript.ts) owns the history rendering;
the [Reply surface](0012-reply-surface-delivery-seam.md) owns Telegram delivery.
Persistent sends and edits use the [outbound queue](../../src/features/agent/outbound-queue.ts)
to preserve order and perform a bounded 429 retry. Drafts remain throttled and
fire-and-forget. Delivery failures are logged and may leave Telegram missing a
message that history retains.

History retention and compaction follow the [Session decision](0017-conversation-history-on-agents-session-api.md).
