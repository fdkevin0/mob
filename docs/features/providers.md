# Model providers and models

Users add any number of model providers and switch models inside a conversation
with `/model` and `/models`. There is no automatic routing between models.

## Using it

With no `providers.json`, Mob starts on the offline demo model, which echoes
the prompt, until a provider is added. OpenRouter's `:free` models are a way to
start without paying. OpenCode Zen is offered with the user's key for its paid
models only: its free models are for OpenCode's own clients
([Zen docs](https://opencode.ai/docs/zen/)), so Mob hides them. Conversations
and saved facts are sent to the chosen model's provider.

```bash
mob provider add deepseek --key-stdin        # presets need only a key
mob provider add work --chat https://relay.example/v1 --key-stdin --models gpt-6,claude-sonnet-5
mob provider add ollama                      # local servers need no key
mob provider add magpie                      # the magpie gateway on this machine
mob provider ls                              # keys shown masked
mob provider rm work
```

Preset IDs: `opencode`, `openai`, `anthropic`, `deepseek`, `google`,
`openrouter`, `moonshot`, `zhipu`, `ollama`, `lmstudio`, `magpie`. Any other
OpenAI- or Anthropic-compatible endpoint is added with `--chat` or
`--anthropic`.

In any conversation, in every client and channel:

- `/models [FILTER]` lists the models of every provider, with what each can do.
- `/model NAME` switches this conversation. NAME may be `provider/model`, a model
  ID, or a unique fragment (`/model sonnet`); `:low`/`:high`… picks a reasoning
  level.
- `/model default NAME` sets the default for conversations without their own.

In the Web UI, choosing the model name below the message box opens a
searchable picker instead of requiring the command. It lists every enabled
provider's models with what each can do, marks the current one, and offers
**Follow the default** for conversations that should not pin a model. Choosing
a model runs the same `/model` command, so commands, channels and the shared
client remain the single implementation of model switching. Picker commands
preserve the message draft even if switching fails. Model choices are disabled
while a turn or command is busy. A provider whose model list fails stays visible
with its error, including when search or the free-only filter is active.

[magpie](https://github.com/yetone/magpie) serves every provider signed in to it
from a gateway on this machine. `mob provider add magpie` reads the port from
magpie's `settings.json` (read only), checks that magpie answers there, and
lists the models turned on in magpie. Calls carry the key `magpie-mob`, so
magpie's usage and routing rules see them as Mob's.

## Concepts

| Concept | Answers | Lives in |
| --- | --- | --- |
| Catalog | what a model can do: context, output limit, reasoning levels, tools, images, price | `packages/core/src/provider/catalog.ts`, the models.dev catalog cached in XDG cache `mob/models.json` (OpenCode's cache as fallback), refreshed daily |
| Provider | how to reach a vendor: base URL per protocol, key, picked models, overrides | `packages/core/src/provider`, `providers.json` beside `config.yaml` |
| Driver | one wire protocol | `packages/core/src/llm/openai.ts` (Chat Completions), `anthropic.ts` (Messages), `demo.ts` |
| Model | a callable `provider/model[:effort]` | `llm.Model`, from `provider.Registry.Resolve` |

## providers.json

- It is the only source of providers and keys. Mode 0600, atomic writes, the
  replaced file kept as `providers.json.bak`. An unreadable file is an error,
  never an empty list. Keys are never read from environment variables.
- The API and CLI show keys masked. The running service reloads the file when
  it changes; a rejected change leaves the providers in effect unchanged.
- `mob provider add|ls|rm` edits it directly; the service and CLI lock the file
  while changing it. Pointing a provider at another URL requires its key again
  (`--key-stdin`) or `--clear-key`, and `--clear-headers` when it has saved
  headers, so credentials never follow a provider to a new host.

## Presets and model lists

- **Presets** are curated because models.dev has no key pages, regional or
  multi-protocol endpoints.
- **Vendor quirks** belong to presets, never to URL sniffing. Mob does not
  present itself as another vendor's client.
- **Model lists** come from the vendor's `/models` (or `modelsURL`), else the
  preset's models.dev entry. Picks that held every listed model take in models
  listed since (`pickedFrom`). Unknown models are assumed to take tools.
- **Protocol per model**: the user's `modelPrefs.api`, else the only endpoint,
  else Anthropic Messages for Claude models, else Chat Completions.

## Per-conversation models

- `conversations.model` holds the `/model` choice; empty follows
  `providers.json`'s `default`. Each assistant message records its model and
  usage, priced from the catalog.
- `/model` and `/models` are answered by the service for every client and
  channel, stored in the transcript as `kind='command'` and never sent to a
  model. Only the owner may switch: the local UI, the Telegram bot's user, the
  first allowed WeChat user and email's owner address.
- History is replayed as real tool calls and results, so one model can continue
  another's work. Reasoning from earlier turns is not replayed; it belongs to
  its model. How history is fitted to the model is in
  [Turns and context](turns-and-context.md).

## Not supported

Several keys per provider, fallback chains, routing groups, quotas and
subscription sign-ins. Without a cached catalog (first run offline), models lack
metadata until the catalog arrives, and history falls back to the last 40
messages.
