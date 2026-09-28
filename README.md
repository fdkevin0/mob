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
| `docs/` | [Documentation](docs/README.md): architecture overview, feature guides and decision records |

## Not included

These modules are imported but not published: `src/core/{bot,principal,cmd,callback-family}`,
`src/core/sync-commands`, `src/db/schema`,
`src/features/{assets,email,feed,queue,rich-message}` (apart from the shared helpers above).

## Documentation

Start at the [documentation index](docs/README.md).

- [Architecture overview](docs/architecture.md): request flow, module map, limits
- Feature guides: [conversation agent](docs/features/conversation-agent.md),
  [models](docs/features/models.md), [Telegram replies](docs/features/telegram-replies.md),
  [tools](docs/features/tools.md), [code execution](docs/features/code-execution.md),
  [memory](docs/features/memory.md), [scheduled turns](docs/features/scheduled-turns.md),
  [deep tasks](docs/features/deep-tasks.md), [email triage](docs/features/email-triage.md),
  [Settings Mini App](docs/features/mini-app.md), [debug traces and usage](docs/features/debugging-and-usage.md)
- [Decision records](docs/adr/README.md): why things are built the way they are,
  including the unpublished records that code comments cite as
  `ADR-NNNN, unpublished`

## Build and test

Requires Node and pnpm.

```bash
pnpm install
pnpm build                # Mini App → webapp/dist (needs a Git checkout: embeds the short commit ID)
pnpm test:webapp          # Mini App: tsc + Vitest (happy-dom)
pnpm exec vitest run      # Worker-side suites in src/tests/ (Node)
```

The Mini App builds and its tests pass on their own. Of the Worker-side suites,
the 8 that import unpublished modules fail to load (`builtin-tools`, `email-triage`,
`outbound-queue`, `quote`, `read-tools`, `reply-surface`, `schedule-tools`,
`turn-driver`). The other 22 run. There is no Worker build or deploy script.

## Configuration

Secrets are never committed. The original deployment sets them with
`wrangler secret put …`; locally `DEEPSEEK_API_KEY` comes from an ignored `.env`.
Bindings are typed in [`src/core/env.ts`](src/core/env.ts). The ones the AI
modules use:

| Name | Kind | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | secret | All LLM calls |
| `TELEGRAM_API_TOKEN` | secret | Telegram Bot API |
| `TAVILY_API_KEY` | secret, optional | Registers `web_search` |
| `SANDBOX_DAILY_LIMIT_SECONDS` | var, optional | Sandbox time per user, chat and UTC day (default 120; `0` disables) |
| `BOT_TIMEZONE` | var, optional | Default IANA timezone for the datetime tool (UTC when unset) |
| `MINIAPP_BASE_URL` | var, optional | Public Mini App origin, also used for email deep links |
| `ConversationAgent` | Durable Object | One agent per chat |
| `Sandbox` | Durable Object | Per-chat container for `run_code` / `run_shell` |
| `AI` | Workers AI | Embeddings (`@cf/baai/bge-m3`) and document conversion |
| `MEMORIES` | Vectorize | 1024-dimension cosine index with a `chatId` metadata index |
| `DB` | D1 | MCP server registry and email metadata |
| `EMAIL_BUCKET` | R2 | Raw mail for the email preview |
| `STATE` | KV | Global service config |
| `ASSETS` | Static Assets | The Mini App build, served under `/miniapp/` |

`env.ts` also declares bindings that only unpublished features use (feeds, queue,
bookmarks, downloads).

## License

[MIT](LICENSE)
