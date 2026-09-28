# Architecture decision records

Numbers are kept from the private repository, so gaps are expected. For how the
pieces fit together, start with the [architecture overview](../architecture.md).

## Published

| ADR | Decision | Summary |
| --- | --- | --- |
| **Agent and turns** | | |
| [0006](0006-conversation-agent-durable-object.md) | One Conversation Agent per chat | A Durable Object per chat owns history and execution; turns run on a serial queue with `maxAttempts: 1`. |
| [0047](0047-deepen-the-conversation-agent.md) | Conversation Agent module boundaries | Platform lifecycle stays in the agent; turn orchestration, stores and settings sit behind injected interfaces. |
| [0017](0017-conversation-history-on-agents-session-api.md) | History on the Agents SDK Session API | SQLite-backed history, attachments and non-destructive compaction. |
| [0028](0028-scheduled-turns.md) | Scheduled prompts run as serial chat turns | Local-time cron plus timezone, calculated with Croner and run through the normal turn path. |
| [0039](0039-tool-approval-as-turn-boundary.md) | Tool approval is a turn boundary | A gated call ends the turn; approval enqueues execution and a follow-up turn. |
| [0040](0040-deep-task-runfiber-in-do.md) | Deep tasks run in the Conversation Agent | Background fibers with one slot per chat, checkpoints, and delivery through the queue. |
| **Models** | | |
| [0008](0008-agentic-chat-on-vercel-ai-sdk-with-mcp-client.md) | AI SDK tool loop and outbound MCP client | `streamText` tool loop; MCP servers registered globally and reconciled each turn. |
| [0041](0041-unify-ai-frameworks-on-ai-sdk.md) | One AI SDK for all language-model calls | Chat, email, extraction and compaction share the AI SDK and usage accounting. |
| [0050](0050-use-deepseek-official-api.md) | One model through DeepSeek's official API | `deepseek-flash` for everything; no provider catalog or fallback. |
| **Delivery** | | |
| [0010](0010-rich-messages-for-the-streaming-reply.md) | Rich Messages for streamed replies | Markdown sent directly as Telegram Rich Messages for drafts and final segments. |
| [0012](0012-reply-surface-delivery-seam.md) | Separate orchestration from Telegram delivery | A Reply surface seam lets turns run against a recorder in tests. |
| [0021](0021-transcript-reply-multi-message-agentic-turn.md) | Multi-message transcript | Text segments and tool-status messages interleave; the flattened transcript is persisted. |
| [0026](0026-enriched-tool-line.md) | Tool labels and elapsed time | Tool lines show an input label, a result summary and the duration. |
| [0011](0011-debug-mode-emits-a-json-trace.md) | Admin-only JSON debug traces | Per-turn JSON document with model inputs, tool payloads and usage. |
| **Tools and memory** | | |
| [0015](0015-builtin-agent-tools-and-long-term-memory.md) | Built-in tools and chat-scoped memory | One tool factory; facts in DO SQLite, indexed in Vectorize with bge-m3. |
| [0019](0019-sandbox-code-interpreter-tool.md) | Sandbox-backed code execution | `run_code` and `run_shell` in a per-chat Cloudflare Sandbox with a daily time budget. |
| [0022](0022-web-search-and-weather-tools.md) | Web search and weather tools | Tavily search (when a key is set) and Open-Meteo weather as built-ins. |
| [0038](0038-layered-memory-auto-recall-and-fact-extraction.md) | Layered memory, extraction and auto-recall | Working and Knowledge facts, extraction from compaction summaries, and auto-recall on each message. |
| **Mini App** | | |
| [0035](0035-email-listing-and-miniapp-preview.md) | Email listing and preview in the Mini App | `initData` auth replaces bearer links; HTML is rendered in a sandboxed iframe. |
| [0036](0036-settings-mini-app-frontend-spa.md) | React Settings Mini App on the Worker | React + Vite + Tailwind SPA served as Workers Static Assets on the API's origin. |

## Referenced but not published

Code comments and the records above cite these as `ADR-NNNN, unpublished`. The
descriptions come from the context of those citations.

| ADR | Topic |
| --- | --- |
| 0009 | Email replies: inbound auth verdict (SPAM badge), one armed reply per chat |
| 0013 | The EmailReply module and its pinned `email_reply` store |
| 0014 | The unified saved-asset service |
| 0018 | Saving an email body as a `document` asset to discuss it in chat |
| 0025 | Free-form per-chat language preference |
| 0031 | Principal module: the invited allowlist and capabilities |
| 0037 | Manual "Sync commands" in the Settings shell |
| 0044 | Moving Worker tests from ts-node to Vitest |
| 0045 | The `turndown` / `ai` HTML-to-Markdown switch for email triage |
| 0048 | Callback-family descriptors for inline buttons |
| 0051 | Native Workers logging |
