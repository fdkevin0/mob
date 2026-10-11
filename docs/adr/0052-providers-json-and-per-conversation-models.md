# 52. Providers in providers.json, models chosen per conversation

Date: 2026-10-11
Status: Accepted · supersedes the single-provider configuration of the Go runtime (base_url/model/api_key)

Users add any number of model providers and switch models inside a conversation
with `/model` and `/models`. There is no automatic routing.

## Decision

Four concepts, each with one job (layout follows yetone/magpie's `internal/provider`
and `internal/catalog`):

| Concept | Answers | Lives in |
| --- | --- | --- |
| Catalog | what a model can do: context, output limit, reasoning levels, tools, images, price | `internal/catalog`, the models.dev catalog cached in XDG cache `mob/models.json` (OpenCode's cache as fallback), refreshed daily |
| Provider | how to reach a vendor: base URL per protocol, key, picked models, overrides | `internal/provider`, `providers.json` beside `config.yaml` |
| Driver | one wire protocol | `internal/llm/openai` (Chat Completions), `internal/llm/anthropic` (Messages), `internal/llm/demo` |
| Model | a callable `provider/model[:effort]` | `llm.Model`, from `provider.Registry.Resolve` |

- **providers.json** is the only source of providers and keys. Mode 0600, atomic
  writes, the replaced file kept as `providers.json.bak`. An unreadable file is
  an error, never an empty list. Keys are never read from environment variables.
  The API and CLI show keys masked. The running service reloads the file when it
  changes; a rejected change leaves the providers in effect unchanged.
- **Presets** are curated (OpenCode Zen, OpenAI, Anthropic, DeepSeek, Gemini,
  OpenRouter, Kimi, GLM, Ollama, LM Studio): models.dev has no key pages,
  regional or multi-protocol endpoints. Any other vendor is added by URL.
- **Model lists** come from the vendor's `/models` (or `modelsURL`), else the
  preset's models.dev entry. Picks that held every listed model take in models
  listed since (`pickedFrom`). Unknown models are assumed to take tools.
- **Protocol per model**: the user's `modelPrefs.api`, else the only endpoint, else
  Anthropic Messages for Claude models, else Chat Completions.
- **Vendor quirks** belong to presets (OpenCode's client headers and free-tier
  tool stubs), never to URL sniffing.
- **Per conversation**: `conversations.model` holds the `/model` choice; empty
  follows `providers.json`'s `default`. Each assistant message records its model
  and usage (priced from the catalog).
- **Commands** `/model`, `/models` are answered by the service for every client
  and channel, stored in the transcript as `kind='command'` and never sent to a
  model. Only the owner may switch: the local UI, the Telegram bot's user, and
  the first allowed WeChat user.
- **History** is replayed as real tool calls and results, so one model can
  continue another's work. Reasoning from earlier turns is not replayed; it
  belongs to its model. History is trimmed to the model's context window, or
  to the last 40 messages when the window is unknown.
- **CLI**: `mob provider add|ls|rm` edits providers.json directly.

## Removed without migration

`base_url`, `model`, `api_key` in config.yaml; `MOB_API_KEY`, `DEEPSEEK_API_KEY`,
`MOB_BASE_URL`, `MOB_MODEL`, `--base-url`, `--model`; the SQLite `api_key`
setting (deleted by migration 3); the key setup screens and `POST /api/config`;
Cloudflare's `useForChat`. Workers AI is reachable as a custom provider.

## Consequences

- Adding a vendor is `mob provider add ID --key-stdin`; switching is `/model NAME`.
- Without a cached catalog (first run offline), models lack metadata: replies are
  capped at 4096 tokens and history at 40 messages until the catalog arrives.
- Not adopted from magpie: several keys per provider, fallback chains, routing
  groups, quotas and subscription sign-ins.
