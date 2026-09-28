# 10. Rich Messages for streamed chat replies

Date: 2026-06-20
Status: Accepted

Use Telegram Rich Messages for both drafts and finalized chat segments. This
keeps formatting consistent while streaming and removes the MarkdownV2 escaping,
splitting, and plain-text fallback machinery from the agentic reply path.

The adapter sends Markdown directly through `rich_message.markdown` for both drafts and finalized segments;
types come from `telegram-bot-api-types`. A rejected send surfaces as a delivery
error. The output budget must remain within the Rich Message size assumption
covered by reply-surface tests. Email notifications use their own delivery format.

See the [Reply surface](0012-reply-surface-delivery-seam.md) and
[multi-message transcript](0021-transcript-reply-multi-message-agentic-turn.md).
