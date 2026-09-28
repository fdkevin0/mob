# 11. Admin-only JSON debug traces

Date: 2026-06-20
Status: Accepted

Debug mode emits a per-turn JSON document so the admin can inspect model inputs,
tool activity, limits, and usage without expanding the visible conversation.
The per-chat flag is controlled through Settings with `view_debug` authorization.

Traces are observational and excluded from model history. They may contain
sensitive conversation text and tool arguments/results; keep them on the
admin-only document surface, separate from operational logs. Connection
credentials and inline image payloads are excluded. Size limits truncate large
fields with markers rather than allowing an unbounded upload.

The JSON document remains in Telegram after delivery. It is not a replacement
for operational logging (ADR-0051, unpublished) or the compact
[transcript](0021-transcript-reply-multi-message-agentic-turn.md).
