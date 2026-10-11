# 8. AI SDK tool loop and outbound MCP client

Date: 2026-06-20
Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Use the AI SDK's streaming tool loop and the Agents SDK's MCP client instead of
maintaining tool-call execution and transport by hand. `ConversationAgent` extends
plain `Agent`: Telegram delivers webhooks and receives Bot API messages, so a
connected-client chat abstraction adds no useful surface.

MCP servers are configured globally in D1 and reconciled per chat turn. A global
registry avoids re-adding each server in every chat; `/mcp` requires `manage_mcp`.
Authentication supports no credentials or a static bearer token. Tokens are stored
in D1, so database access must be treated as credential access. OAuth and approval
wrapping of MCP tools are not implemented. Unreachable servers are skipped with a
warning so one integration cannot prevent a chat turn.

All LLM paths now [share the AI SDK](0041-unify-ai-frameworks-on-ai-sdk.md).
Provider selection is defined in [ADR-0050](0050-use-deepseek-official-api.md);
Telegram delivery in [ADR-0021](0021-transcript-reply-multi-message-agentic-turn.md).
