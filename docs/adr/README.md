# Architecture decision records

Architecture decision records (ADRs) capture *why* a design was chosen, in the
style of [Michael Nygard's ADRs](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
They are a historical log: for how a feature works today, read its
[feature guide](../README.md#features).

- Numbers are kept from the private repository, so gaps are expected.
- An accepted record isn't rewritten. A new record supersedes it, and the old
  record's status becomes `Superseded by ADR-NNNN`.
- To add one, copy the [template](template.md), take the next free number
  above the highest ever used (0051), and link it from the relevant feature
  guide.

## Published

| ADR | Decision | Summary | Feature guide |
| --- | --- | --- | --- |
| **Agent and turns** | | | |
| [0006](0006-conversation-agent-durable-object.md) | One Conversation Agent per chat | A Durable Object per chat owns history and execution; turns run on a serial queue with `maxAttempts: 1`. | [conversation-agent](../features/conversation-agent.md) |
| [0047](0047-deepen-the-conversation-agent.md) | Conversation Agent module boundaries | Platform lifecycle stays in the agent; turn orchestration, stores and settings sit behind injected interfaces. | [conversation-agent](../features/conversation-agent.md) |
| [0017](0017-conversation-history-on-agents-session-api.md) | History on the Agents SDK Session API | SQLite-backed history, attachments and non-destructive compaction. | [conversation-agent](../features/conversation-agent.md) |
| [0028](0028-scheduled-turns.md) | Scheduled prompts run as serial chat turns | Local-time cron plus timezone, calculated with Croner and run through the normal turn path. | [scheduled-turns](../features/scheduled-turns.md) |
| [0039](0039-tool-approval-as-turn-boundary.md) | Tool approval is a turn boundary | A gated call ends the turn; approval enqueues execution and a follow-up turn. | [code-execution](../features/code-execution.md) |
| [0040](0040-deep-task-runfiber-in-do.md) | Deep tasks run in the Conversation Agent | Background fibers with one slot per chat, checkpoints, and delivery through the queue. | [deep-tasks](../features/deep-tasks.md) |
| **Models** | | | |
| [0008](0008-agentic-chat-on-vercel-ai-sdk-with-mcp-client.md) | AI SDK tool loop and outbound MCP client | `streamText` tool loop; MCP servers registered globally and reconciled each turn. | [models](../features/models.md), [tools](../features/tools.md) |
| [0041](0041-unify-ai-frameworks-on-ai-sdk.md) | One AI SDK for all language-model calls | Chat, email, extraction and compaction share the AI SDK and usage accounting. | [models](../features/models.md), [email-triage](../features/email-triage.md) |
| [0050](0050-use-deepseek-official-api.md) | One model through DeepSeek's official API | `deepseek-flash` for everything; no provider catalog or fallback. | [models](../features/models.md) |
| **Delivery** | | | |
| [0010](0010-rich-messages-for-the-streaming-reply.md) | Rich Messages for streamed replies | Markdown sent directly as Telegram Rich Messages for drafts and final segments. | [telegram-replies](../features/telegram-replies.md) |
| [0012](0012-reply-surface-delivery-seam.md) | Separate orchestration from Telegram delivery | A Reply surface seam lets turns run against a recorder in tests. | [telegram-replies](../features/telegram-replies.md) |
| [0021](0021-transcript-reply-multi-message-agentic-turn.md) | Multi-message transcript | Text segments and tool-status messages interleave; the flattened transcript is persisted. | [telegram-replies](../features/telegram-replies.md) |
| [0026](0026-enriched-tool-line.md) | Tool labels and elapsed time | Tool lines show an input label, a result summary and the duration. | [telegram-replies](../features/telegram-replies.md) |
| [0011](0011-debug-mode-emits-a-json-trace.md) | Admin-only JSON debug traces | Per-turn JSON document with model inputs, tool payloads and usage. | [debugging-and-usage](../features/debugging-and-usage.md) |
| **Tools and memory** | | | |
| [0015](0015-builtin-agent-tools-and-long-term-memory.md) | Built-in tools and chat-scoped memory | One tool factory; facts in DO SQLite, indexed in Vectorize with bge-m3. | [tools](../features/tools.md), [memory](../features/memory.md) |
| [0019](0019-sandbox-code-interpreter-tool.md) | Sandbox-backed code execution | `run_code` and `run_shell` in a per-chat Cloudflare Sandbox with a daily time budget. | [code-execution](../features/code-execution.md) |
| [0022](0022-web-search-and-weather-tools.md) | Web search and weather tools | Tavily search (when a key is set) and Open-Meteo weather as built-ins. | [tools](../features/tools.md) |
| [0038](0038-layered-memory-auto-recall-and-fact-extraction.md) | Layered memory, extraction and auto-recall | Working and Knowledge facts, extraction from compaction summaries, and auto-recall on each message. | [memory](../features/memory.md) |
| **Mini App** | | | |
| [0035](0035-email-listing-and-miniapp-preview.md) | Email listing and preview in the Mini App | `initData` auth replaces bearer links; HTML is rendered in a sandboxed iframe. | [mini-app](../features/mini-app.md) |
| [0036](0036-settings-mini-app-frontend-spa.md) | React Settings Mini App on the Worker | React + Vite + Tailwind SPA served as Workers Static Assets on the API's origin. | [mini-app](../features/mini-app.md) |

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
