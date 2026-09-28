# Tools

The model can call built-in tools and tools from admin-registered MCP servers.
Built-in tools are assembled per turn by one factory, which offers only the
tools the sender is allowed to use and whose integration is configured.

## Built-in tools

| Tool | What it does | Available when |
| --- | --- | --- |
| `get_date_time` | Current time, in an optional IANA timezone | Always |
| `fetch_url` | Fetches a page as Markdown | Always |
| `web_search` | Tavily search: ranked titles, URLs and snippets | `TAVILY_API_KEY` is set |
| `get_weather` | Open-Meteo current weather and daily forecast | Always |
| `run_code` | Python, JavaScript or TypeScript in the sandbox | Always ([Code execution](code-execution.md)) |
| `run_shell` | Bash in the sandbox, after approval | Not inside deep tasks ([Code execution](code-execution.md)) |
| `remember`, `recall` | Save or search long-term memory | The chat has a memory scope ([Memory](memory.md)) |
| `schedule_turn`, `list_scheduled`, `cancel_scheduled` | Future prompts | `schedule_turns` capability ([Scheduled turns](scheduled-turns.md)) |
| `deep_task` | Background long-running task | `schedule_turns` capability; not inside deep tasks ([Deep tasks](deep-tasks.md)) |
| `list_feed_updates` | Recent entries from the chat's RSS/Atom feeds | A feed reader is supplied |
| `list_recent_emails` | Recent inbound email metadata | `manage_email` capability |

Asset tools from the unpublished asset service are also merged into the set.

### `fetch_url`

1. Requests the URL with `Accept: text/markdown`. A Markdown response is
   passed through unchanged.
2. Otherwise converts the HTML with the chat's **HTML parser** setting:
   - `turndown` (default): deterministic, free and fast.
   - `ai`: Workers AI `toMarkdown`. Slower and billed, but handles unusual
     HTML and keeps tables.
3. Truncates the result to 12,000 characters.

### `web_search`

Returns up to 5 ranked results with snippets and URLs. It returns no
generated answer and no full pages; the model follows up with `fetch_url`. An
upstream failure is reported as an error, not as an empty list.

### `get_weather`

Geocodes the place name, unless latitude and longitude are given, and reports
the resolved place so ambiguity is visible. Uses metric units. The forecast
defaults to 3 days (maximum 16). An unknown place returns a recoverable
result so the model can ask for a more specific one. No API key is needed.

### Read tools

`list_feed_updates` looks back 24 hours by default (maximum 168).
`list_recent_emails` returns 10 emails by default (maximum 50). Both are meant
for questions like "anything new?" and for scheduled briefings.

## MCP servers

MCP servers are registered globally in D1 and reconciled into each chat's
agent at the start of every turn. Their tools are namespaced by a normalized
server ID.

```text
/mcp list
/mcp add <name> <https-url> [token]
/mcp rm <name>
/mcp on <name>
/mcp off <name>
```

- `/mcp` requires the `manage_mcp` capability.
- Authentication is either none or a static bearer token.
- A name that normalizes to the same ID as an existing server is rejected.
- An unreachable server is skipped with a warning, so the turn still runs.

**Security:** bearer tokens are stored in D1, so read access to the database
is credential access. OAuth and approval wrapping for MCP tools aren't
implemented.

## Design decisions

- **One factory with injected dependencies.** Capability and configuration
  checks decide availability, so the model is never offered a tool it can't
  use ([ADR-0015](../adr/0015-builtin-agent-tools-and-long-term-memory.md)).
- **Markdown first, then local conversion.** Ordinary URL reads don't need a
  browser-rendering service.
- **Search and weather are built in.** Ordinary chat doesn't need an
  admin-managed MCP server for them. Search returns snippets only, to avoid a
  second answer model and wasted context
  ([ADR-0022](../adr/0022-web-search-and-weather-tools.md)).
- **A global MCP registry.** Servers aren't re-added in every chat
  ([ADR-0008](../adr/0008-agentic-chat-on-vercel-ai-sdk-with-mcp-client.md)).

## Source

- [`src/features/agent/tools/`](../../src/features/agent/tools/): one file per
  tool; [`index.ts`](../../src/features/agent/tools/index.ts) is the factory
- [`src/features/mcp/`](../../src/features/mcp/): the `/mcp` parser, command
  and D1 registry
- [`html-to-markdown.ts`](../../src/utils/html-to-markdown.ts)
- Tests: `builtin-tools`, `read-tools`, `mcp-parse` in
  [`src/tests/`](../../src/tests/)
