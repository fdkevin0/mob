# 22. Web search and weather tools

Date: 2026-06-25
Status: Accepted

Provide search and weather as built-ins so ordinary chat does not require an
admin-managed MCP server for these capabilities.

`web_search` uses Tavily and is registered only when `TAVILY_API_KEY` exists.
Return ranked snippets and URLs; omit a generated answer and full page bodies.
The agent can follow a result with `fetch_url`, avoiding a duplicate answer model
and unnecessary context. Upstream failure is an error, not an empty result list.

`get_weather` uses Open-Meteo geocoding and forecasts without a key. Explicit
coordinates bypass geocoding; report the resolved place to expose ambiguity.
An unknown location returns a recoverable result so the model can ask for a more
specific place. Tool parameters and forecast limits live in the implementation.

Both expose compact transcript summaries and accept fake fetch implementations
for local tests. See the [tool factory](../../src/features/agent/tools/index.ts).
