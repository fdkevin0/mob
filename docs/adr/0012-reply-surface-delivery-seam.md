# 12. Separate turn orchestration from Telegram delivery

Date: 2026-06-20
Status: Accepted

Put Telegram delivery behind a Reply surface so model turns can be exercised
with a recorder instead of a live bot. The agent retains platform lifecycle
and history ownership; the adapter owns Telegram IDs, draft throttling, markup,
and persistent sends. This keeps delivery constraints out of model orchestration.

[ReplySurface](../../src/features/agent/reply-surface.ts) exposes segment and tool
message lifecycles, notices, and debug documents. Its Telegram adapter binds the
target once per turn. [Turn events](../../src/features/agent/turn-events.ts)
carry content without Telegram message IDs.

Rich Messages have a separate limit from plain `sendMessage`. The adapter records
that limit in `RICH_MESSAGE_CHAR_LIMIT` and relies on the model output budget;
it does not split or truncate Rich Messages. The reply-surface tests check this
budget assumption. The earlier claim that Rich Messages have no limit was wrong.
Email confirmation uses plain messages and retains their own size cap.

See [ADR-0021](0021-transcript-reply-multi-message-agentic-turn.md) for ordering,
notification, and persistence decisions.
