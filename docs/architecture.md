# Architecture

Mob is one Go binary. The service owns a SQLite database and serves an
authenticated loopback HTTP API; the desktop app (Wails), the browser UI, the
TUI and messaging channels are its clients. How each feature behaves is in
[features/](features/README.md).

The browser UI and the experimental TypeScript terminal share `@mob/client`.
The experiment runs from source with Bun, either directly or through
`MOB_TUI=ts mob tui`. Bubble Tea remains the default, and the selector does not
change the single-Go-binary release.

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
| `internal/agents` | coding agent tasks over ACP: projects, worktrees, the agent processes and Mob's project-manager tools |
| `internal/plugins/*` | email, Cloudflare, Telegram, WeChat iLink and MCP, each with its own tools, commands, routes and background run |
| `internal/container`, `internal/sandbox` | the platform container runtimes and the model's `sandbox` tool |
| `internal/runner`, `worker/relay.ts` | end-to-end encrypted remote control, with account ownership in `worker/runners.ts` |
| `internal/gateway`, `internal/node` | the experimental relay and edge-node client |
| `internal/tui` | the Bubble Tea terminal UI |
| `internal/version` | release versions |
| `cmd/contracts` | generates `packages/client/src/contracts.ts` from Go types; Web keeps a compatibility re-export |
| `packages/client` | authenticated HTTP, AI SDK message state, commands, approvals, polling and stream recovery, shared by Web and the terminal pilot |
| `webapp/src/chat` | the React UI; browser authentication/storage, DOM input/completion and presentation adapt the shared client |
| `webapp/src/styles`, `webapp/src/components` | shared site theme, brand assets, source-owned shadcn/Radix controls and adapted AI Elements; no authentication or conversation state |
| `webapp/src/landing` | the public landing page, GitHub sign-in and voxel scenes; a separate entry from the workspace |
| `apps/tui` | the experimental OpenTUI React UI; terminal input, focus, layout and scrolling adapt the shared client |
| `apps/dsh` | optional Bun process loading official DSH/Cordis tool plugins and exposing them to Mob over MCP |

## Boundaries

- Every client and channel goes through `ConversationService`; Telegram, WeChat
  iLink and email call it in-process, other clients over HTTP. Nothing else opens
  the database.
- Model and delegated turns share reply recording in `internal/chat/reply.go`:
  message parts, recording events, periodic saves and final persistence. The
  model loop and ACP adapter keep their own step grouping, execution and
  permission rules.
- Per-turn tool availability lives in `internal/chat/turn_tools.go`, with search
  in `search.go`. It restores loaded tools from history and commits newly found
  tools, definitions and prompts only after the current step. The model loop
  includes that prompt growth in its context budget.
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
  MCP, including the optional [DeepSeek Harness tools bridge](features/deepseek-harness.md),
  and as [coding agents](features/coding-agents.md) over ACP, which answer
  their tasks' conversations through `chat.Delegate`.
- SQLite is the only persistence dependency: no generic repository and no
  external queue. Schema changes are migrations in `internal/chat/migrations.go`
  (see [Releases and upgrades](features/releases.md)).
- Model, Telegram, Cloudflare and S3 clients take per-instance transports;
  tests never replace the global HTTP transport.
