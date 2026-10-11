# Mob — local assistant

A Go service with SQLite persistence, a Wails desktop GUI, a React conversation UI
built with AI Elements + AI SDK UI, and a Bubble Tea / Bubbles / Lip Gloss TUI.
Bun manages the frontend toolchain. The original Telegram / Cloudflare modules
remain as reference; the local integrations described below are implemented in Go.

## Amp orbs

`.agents/setup` prepares Debian orbs with the Go version from `go.mod`, the Bun
version from `package.json`, `just`, and Linux Wails build prerequisites. It installs
locked dependencies and builds the frontend and CLI, preserving module and build
caches in Amp's project snapshot. Exact snapshots skip setup; stale snapshots rerun
it without reinstalling unchanged toolchains or dependencies. Both scripts must
reach the project's default branch before future orbs use them.

`.agents/resume` only checks tool availability; it does not install dependencies,
start services, or authenticate. Setup persists tool paths for non-interactive login
shells. Run `just test` to check Go, UI, and offline integration behavior. No provider
credentials or external database are required. The optional container sandbox runtime
is not installed by setup.

To expose the offline app through an orb portal, start a supervised service:

```bash
amp orb service start mob --command './build/mob serve --demo' --port 8787 --portal
```

## Run locally

Requirements: Go 1.26+, Bun 1.4.3, and the platform prerequisites for
[Wails v2](https://wails.io/docs/gettingstarted/installation). Desktop packaging has
been checked on macOS arm64 only. The current toolchain targets macOS 13+; the
app is locally signed for development, not notarized for distribution.

With `just` installed, run `just` to list tasks. Common commands are `just install`,
`just build`, `just test`, and `just desktop`. Use `just mob serve --demo` to run
the built CLI in offline mode.

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

Run `mob open` while the service is running to sign a browser in to the same
conversation UI: it opens a one-time link that expires after 5 minutes. You can
also open `http://127.0.0.1:8787` and paste the local token from the file printed
by `mob serve`; the Wails app obtains it directly. For a background service, the
token is in `MOB_DATA_DIR/token` and startup errors are in `MOB_STATE_DIR/daemon.log`
(XDG state home + `mob` by default). The browser keeps the token in local storage
until Disconnect. `mob token rotate` replaces the token and signs out every browser,
terminal and desktop window.
For frontend-only development, run `bun run dev` alongside `mob serve`.

Start `./build/mob tui` or open the desktop app directly. Both start a local service
when needed. With no `providers.json`, Mob uses OpenCode Zen Free
(`opencode/mimo-v2.6-flash-free`) with an anonymous public token, so no setup is needed.

### Model providers

Providers live in `providers.json` beside `config.yaml` (XDG config home + `mob`),
owner-only (0600), keys included. Keys are never read from environment variables.
Manage them with the CLI; a running service reloads the file on its own:

```bash
mob provider add deepseek --key-stdin        # presets need only a key
mob provider add work --chat https://relay.example/v1 --key-stdin --models gpt-6,claude-sonnet-5
mob provider add ollama                      # local servers need no key
mob provider ls                              # keys shown masked
mob provider rm work
```

Pointing a provider at another URL requires its key again (`--key-stdin`) or
`--clear-key`, and `--clear-headers` when it has saved headers, so credentials
never follow a provider to a new host. The service and CLI lock `providers.json`
while changing it.

Presets: `opencode`, `openai`, `anthropic`, `deepseek`, `google`, `openrouter`,
`moonshot`, `zhipu`, `ollama`, `lmstudio`. Any other OpenAI- or Anthropic-compatible
endpoint is added with `--chat` or `--anthropic`.

In any conversation, in the web UI, TUI, Telegram or WeChat:

- `/models [FILTER]` lists the models of every provider, with what each can do.
- `/model NAME` switches this conversation. NAME may be `provider/model`, a model ID,
  or a unique fragment (`/model sonnet`); `:low`/`:high`… picks a reasoning level.
- `/model default NAME` sets the default for conversations without their own choice.

Only the owner switches models from channels: Telegram's configured user and the
first allowed WeChat user. Model capabilities and prices come from
[models.dev](https://models.dev), cached in XDG cache home + `mob/models.json`.
Conversations and saved facts are sent to the chosen model's provider.
The default free model may use collected data to improve the model; see
[OpenCode Zen privacy](https://docs.opencode.ai/docs/zen/#privacy).

`mob start` detaches the runtime. GUI/TUI attach to it and can close without stopping
Telegram. `mob stop` authenticates to that background instance and waits for shutdown;
it does not signal an arbitrary PID. No login item or system service is installed.
Without `mob start`, the first GUI/TUI owns the runtime until it exits; other clients
attach to that owner. `mob serve` stays tied to its terminal. `mob status` and the GUI
header distinguish background and session ownership. To change ownership, close the
current foreground/UI owner and then run `mob start` with the same environment.

## Current behavior

- Multiple conversations; structured text, reasoning and tool parts saved in SQLite.
- Real Chat Completions and Anthropic Messages streaming, stop/cancel, partial-response preservation,
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
  forced termination can lose the final uncheckpointed second. A turn keeps running when
  its client disconnects; reloading or opening the conversation elsewhere replays it and
  follows it live (`GET /api/chat/{id}/stream`). Only stop ends it early.

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
| `MOB_DEMO` | `1` makes the offline `demo/echo` model the default |
| `MOB_SANDBOX_ENABLED`, `MOB_SANDBOX_RUNTIME`, `MOB_SANDBOX_IMAGE`, `MOB_SANDBOX_NETWORK`, `MOB_SANDBOX_CPUS`, `MOB_SANDBOX_MEMORY`, `MOB_SANDBOX_ISOLATION` | Override the `sandbox` section; see [Sandbox](#sandbox) |

The CLI uses [Cobra](https://github.com/spf13/cobra), paths use
[adrg/xdg](https://github.com/adrg/xdg), and configuration merging uses
[Viper](https://github.com/spf13/viper). Precedence is **explicit CLI flags →
environment → configuration file → defaults**. Plugin settings remain in SQLite;
model providers and keys live in `providers.json` (see [Model providers](#model-providers)).
There is no `.env` auto-loader.

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

Persistent flags: `--config`, `--data-dir`, `--state-dir`, `--addr`, `--demo`.
`config check` validates config.yaml and providers.json without printing credentials. Start/status/stop must use the
same startup address/data-directory overrides. Background children preserve the
original flags and config path, rather than freezing file values into environment
variables. Environment changes require restarting the process.

The runtime watches the config file's directory with fsnotify so atomic file
replacement works. Every reload uses a fresh Viper instance, rejects unknown fields,
and validates a complete candidate before applying it. providers.json is watched the
same way; a rejected providers.json keeps the providers in effect. Active turns keep
the model they started with. Syntax/type errors, unsafe permissions,
file deletion and invalid values retain the last valid configuration; diagnostics
omit file contents and appear in stderr/background logs and `/api/runtime`.
`mob status` reports reload errors when the startup configuration remains readable.
Removing the watched directory requires restarting the service to resume watching.

Changing `addr`, `data_dir`, `state_dir` or `demo` rejects the whole candidate and
requires restart. Files must be regular (non-symlink), at most 64 KiB, and not
group/world-writable on Unix. providers.json holds keys and must be owner-only
(`chmod 600`); on Windows protect it with the user directory's ACLs. Malformed or
missing explicitly selected files fail startup. An absent default file is optional
and can be created later.

The database owner holds a process lock; clients use HTTP rather than independently
opening the same SQLite file. Authentication represents one local user, not a
multi-user permission system. Browser dev origins on localhost port 5173 and the
Wails WebView origin are supported.

### Sandbox

With the sandbox enabled, the model can run any shell command in a throwaway
container, without asking: install packages, run code, fetch from the network.
Only the conversation's workspace (`data_dir/sandbox/<conversation>`, mounted
at `/workspace`) persists between commands, and it is the only host path the
container sees (ADR 0055). Optional limits cut off the network and cap each
command's CPUs and memory (ADR 0056). On Linux, `isolation: gvisor` runs
commands under [gVisor](https://gvisor.dev) instead of directly on the host
kernel (ADR 0057).

```yaml
sandbox:
  enabled: true
  runtime: ""            # containerd (Linux), apple (macOS), wslc (Windows); empty: the platform's own
  image: python:3.13-slim
  network: ""            # none: no network; empty: the runtime's default
  cpus: 0                # whole CPUs per command; 0: the runtime's default
  memory: ""             # e.g. 512m or 2g, at least 64m; empty: the runtime's default
  isolation: ""          # gvisor: run under gVisor's runsc (containerd only); empty: the runtime's own
```

Linux uses containerd through `nerdctl` (with CNI plugins; rootless is
recommended; install [runsc](https://gvisor.dev/docs/user_guide/install/) for
`isolation: gvisor`), macOS uses Apple's [container](https://github.com/apple/container)
after `container system start`, and Windows uses WSL containers (`wslc`). Check
the runtime before enabling it:

```bash
mob container status                       # which runtime, and is it running
mob container pull python:3.13-slim
mob container run -v "$PWD:/work" -w /work alpine:3.20 ls -la
```

A command stops after 2 minutes by default (at most 5) and its container is
removed; output is cut at 16 KiB per stream. Network access and CPU/memory are
not limited unless set above.

`scripts/verify-sandbox.sh` (macOS, Linux) and `scripts/verify-sandbox.ps1`
(Windows) check a machine end to end; see
[docs/sandbox-verification.md](docs/sandbox-verification.md).

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
  importance, category and summary. Analysis never executes model tool calls.
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
Cloudflare chat option restores the configured Zen/DeepSeek/OpenAI-compatible provider.
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

### MCP servers

Mob can use the tools of [Model Context Protocol](https://modelcontextprotocol.io)
servers. List them under `mcp_servers` in `config.yaml`; changes reload live:

```yaml
mcp_servers:
  github:                       # a-z, 0-9, - and _; tools appear as mcp__github__<tool>
    command: npx                # started by Mob and spoken to over stdin/stdout
    args: [-y, "@modelcontextprotocol/server-github"]
    env: [GITHUB_PERSONAL_ACCESS_TOKEN=...]
  docs:
    url: https://example.com/mcp   # Streamable HTTP
    headers:
      Authorization: Bearer ...
```

Only the owner's turns are offered MCP tools, and only while their server is
connected. Every call waits for approval; **Always allow** (or
`/approve ID always`) stops asking for that tool on that server, and `/grants`
lists what is allowed. `/mcp` shows each server's status and tools. A command
inherits Mob's environment without the `MOB_*` variables, plus its `env`.
It runs as you, outside the sandbox, so configure only servers you trust. Keep
`config.yaml` owner-only (`chmod 600`) when it holds keys.

## Current module boundaries

- `internal/chat`: `ConversationService.Execute` owns admission, validation,
  request deduplication, approval decisions, cancellation and the model loop.
  Its domain events are mapped by `internal/protocol` to AI SDK UI chunks; Telegram
  calls the same executor in-process. Tool definitions and implementations live
  together in `tools.go`.
- `internal/chat/store.go`, `delivery.go`, `migrations.go`: SQLite persistence,
  durable send receipts and transactional `user_version` migrations kept for a
  migration window. A database too old or too new for this release is refused
  with the release to install instead (ADR 0054). SQLite remains the concrete
  persistence dependency, with no generic repository or external queue.
- `internal/version`: the release version; `mob --version` and `GET /api/runtime`
  report it. Every merge to `main` that passes CI is published as a nightly
  prerelease named `{date}.{sha}` from Go's VCS build stamp. Stable `vX.Y.Z`
  releases come from merging the release-please PR and are also installable with
  `brew install fdkevin0/tap/mob` (ADR 0057).
- `internal/plugins/email`: mail reading, analysis, send deduplication, SMTP/IMAP
  and MIME. `internal/plugins/telegram`: polling, private-user filtering, offset
  acknowledgement, conversation mapping and reply delivery. Neither imports the
  HTTP/runtime package.
- `internal/configuration`: XDG/Viper loading and safe file reload, secret ownership/update rules,
  saved configuration and effective provider selection. `cmd/contracts` generates
  React types from Go JSON structs; `bun run generate:contracts` refreshes them.
  Go tests reject stale generated types and invalid TUI form paths.
- `internal/container`: runs OCI images through the platform's container CLI
  (`nerdctl`, `container` or `wslc`) behind one `Spec`; `mob container` drives it.
  `internal/sandbox` builds the model's `sandbox` tool on it: per-conversation
  workspaces, pulls, timeouts and output caps.
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

ADRs 0006–0050 in `docs/adr/` record the retired Cloudflare Worker and Telegram Mini
App, whose code is kept at the `legacy-worker` tag; they are superseded and do not
prescribe the runtime above. ADR 0051 onwards describe this runtime.

## Verification and remaining migration

```bash
bun run test:webapp
bun run test:go
bun run test:integration
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

Not yet implemented: bookmarks, mail OAuth/multiple accounts/background ingestion,
attachments, MCP, a cloud sandbox (the local container sandbox is in place), automatic semantic memory retrieval/extraction,
compaction, scheduled turns, deep tasks and usage accounting. Local saved facts are included directly in model context; they
are not a replacement for Vectorize. Recent model context is capped at 40 messages;
older history remains visible in the UI. Requests in progress are marked interrupted
on restart, not automatically rerun. There is no durable background queue yet.
The retired Cloudflare Worker, kept at the `legacy-worker` tag, has reference
implementations of most of these.

AI Elements source adaptations keep
[their Apache-2.0 license and provenance](webapp/src/components/ai-elements/SOURCE.md);
the rest of this repository retains its MIT license.

## License

[MIT](LICENSE)
