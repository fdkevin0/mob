# 50. One model through DeepSeek's official API

Date: 2026-09-08
Status: Accepted

All LLM calls use `deepseek-flash` through the official Chat Completions endpoint
at `https://api.deepseek.com`. Direct access removes an unrelated gateway, while
Chat Completions preserves the existing AI SDK streaming and tool loop.

- Text and native image input use the same model. Utility calls disable thinking;
  chat exposes default/off/low/high/max. The provider adapter translates `off`
  to `thinking: { type: "disabled" }`.
- `DEEPSEEK_API_KEY` is a Worker secret in production and an ignored `.env` value
  locally. `env.CHAT_MODEL` permits test injection.
- Model catalogs, custom providers, selectable slots, and cross-provider fallback
  are removed. Old selections and provider KV entries are ignored, not migrated
  or remotely deleted. Removed Mini App endpoints return 404; ship frontend and
  Worker together. The former medium thinking value is not migrated.
- Workers AI remains for embeddings and document conversion. Global service
  settings control email HTML conversion only.

One model reduces configuration and compatibility paths; changing the provider
or model now requires a code change. Native attachment storage and limits are
recorded in the [architecture guide](../architecture.md#memory-and-assets).
