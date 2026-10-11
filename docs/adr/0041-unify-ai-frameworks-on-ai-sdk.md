# 41. One AI SDK for all language-model calls

Date: 2026-07-11
Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Chat, email, extraction, and compaction use the AI SDK. A second handwritten model
client duplicated transport, types, and usage accounting. Consumers accept the
SDK's `LanguageModel`; `env.CHAT_MODEL` remains the injected test seam without a
parallel `ChatModel` wrapper.

Utility generation disables thinking and retries, validates structured output,
and propagates failures to the caller. Email triage uses `Output.object` with its
schema; the old forced-tool-call workaround is unnecessary for the current model.
Provider construction is defined in [ADR-0050](0050-use-deepseek-official-api.md).

Email triage records usage best-effort through the admin chat's Conversation Agent
RPC; drafting records `email_reply` inside that agent. Keeping the ledger in the
chat avoids a second global accounting store. Accounting failure must not fail
triage. Record the actual resolved model ID.
