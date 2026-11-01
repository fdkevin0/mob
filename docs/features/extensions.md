# Extensions

Mob is a small kernel with extensions registered at compile time. Plugins add
tools, commands, HTTP routes, configuration and background runs beside their own
code, and the engine does not name them. Code from outside Mob comes in only
through [MCP servers](mcp.md): Mob ships as one binary, and loading code at run
time would keep it from being compiled ahead of time.

[DeepSeek Harness tools](deepseek-harness.md) use an optional Bun process with
the official Cordis runtime, connected over that same MCP boundary.

Adding a plugin is a directory under `apps/mob/src`, one import in
`apps/mob/src/plugins.ts`, and a `Plugin` (`packages/core/src/app/server.ts`)
that the directory pushes onto `hostPlugins`; configuration is one `Section`
(`packages/core/src/app/configuration.ts`).

## Tools

- A `Tool` (`packages/core/src/chat/tools.ts`) is a model tool definition, an
  optional `prompt` added to the system prompt when the tool is offered, and
  `run`. `run` gets a `ToolCall` with the parsed input, the stored part, the
  message, the store and the event sender. Its output and errors go back to the
  model, except `AwaitingApproval`, which ends the turn after an approval
  request, and an `Abort`, which ends the turn as a failure. A tool error after
  cancellation ends the turn as cancelled.
- `available` says when a tool is offered (plugin tools: while their plugin is
  enabled). `ownerOnly` limits it to the owner's turns. `exposure` makes it
  direct, deferred until `tool_search` loads it, or hidden, and `namespace`
  groups deferred tools where `tool_search` is described; see
  [Exposure and tool_search](tools-and-approvals.md#exposure-and-tool_search).
- To ask for approval, `run` calls `requestApproval` with the input the
  user will approve, and `approved` carries out the call once approved. `scope`
  decides which later calls a remembered approval covers. See
  [Tools and approvals](tools-and-approvals.md).
- `ConversationService.tools` is a `ToolRegistry`. Names are unique, and
  `sandbox` and `tool_search` are reserved: turns add those tools themselves. A
  turn offered two tools with one name fails. `registerSource` adds tools that
  change while Mob runs, and `registerEntries` adds what `tool_search` finds
  besides tools, such as skills.

## Hooks

`ConversationService.hooks` run around every turn, in registration order:

- `beforeTurn` may add to the request's system prompt before history is fitted
  to the context window. Recalling saved facts is one.
- `beforeTool` may refuse an offered call; its error is handled as the tool's
  own would be.
- `afterTurn` sees the saved reply and the turn's error.

Native plugins contribute these typed callbacks through their `hooks` field;
registration appends them after existing core hooks.
Hooks are registered once, before serving, and keep the engine's error handling.
Like tools, hooks that depend on optional configuration must check whether their
plugin is enabled; a hook is not gated on its plugin's background run or
connection status.

The engine's `run` (`packages/core/src/chat/engine.ts`) takes an `Agent`: the
tools and hooks of one turn.

## Commands and routes

- A plugin's `commands` join the server's command registry and are listed
  after the server's own. A `Command` (`packages/core/src/chat/commands.ts`)
  names the clients it is offered in (`interactive` is the web UI and the
  TUI) and returns Markdown or an action for the UI; `replyJSON` shows a value
  as indented JSON. A `CommandError` sets the HTTP status of a refusal.
- A `Route` is an HTTP endpoint at `/api/plugins/<plugin>/<path>`. `handle`
  returns a value for the JSON response or throws: a `CommandError` or an
  `HTTPError` sets the status, any other error is the plugin's service
  failing (502). `body` (`packages/core/src/app/http.ts`) reads a bounded JSON
  object, refusing a malformed body or fields it does not name with 400 and
  one over its size limit with 413.
- Commands about plugins in general (`/plugins`, `/test`, `/deliveries`,
  `/clear-secret`) and the configuration routes stay in the server.

## Background runs

- A plugin that runs while it is enabled, such as a channel polling its app,
  sets `background`: an `Extension` (`packages/core/src/app/extension.ts`)
  with a name and a `start` that reads the plugin's current configuration and
  returns a `Serve` function, or `undefined` when the configuration leaves it
  off.
- `Serve` gets an `AbortSignal` and a `status` callback. It runs until the
  signal aborts, reporting what it is doing (shown by `/api/plugins`), and
  releases its resources before it returns.
- `Extensions` starts every registered extension in registration order
  (`startAll`), restarts one after its configuration is saved (`reload`),
  reports each one's status (`Disabled`, `Connecting…`, then whatever the run
  reports) and stops them all in reverse order (`close`). Operations run one
  at a time, so a reload never races another, and a restart waits for the old
  run to return before calling `start` again.
- A run that throws is reported; one that returns on its own is shown as
  `Stopped` until it is reloaded. Status reports from an earlier run are
  dropped. Nothing restarts after `close`.

## Configuration sections

- A `Section` (`packages/core/src/app/configuration.ts`) describes one
  plugin's part of the saved configuration: its name, a title for menus and a
  label for messages, its zod `schema`, its `secrets`, whether it is enabled,
  how an enabled configuration is validated beyond its shape, and how it is
  tested.
- The schema is the only shape a submission may have: unknown fields, wrong
  types and fractional numbers are refused with 400, and missing values take
  the schema's defaults. A plugin never saved has the defaults of an empty
  object. The bundled plugins' schemas are in
  `packages/core/src/app/plugin-config.ts`, where clients take their types.
- A `Secret` names a credential at a dotted path, the `flag` that tells clients
  whether one is saved, and its owner: a blank submission keeps the saved
  credential only while the owner (such as an IMAP host and username) is
  unchanged. Clients never receive a credential, only its flag; flags they send
  back are dropped.
- `updatePlugin`, the connection test, `/test` and `/clear-secret` look the
  plugin up by section. `GET /api/plugins` returns `sections`, each with its
  schema as JSON Schema.
- The web UI builds the Telegram, Cloudflare and email configuration forms
  from schema metadata: `title` labels a field, `description` hints at it, and
  `secret` with `flag` makes a password field with a clear button. WeChat
  iLink signs in by QR code, so its form is its own.
