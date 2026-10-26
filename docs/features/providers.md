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

In the web workspace, **Add a model provider** in the model picker, or **Model
providers** in the runner menu, does the same for the common presets, Ollama and
LM Studio, or a custom base URL. The dialog lists the connected providers
first, with the default's marked, then every provider as a tile with its logo;
choosing one shows its sign-in or key field, with a link to where its keys are
made, and the default model under **Default model**. Choosing a connected
provider replaces its key. Connecting uses `POST /api/providers` with
`{preset, url?, protocol?, key, model?}` lists the provider's models and saves
it as the default model, replacing a provider with the same ID. Without a
named model, OpenRouter starts on one of its free models that takes tools. The browser
runner saves through its own plugin route instead, which only offers vendors a
browser can call.

In any conversation, in every client and channel:

- `/models [FILTER]` lists the models of every provider, with what each can do.
- `/model NAME` switches this conversation. NAME may be `provider/model`, a model
  ID, or a unique fragment (`/model sonnet`); `:low`/`:high`… picks a reasoning
  level.
- `/model default NAME` sets the default for conversations without their own.

In the Web UI, choosing the model name below the message input opens a
searchable picker above the button, without a backdrop or blocking the
conversation; on a phone it opens as a sheet from the bottom of the screen. The
button shows the model's name and, when one is chosen, its reasoning level.

- Search and the **Reasoning**, **Vision**, **Tools** and **Free** chips narrow
  the list; with more than one provider, a provider menu narrows it to one.
- Each row shows the model's logo, name, what it can do and its context window,
  and marks the current model. Rows are grouped by provider, and a long
  provider list such as OpenRouter folds by vendor.
- **Follow the default** (with the default model's name) and **Recent**, the
  last few models chosen in this browser, come first when nothing is filtered.
  Recent choices are kept in this browser only.
- On a wide window, a card beside the list tells about the model under the
  pointer or focus, or else the current one: its full ID, context, maximum
  output, reasoning levels, input kinds, tools and price.
- When the current model takes reasoning levels, a **Reasoning** control under
  the list picks one (`provider/model:level`) or the model's default.
- The footer offers **Make … the default** (the same as `/model default NAME`)
  or names the default, and **Add a model provider**.

Arrow keys move between visible choices and Enter selects one; Enter in a
nonempty search selects its first result in an expanded group, or does nothing
if all result groups are collapsed. Clicking outside or pressing Escape closes
it; choosing a model also closes it. Choosing a model saves the conversation's
model setting through `POST /api/conversations/{id}/model` (`{model}`, empty
for the default), the same change `/model` makes; it sends no chat and keeps
the message draft. If the choice is refused, the picker stays open and the
error shows. The model can be changed while a reply is being written: that
reply keeps its model and the choice applies from the next one. A provider
whose model list fails stays visible with its error, including when search or a
filter is active.

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
- Choosing a model is a setting of the conversation, not part of its
  transcript: `/model`, `/models` and the web picker add no messages, and the
  next reply records the model it ran on. `/model` and `/models` are answered by
  the service for every client and channel through the command registry, and
  their answers are shown once, not stored. (Conversations from before this
  change may still hold `/model` commands recorded as `kind='command'`; they are
  shown as they were and never sent to a model.) `POST
  /api/conversations/{id}/model` saves the choice for the local UI, starting a
  conversation not started yet, which stays unlisted until something is said in
  it. Only the owner may switch: the local UI, the Telegram bot's user, the
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
