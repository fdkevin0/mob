# Mob — AI core

The AI parts of **Mob**, a personal Telegram bot that runs as a single
[Cloudflare Worker](https://workers.cloudflare.com/). This repository holds the
agentic chat turn, its tools, long-term memory, MCP client, AI email triage and
the Settings Mini App, extracted from the private bot.

> **Reference code, not a standalone app.** Only the AI modules are published.
> The Telegram plumbing, persistence schema and non-AI features they import
> (listed below) are not included, so the code does not build or deploy as is.

## What's here

| Path | Contents |
| --- | --- |
| `src/features/ai/` | Model resolution (DeepSeek via `@ai-sdk/openai-compatible`), the `streamText` agentic loop, session messages and compaction, reasoning effort, utility model |
| `src/features/agent/` | `ConversationAgent` Durable Object (Cloudflare Agents SDK), turn driver, transcript / streaming reply surface, outbound queue, tool approvals, scheduled turns, deep tasks, usage ledger, debug traces, Telegram attachments |
| `src/features/agent/tools/` | Built-in tools: datetime, fetch URL, web search, weather, sandboxed `run_code` / `run_shell`, memory, schedules, deep task, read tools |
| `src/features/agent/stores/` | Durable Object SQLite stores (Drizzle) |
| `src/features/memory/` | Long-term memory on Vectorize (`@cf/baai/bge-m3`), auto-recall and fact extraction |
| `src/features/mcp/` | MCP server registry and client parsing |
| `src/ai/email.ts` | AI email triage (importance / category classification) |
| `src/features/miniapp/` | Mini App HTTP API: Telegram `initData` auth, request/response contract, routes |
| `webapp/` | Settings Mini App SPA (React + Vite + Tailwind): chat settings, memory, bookmarks, email list/preview, global service |
| `src/features/email/{preview,auth}.ts`, `src/features/assets/types.ts`, `src/utils/{tool,hmac}.ts` | Shared helpers the Mini App imports (email preview rendering, SPF/DKIM/DMARC parsing, asset types) |
| `src/core/env.ts` | Worker binding types |
| `src/tests/` | Vitest suites for the modules above |
| `docs/adr/` | The architecture decisions behind these modules (numbering kept from the original repo, so gaps are expected and some cross-links point to unpublished ADRs) |

## Not included

These modules are imported but not published: `src/core/{bot,principal,cmd,callback-family}`,
`src/core/sync-commands`, `src/db/schema`,
`src/features/{assets,email,feed,queue,rich-message}` (apart from the shared helpers above).

The Mini App frontend builds on its own:

```bash
pnpm install
pnpm build         # webapp/dist
pnpm test:webapp   # tsc + Vitest (happy-dom)
```

The build embeds the Git short commit ID, so it needs a Git checkout.

## Configuration

Secrets are never committed. The original deployment provides them as Worker
secrets (`wrangler secret put …`):

- `DEEPSEEK_API_KEY`: all LLM calls
- `TELEGRAM_API_TOKEN`: Telegram Bot API
- `TAVILY_API_KEY` (optional): enables `web_search`

Workers AI (`AI` binding) provides embeddings and document conversion; the
Vectorize index is 1024-dimension cosine with a `chatId` metadata index.

## License

[MIT](LICENSE)
