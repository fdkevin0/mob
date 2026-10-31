# Architecture

Mob is one TypeScript program, compiled with Bun into a single executable that
embeds the web UI. The service owns a SQLite database and serves an
authenticated loopback HTTP API; the desktop app (Electron, `apps/desktop`), the
browser UI, the terminal UI and messaging channels are its clients. How each
feature behaves is in [features/](features/README.md).

The browser UI and the terminal UI share `@mob/client`. The core
(`packages/core`) keeps Bun and Node APIs out of its service logic: SQLite and
the host reach it through small interfaces. Its SQLite adapters use `bun:sqlite`
on the host and SQLite WASM in the browser. `apps/mob` is the Bun host that gives it
a database, files, processes and the command line.

## Where code lives

| Path | Owns |
| --- | --- |
| `packages/core/src/chat` | conversations and turns: `ConversationService`, the model loop, tool registry, hooks, command registry, approvals, context fitting (`prune.ts`, `compact.ts`), usage, search, and the SQLite store and schema |
| `packages/core/src/llm` | the provider-neutral model interface and its drivers (`openai`, `anthropic`, `demo`), and sending with retries (`send.ts`) |
| `packages/core/src/provider` | `providers.json`, presets and the models.dev catalog |
| `packages/core/src/app` | the HTTP routes and AI SDK UI stream (`http.ts`, `server.ts`), plugin lifecycle (`extension.ts`), the channel bridge (`channel.ts`), plugin configuration sections and schedules |
| `packages/core/src/sqlite` | the SQLite adapters: `bun:sqlite` for the host, SQLite WASM for the browser |
| `apps/mob/src/main.ts`, `config.ts`, `local.ts` | the CLI (commander), option definitions with their generated reference, XDG loading and live reload, process ownership, the database lock and the background lifecycle |
| `apps/mob/src/plugins.ts` | the host's plugins, each in its own directory: `agents` (coding agents over ACP), `email`, `telegram`, `cloudflare`, `wechat`, `mcp`, `skills`, `sandbox` (container runtimes and the model's `sandbox` tool) and `runner` |
| `apps/mob/src/runner`, `apps/web/worker/relay.ts` | end-to-end encrypted remote control, with account ownership in `apps/web/worker/runners.ts` |
| `apps/mob/scripts/build.ts`, `scripts/release.ts` | the single-executable build and the release archives |
| `packages/client` | the wire contract (`contracts.ts`), authenticated HTTP, AI SDK message state, commands, approvals, polling and stream recovery, shared by Web and the terminal |
| `packages/ui` (`@mob/ui`) | the design system: tokens and theme, the calf brand, source-owned shadcn/Radix controls and the header markup the site and docs share; no authentication or conversation state |
| `packages/app` (`@mob/app`) | the React workspace (`/app`), with adapted AI Elements; browser authentication/storage, DOM input/completion and presentation adapt the shared client. `mob` embeds its build, the desktop app loads it and the site deploys it |
| `apps/web` (`@mob/web`) | https://usemob.app: the landing page with GitHub sign-in and voxel scenes, the demo and account pages, the Cloudflare Worker (`worker/`) and the build that adds `/app` and `/docs` |
| `apps/docs` | the Starlight documentation built from this repository's Markdown |
| `apps/tui` | the OpenTUI React terminal UI; terminal input, focus, layout and scrolling adapt the shared client |
| `apps/desktop` | the Electron app around the `mob` executable |
| `apps/dsh` | optional Bun process loading official DSH/Cordis tool plugins and exposing them to Mob over MCP |

## Boundaries

- Every client and channel goes through `ConversationService`; Telegram, WeChat
  iLink and email call it in-process, other clients over HTTP. Nothing else opens
  the database.
- `@mob/client` shares conversation state across browser and terminal clients.
  In a browser, it uses document visibility events to pause polling while hidden
  and reload when shown. It uses the AI SDK's headless
  `Chat` state container (exported by `@ai-sdk/react`), `DefaultChatTransport` and
  `readUIMessageStream`, not a new message protocol. UIs subscribe to its stable
  snapshot and translate their own input events. Commands still run in the service;
  navigation/form actions return to the UI. Authentication failures carry the
  rejected token through a callback; only Web dispatches a browser event.
- Detaching a shared conversation client aborts its local readers, not the service's
  turn. Explicit Stop requests the service to stop it. Grants, expiry and
  duplicate-effect protections remain service-owned; clients never automatically
  retry an approval decision or uncertain side effect.
- Plugins register tools, commands, routes, configuration and background runs
  beside their own code; the engine does not name them (see
  [Extensions](features/extensions.md)). Code from outside Mob arrives only over
  MCP, including the optional [DeepSeek Harness tools bridge](features/deepseek-harness.md),
  and as [coding agents](features/coding-agents.md) over ACP, which answer
  their tasks' conversations through a `Delegate`.
- SQLite is the only persistence dependency: no generic repository and no
  external queue. Schema changes are upgrades in `packages/core/src/chat/schema.ts`
  (see [Releases and upgrades](features/releases.md)).
- Model, Telegram, Cloudflare and S3 clients take per-instance transports;
  tests never replace the global HTTP transport.
