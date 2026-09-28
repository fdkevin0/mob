# Models

Every language-model call (chat, compaction, fact extraction, deep tasks and
email triage) goes through the Vercel AI SDK to one model: `deepseek-flash` on
DeepSeek's official Chat Completions API.

## How it works

- [`model.ts`](../../src/features/ai/model.ts) builds the provider with
  `@ai-sdk/openai-compatible` against `https://api.deepseek.com`.
- Chat turns use `streamText` with tools
  ([`agentic.ts`](../../src/features/ai/agentic.ts)).
- One-shot calls (compaction, extraction, triage) use
  [`generateUtility`](../../src/features/ai/utility-model.ts). It turns thinking
  and retries off, validates structured output, and passes failures back to
  the caller.
- Text and native image input use the same model.
- Consumers accept the SDK's `LanguageModel`. Setting `env.CHAT_MODEL`
  replaces the model in tests.

### Reasoning effort

Each chat picks a thinking level in the Mini App:

| Value | Meaning |
| --- | --- |
| `default` | Provider default |
| `off` | Sent as `thinking: { type: "disabled" }` |
| `low`, `high`, `max` | Passed through to DeepSeek |

Utility calls always run with thinking off.

## Configuration

| Name | Purpose |
| --- | --- |
| `DEEPSEEK_API_KEY` | Worker secret in production; an ignored `.env` value locally |
| `CHAT_MODEL` | Test-only model injection |

Changing the provider or model is a code change: there is no model catalog.

## Limits

| Limit | Value |
| --- | --- |
| Output tokens, chat turn | 2,048 |
| Output tokens, other calls | 1,024 |

The 2,048-token chat cap also keeps a finished reply well under Telegram's
32,768-character Rich Message limit (worst case about 8,192 characters). A
test in `reply-surface.test.ts` fails if the cap is raised far enough to
threaten that limit.

## Design decisions

- **The AI SDK tool loop.** Tool-call execution and streaming come from the
  SDK instead of hand-written code
  ([ADR-0008](../adr/0008-agentic-chat-on-vercel-ai-sdk-with-mcp-client.md)).
- **One SDK for every call.** A second hand-written client duplicated
  transport, types and usage accounting. Email triage uses `Output.object`
  with a schema instead of a forced tool call
  ([ADR-0041](../adr/0041-unify-ai-frameworks-on-ai-sdk.md)).
- **One model, called directly.** Removing the gateway, model catalog, custom
  providers and fallback cut the configuration and compatibility paths.
  Old selections are ignored rather than migrated
  ([ADR-0050](../adr/0050-use-deepseek-official-api.md)).
- **Workers AI only where it's needed.** It's kept for embeddings and
  document conversion, not text generation.

## Source

- [`src/features/ai/`](../../src/features/ai/): `model.ts`, `agentic.ts`,
  `agentic-sink.ts`, `sdk.ts`, `utility-model.ts`, `reasoning-effort.ts`
- Tests: `model`, `utility-model`, `ai-sdk-runtime`, `agentic-dispatch` in
  [`src/tests/`](../../src/tests/)
