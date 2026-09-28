# 26. Tool labels and elapsed time

Date: 2026-06-28
Status: Accepted

A result summary says what came back, but not what was requested. Add a short
input label at tool start and elapsed execution time on completion, for example
`✅ web_search · cats · 5 results · 1.2s`.

[Built-in hooks](../../src/features/agent/tools/index.ts) select labels and result
summaries. URL labels expose only the hostname. Hooks read untrusted values and
fail softly; a broken display hook must not abort a turn. MCP tools have no hooks,
so they show status and duration only.

[Transcript formatters](../../src/features/agent/transcript.ts) own composition.
Labels and summaries enter history because they help the model recall prior
work; duration is display-only. Full arguments and results stay in debug traces.
See [ADR-0021](0021-transcript-reply-multi-message-agentic-turn.md) for the transcript lifecycle.
