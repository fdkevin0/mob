# Mob — local assistant

A Go service with SQLite persistence, a Wails desktop GUI, a React conversation UI
built with AI Elements + AI SDK UI, and a Bubble Tea / Bubbles / Lip Gloss TUI.
Bun manages the frontend toolchain. The original Telegram / Cloudflare modules
remain as reference; the local integrations described below are implemented in Go.

## Run locally

Requirements: Go 1.26+, Bun 1.3.10, and the platform prerequisites for
[Wails v2](https://wails.io/docs/gettingstarted/installation). Desktop packaging has
been checked on macOS arm64 only. The current toolchain targets macOS 13+; the
app is locally signed for development, not notarized for distribution.

With `just` installed, run `just` to list tasks. Common commands are `just install`,
`just build`, `just test`, and `just desktop`. Use `just mob serve --demo` to run
the built CLI in offline mode; `just test-legacy` checks the legacy modules.

```bash
bun install --frozen-lockfile
bun run build:cli

# Start an independent background runtime (offline demo)
MOB_DEMO=1 ./build/mob start
./build/mob status
./build/mob tui

# Stop it explicitly when finished
./build/mob stop

# Or run in the foreground, until Ctrl+C
MOB_DEMO=1 ./build/mob serve

# Desktop development (starts a service, or connects to the one already running)
MOB_DEMO=1 bun run desktop

# macOS app bundle: build/bin/mob.app
bun run build:desktop
```

Open `http://127.0.0.1:8787` for the same conversation UI in a browser. Paste the
local token from the file printed by `mob serve`; the Wails app obtains it directly.
For a background service, the token is in `MOB_DATA_DIR/token` and startup errors
are in `MOB_STATE_DIR/daemon.log` (XDG state home + `mob` by default). The token remains in the browser tab's session
storage until Disconnect or tab close.
For frontend-only development, run `bun run dev` alongside `mob serve`.

Start `./build/mob tui` or open the desktop app directly. Both start a local service
when needed and check configuration before opening chat. If an API key is missing,
enter it in the masked setup form and save; it takes effect immediately.
Get a DeepSeek key at https://platform.deepseek.com/api_keys.
Saving validates format only; the first model request verifies the credential.

The key is saved in the local SQLite database (unencrypted, file permissions 0600).
It is never returned by the configuration API or added to chat history.
Environment variables override the file and saved key: `MOB_API_KEY`, then
`DEEPSEEK_API_KEY`. A file-provided key also overrides the saved database key.
Demo mode skips key setup. An already running service determines configuration.
Conversations and saved facts are sent to the configured model provider.

`mob start` detaches the runtime. GUI/TUI attach to it and can close without stopping
Telegram. `mob stop` authenticates to that background instance and waits for shutdown;
it does not signal an arbitrary PID. No login item or system service is installed.
Without `mob start`, the first GUI/TUI owns the runtime until it exits; other clients
attach to that owner. `mob serve` stays tied to its terminal. `mob status` and the GUI
header distinguish background and session ownership. To change ownership, close the
current foreground/UI owner and then run `mob start` with the same environment.

## Current behavior

- Multiple conversations; structured text, reasoning and tool parts saved in SQLite.
- Real Chat Completions streaming, stop/cancel, partial-response preservation,
  duplicate-send protection and recovery of interrupted messages after restart.
- `datetime` tool and local `remember` tool. **Remember requires approval in this
  first local version**, unlike the original ungated cloud memory tool. Approval
  expires after one hour, releases the active turn, and is bound to the saved fact
  and conversation. Approve saves once and starts a continuation; deny writes a
  history note without another model call.
- Demo mode: send `/remember a fact` to check approval; other text receives a
  clearly marked simulated reply. This is not a substitute for provider testing.
- GUI and TUI share service-owned state; idle clients refresh history every two
  seconds. One active turn per conversation; a competing send gets HTTP 409.
- Message checkpoints occur during generation approximately once per second;
  forced termination can lose the final uncheckpointed second. Disconnection cancels
  the current request; reconnect reloads the persisted snapshot, not an event replay.

TUI: Enter sends, Alt+Enter / Ctrl+J inserts a newline, Ctrl+S stops the turn,
PgUp/PgDn scroll, Ctrl+C exits. `/new`, `/list`, `/open ID`, `/approve ID`, `/deny ID`
manage conversations and approvals. The TUI shows text/tool status; rich Markdown,
images and attachments are not implemented in this first version.

## Configuration

| Variable | Default / meaning |
| --- | --- |
| `MOB_CONFIG` | XDG config home + `mob/config.yaml`; an explicitly selected file must exist |
| `MOB_DATA_DIR` | XDG data home + `mob`; existing pre-XDG databases are reused in place |
| `MOB_STATE_DIR` | XDG state home + `mob`; background logs |
| `MOB_ADDR` | `127.0.0.1:8787`; loopback addresses only |
| `MOB_TOKEN` | Optional existing local access token, at least 32 characters; otherwise generated in `MOB_DATA_DIR/token` |
| `MOB_API_KEY` | Model API key; falls back to `DEEPSEEK_API_KEY` |
| `MOB_BASE_URL` | `https://api.deepseek.com`; HTTPS required except localhost models |
| `MOB_MODEL` | `deepseek-flash` |
| `MOB_DEMO` | `1` explicitly selects offline simulation |

The CLI uses [Cobra](https://github.com/spf13/cobra), paths use
[adrg/xdg](https://github.com/adrg/xdg), and configuration merging uses
[Viper](https://github.com/spf13/viper). Precedence is **explicit CLI flags →
environment → configuration file → defaults**. Plugins and UI-saved model keys
remain in SQLite. There is no `.env` auto-loader.

Start from [config.example.yaml](config.example.yaml). Supported file formats are
YAML, JSON and TOML. On macOS the default file is
`~/Library/Application Support/mob/config.yaml`; on Linux it is normally
`~/.config/mob/config.yaml`. `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`
are honored through adrg/xdg. Existing databases in the former OS config location
are reused instead of silently creating an empty workspace elsewhere.

```bash
./build/mob --help
./build/mob config check --config /path/to/config.yaml
./build/mob serve --config /path/to/config.yaml --addr 127.0.0.1:8787
./build/mob start --config /path/to/config.yaml
```

Persistent flags: `--config`, `--data-dir`, `--state-dir`, `--addr`, `--base-url`,
`--model`, `--demo`. Secrets have no CLI flag, so they do not enter process arguments.
`config check` validates without printing credentials. Start/status/stop must use the
same startup address/data-directory overrides. Background children preserve the
original flags and config path, rather than freezing file values into environment
variables. Environment changes require restarting the process.

The runtime watches the config file's directory with fsnotify so atomic file
replacement works. Every reload uses a fresh Viper instance, rejects unknown fields,
validates a complete candidate, and only then replaces the provider for future turns.
Active turns keep their original provider. Syntax/type errors, unsafe permissions,
file deletion and invalid values retain the last valid configuration; diagnostics
omit file contents and appear in stderr/background logs and `/api/runtime`.
`mob status` reports reload errors when the startup configuration remains readable.
Removing the watched directory requires restarting the service to resume watching.

`model`, `base_url`, `demo` and `api_key` can reload. Changing `addr`, `data_dir` or
`state_dir` rejects the whole candidate and requires restart. Files must be regular
(non-symlink), at most 64 KiB, and not group/world-writable on Unix. Files containing
an API key must have owner-only permissions (`chmod 600`); on Windows protect the
file with the user directory's ACLs. Malformed or missing explicitly selected files
fail startup. An absent default file is optional and can be created later.

A key supplied by file/environment cannot be changed by the UI. `api_key: ""`
explicitly suppresses a saved key; omitting the field restores the saved key for its
recorded API origin. UI-saved keys and their origins commit together. Legacy
unscoped keys are restricted to the original DeepSeek endpoint; re-enter a key for a
custom endpoint. Live changes to another API origin require a replacement key or
explicit empty key, preventing accidental forwarding of an existing credential.

The database owner holds a process lock; clients use HTTP rather than independently
opening the same SQLite file. Authentication represents one local user, not a
multi-user permission system. Browser dev origins on localhost port 5173 and the
Wails WebView origin are supported.

## Plugins and cloud connections

Open **Plugins & cloud services** in the GUI (also available before model setup),
or press **Ctrl+P** / enter `/plugins` in the TUI. Connections are optional and
stored in the same local database. Save applies immediately; restart is not needed.
Blank passwords keep the saved value for the same account/host. Changing a mail
host or username, or the Cloudflare account, requires credentials again.
Explicit secret updates use `secrets: {"token": {"mode": "keep|replace|clear", "value": "..."}}`
(the mode is one of those three values). Mail uses `imap.password`/`smtp.password`;
Cloudflare also accepts `secretKey`. Keeping a secret after changing its owner is
rejected. Existing blank-input clients remain compatible. The GUI has clear controls;
the TUI supports `/clear-secret PLUGIN FIELD`. Disable the plugin before removing a
required credential. Model configuration accepts `action: "replace"|"keep"|"clear"`;
an environment-managed model key cannot be edited through the API.

`GET /api/config` reports effective provider/source separately from saved plugin
configuration and Telegram connection status. Only masked presence flags are returned to clients. The database is unencrypted
and has 0600 permissions, including credentials; protect database backups accordingly.

### Email plugin — SMTP / IMAP

Enable Email, configure the From address and separate IMAP/SMTP hosts, ports,
usernames and app passwords, then **Test saved configuration**. Both implicit TLS
and STARTTLS verify certificates; plaintext authentication is not offered.
Typical ports: IMAP 993/TLS or 143/STARTTLS; SMTP 465/TLS or 587/STARTTLS.

- Refresh INBOX shows the newest 50 messages; previews use UID + UIDVALIDITY and
  BODY.PEEK, leaving messages unread. Previews are limited to 2 MiB per message.
- MIME text is decoded; HTML-only messages become plain text without loading remote
  images or scripts. Attachment filenames are shown, not downloaded.
- **Analyze with AI** sends the selected email's text to the configured model for
  importance, category and summary. The model receives no tools for this operation.
  This is explicit on-demand analysis, not background ingestion or auto-forwarding.
- Compose/reply opens a draft; **Review email → Send email** is the sending action.
  Repeated submission of the same attempt cannot send twice. An uncertain SMTP
  outcome is not automatically retried. Check the recipient/provider delivery logs
  before starting a new attempt. SMTP acceptance is not a delivery guarantee;
  this version does not append a copy to an IMAP Sent folder.
- The plugin can be disabled independently of chat. Its protocol/MIME code lives in
  `internal/plugins/email`; it is a built-in optional plugin, not a downloaded code loader.

TUI: `/email` lists messages, `/email UID VALIDITY` reads one,
`/email analyze UID VALIDITY` requests AI analysis, `/mail` opens the send wizard,
and `/test email` tests the saved connection. The TUI composer supports one paragraph;
use the GUI composer for multiline mail.

### Telegram Bot API

Enter the BotFather token and your numeric **allowed user ID**, then enable.
The service long-polls Telegram and handles only that user's private chat. No public
listener or Worker deployment is needed. Other users/groups are ignored.

Send text to chat, `/new` to start a conversation, and `/approve ID` / `/deny ID`
to resolve a memory request after reviewing it locally. Telegram conversations use
the same model, tools and SQLite history as GUI/TUI. Bot tokens are never included
in errors returned to clients. Polling offsets and processed update receipts survive
restart. Ambiguous reply delivery is recorded without automatic resend; conversation
history and the generated reply remain local. **Deliveries** in the GUI or
`/deliveries` in the TUI shows the latest 100 receipts, saved replies and errors.
There is no resend button: a new deliberate message is a new attempt.

An authorized update is acknowledged only after its receipt commits. A failed receipt
write stops polling without advancing the offset. Processing errors, cancellation,
successful sends and uncertain sends have distinct durable states. Restart marks
in-flight processing failed and in-flight sends uncertain; neither is replayed.

This computer/service must remain running. The bot must not have an active webhook
or another polling process; Mob reports the conflict and does not remove the existing
webhook. Configure and stop the old deployment deliberately before switching.
`/test telegram` checks bot identity and webhook state.

### Cloudflare

Configure **API Token + Account ID**, then enter resource IDs for the services you use.
Scope the token to that account and the required service operations.

| Service | Available integration |
| --- | --- |
| Workers AI | List models, run a prompt; optionally select it as the shared chat model |
| Vectorize | List indexes and query an existing index using Workers AI embeddings |
| D1 | List databases and execute explicit SQL with optional parameters |
| KV | List namespaces and read a key |
| R2 | List buckets using the API Token; list objects and preview up to 1 MiB using S3 credentials |

For Workers AI chat, select a chat model supporting the tools/streaming you need.
`MOB_DEMO=1` continues to override the chat model with simulation. Disabling the
Cloudflare chat option restores the configured DeepSeek/OpenAI-compatible provider.
For Vectorize, use the same embedding model/dimensions used to populate the index.
No automatic import, extraction or synchronization of local memory occurs yet.

R2 object access additionally needs an **R2 S3 Access Key ID + Secret Access Key**;
a general Cloudflare API Token alone does not authorize S3 requests. The default
R2 jurisdiction endpoint is used. Object lists return up to 100 entries with a cursor
for the next page; other resource lists currently show the provider's first page.

The GUI action panel uses saved settings. D1 runs exactly the SQL entered, including
writes; AI operations can incur provider charges. TUI equivalents include:

```text
/test cloudflare
/cloud ai.models
/cloud ai.run Explain this idea
/cloud vectorize.indexes
/cloud vectorize.query Search text
/cloud d1.databases
/cloud d1.query SELECT name FROM sqlite_master
/cloud kv.namespaces
/cloud kv.get my-key
/cloud r2.buckets
/cloud r2.list
/cloud r2.get example.txt
```

API references: [Telegram Bot API](https://core.telegram.org/bots/api),
[Workers AI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
[Vectorize](https://developers.cloudflare.com/api/resources/vectorize/),
[R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

## Current module boundaries

- `internal/chat`: `ConversationService.Execute` owns admission, validation,
  request deduplication, approval decisions, cancellation and the model loop.
  Its domain events are mapped by `internal/protocol` to AI SDK UI chunks; Telegram
  calls the same executor in-process. Tool definitions and implementations live
  together in `tools.go`.
- `internal/chat/store.go`, `delivery.go`, `migrations.go`: SQLite persistence,
  durable send receipts and sequential transactional `user_version` migrations.
  Existing unversioned databases upgrade in place; unknown future versions are
  rejected. SQLite remains the concrete persistence dependency, with no generic
  repository or external queue.
- `internal/plugins/email`: mail reading, analysis, send deduplication, SMTP/IMAP
  and MIME. `internal/plugins/telegram`: polling, private-user filtering, offset
  acknowledgement, conversation mapping and reply delivery. Neither imports the
  HTTP/runtime package.
- `internal/configuration`: XDG/Viper loading and safe file reload, secret ownership/update rules,
  saved configuration and effective provider selection. `cmd/contracts` generates
  React types from Go JSON structs; `bun run generate:contracts` refreshes them.
  Go tests reject stale generated types and invalid TUI form paths.
- `internal/app`: explicitly wires the conversation/configuration/plugin modules,
  manages poller replacement and exposes authenticated loopback HTTP adapters.
  `internal/local`: process ownership, database lock and background lifecycle.
- `internal/plugins/cloudflare`: named methods such as `QueryMemory`, `ExecuteSQL`
  and `ReadObject`. `Do(Action)` is retained only as the advanced action-panel
  dispatcher. Model, Telegram, Cloudflare and S3 clients accept per-instance
  transports; tests never replace the global HTTP transport.
- `webapp/src/chat/useConversation.ts`: transport, approvals and polling concurrency.
  Each plugin panel owns its form, operation and busy state; the shell handles
  navigation. Hidden panels retain unsaved drafts across navigation.

The ADRs in `docs/adr/` document the retained Cloudflare/Telegram implementation.
They remain historical decisions, including DO session storage, stream reply
surfaces and cloud tool approval boundaries; they do not prescribe the local Go
runtime above. Their original text and numbering are preserved.

## Verification and remaining migration

```bash
bun run test:webapp
bun run test:go
bun run test:integration
bun run test:legacy
bun run build:legacy
```

Go tests cover provider stream parsing, truncation, approval isolation/idempotency,
expiry, denial, cancellation, duplicate requests, recovery and the TUI's connection
to the real service. The cross-language integration check launches a temporary Go
service and consumes its messages using the actual AI SDK UI parser, including
approval and denial, validates persisted UI messages, and checks restart recovery.
Plugin tests also cover real local TLS/STARTTLS IMAP/SMTP sessions, MIME parsing,
secret masking, Telegram user isolation/deduplication, Cloudflare request routing,
GUI send review and the TUI configuration wizard. These tests use local fixtures and
fake providers, not paid models or real email/Telegram recipients.

Not yet migrated: bookmarks, mail OAuth/multiple accounts/background ingestion,
attachments, MCP, cloud sandbox/shell, automatic semantic memory retrieval/extraction,
compaction, scheduled turns, deep tasks and usage accounting. Local saved facts are included directly in model context; they
are not a replacement for Vectorize. Recent model context is capped at 40 messages;
older history remains visible in the UI. Requests in progress are marked interrupted
on restart, not automatically rerun. There is no durable background queue yet.
The default build/typecheck/tests cover the local chat application only. Legacy
Mini App commands are `bun run build:legacy` and `bun run test:legacy`; their output is
`webapp/dist-legacy/miniapp/`. Its old API is not supplied by the Go server, and its
assets are not embedded in the desktop or CLI. Legacy-only JavaScript dependencies
are declared in the `src` workspace; the shared Bun lock pins both workspaces.

See [migration research](docs/go-bun-migration-research.md) and
[chat UI comparison](docs/chat-ui-research.md). AI Elements source adaptations keep
[their Apache-2.0 license and provenance](webapp/src/components/ai-elements/SOURCE.md);
the rest of this repository retains its MIT license.

---

# Legacy Telegram AI modules

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
| `docs/adr/` | The architecture decisions behind these modules (numbering kept from the original repo, so gaps are expected and some cross-links point to unpublished ADRs) |

## Not included

These modules are imported but not published: `src/core/{bot,principal,cmd,callback-family}`,
`src/core/sync-commands`, `src/db/schema`,
`src/features/{assets,email,feed,queue,rich-message}` (apart from the shared helpers above).

The Mini App frontend builds on its own:

```bash
bun install --frozen-lockfile
bun run build:legacy  # webapp/dist-legacy/miniapp
bun run test:legacy   # legacy tsc + Vitest (happy-dom)
```

The build embeds the Git short commit ID, so it needs a Git checkout.

## Configuration

Secrets are never committed. The original deployment provides them as Worker
secrets (`wrangler secret put …`):

- `DEEPSEEK_API_KEY`: all LLM calls
- `TELEGRAM_API_TOKEN`: Telegram Bot API
- `TAVILY_API_KEY` (optional): enables `web_search`

Workers AI (`AI` binding) provides embeddings and document conversion; the
Vectorize index is 1024-dimension cosine with a `chatId` metadata index.

## License

[MIT](LICENSE)
