# Architecture

Mob is one Go binary. The service owns a SQLite database and serves an
authenticated loopback HTTP API; the desktop app (Wails), the browser UI, the
TUI and messaging channels are its clients. How each feature behaves is in
[features/](features/README.md).

The browser UI and the experimental TypeScript terminal share `@mob/client`.
The experiment is launched separately from source with Bun; it does not replace
the Bubble Tea TUI or change the single-Go-binary release.

## Where code lives

| Path | Owns |
| --- | --- |
| `cmd/mob` | the CLI (Cobra); `main.go` at the root launches the desktop app |
| `internal/app` | wiring: the HTTP server, plugin list (`plugins()`), plugin-level commands |
| `internal/local` | process ownership, the database lock and the background lifecycle |
| `internal/chat` | conversations and turns: `ConversationService`, the model loop, tool registry, hooks, command registry, approvals, context fitting, the SQLite store and migrations |
| `internal/protocol` | maps conversation events to AI SDK UI stream chunks; the gateway frame protocol |
| `internal/llm` | the provider-neutral model interface and its drivers (`openai`, `anthropic`, `demo`) |
| `internal/provider`, `internal/catalog` | `providers.json` and presets; the models.dev catalog |
| `internal/configuration` | shared option definitions for Cobra/Viper/generated reference, XDG loading, live reload, plugin configuration sections and secrets |
| `internal/extension` | the lifecycle of plugins that run in the background, and plugin routes |
| `internal/channel` | the bridge messaging channels answer through |
| `internal/plugins/*` | email, Cloudflare, Telegram, WeChat iLink and MCP, each with its own tools, commands, routes and background run |
| `internal/container`, `internal/sandbox` | the platform container runtimes and the model's `sandbox` tool |
| `internal/gateway`, `internal/node` | the experimental relay and edge-node client |
| `internal/tui` | the Bubble Tea terminal UI |
| `internal/version` | release versions |
| `cmd/contracts` | generates `packages/client/src/contracts.ts` from Go types; Web keeps a compatibility re-export |
| `packages/client` | authenticated HTTP, AI SDK message state, commands, approvals, polling and stream recovery, shared by Web and the terminal pilot |
| `webapp/src/chat` | the React UI; browser authentication/storage, DOM input/completion and presentation adapt the shared client |
| `apps/tui` | the experimental OpenTUI React UI; terminal input, focus, layout and scrolling adapt the shared client |

## Boundaries

- Every client and channel goes through `ConversationService`; Telegram, WeChat
  iLink and email call it in-process, other clients over HTTP. Nothing else opens
  the database.
- `@mob/client` has no browser or terminal APIs. It uses the AI SDK's headless
  `Chat` state container (exported by `@ai-sdk/react`), `DefaultChatTransport` and
  `readUIMessageStream`, not a new message protocol. UIs subscribe to its stable
  snapshot and translate their own input events. Commands still run in Go;
  navigation/form actions return to the UI. Authentication failures carry the
  rejected token through a callback; only Web dispatches a browser event.
- Detaching a shared conversation client aborts its local readers, not the Go
  turn. Explicit Stop requests the service to stop it. Grants, expiry and
  duplicate-effect protections remain service-owned; clients never automatically
  retry an approval decision or uncertain side effect.
- Plugins register tools, commands, routes, configuration and background runs
  beside their own code; the engine does not name them (see
  [Extensions](features/extensions.md)). Code from outside Mob arrives only over
  MCP.
- SQLite is the only persistence dependency: no generic repository and no
  external queue. Schema changes are migrations in `internal/chat/migrations.go`
  (see [Releases and upgrades](features/releases.md)).
- Model, Telegram, Cloudflare and S3 clients take per-instance transports;
  tests never replace the global HTTP transport.
