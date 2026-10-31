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
  `sandbox`, `tool_search` and `history_search` are reserved: turns add those
  tools themselves. A
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
plugin is enabled. Background dependency ordering does not reorder these hooks
or automatically gate them on connection status.

`chat.Run` takes an `Agent` (tools and hooks).

## Commands and routes

- Each plugin package exports what it adds, given what it needs from Mob (its
  configuration reader, the store, the conversation service, the default model
  or the HTTP transport): `Commands`, `Tools`, `Routes`, and `Extension` for a
  plugin that runs in the background.
- An `extension.Route` is an HTTP endpoint at `/api/plugins/<plugin>/<path>`.
  `Handle` returns a value for the JSON response or an error: a
  `*chat.CommandError` sets the status, any other error is the plugin's service
  failing (502). `extension.Decode` reads a bounded JSON body with no unknown
  fields, refusing anything else with 400.
- `chat.Reply`, `chat.ReplyJSON` and `chat.Interactive` let plugins answer
  commands the way the server's own commands do. Plugin commands are listed after
  the server's own.
- Commands about plugins in general (`/plugins`, `/test`, `/deliveries`,
  `/clear-secret`) and the configuration routes stay in the server.

## Background runs

- An `extension.Extension` is a name and a `Start` that reads the extension's
  current configuration and returns a `Serve` function, or nil when the
  configuration leaves it off.
- `Requires` names other background extensions. Before starting anything, the
  manager rejects missing dependencies and cycles, then calls `Start` in
  dependency order. A disabled or failed dependency leaves its consumers at
  `Waiting for <name>`; unrelated extensions still start. Register all
  extensions before the first start/reload; later registration is refused.
  Dependencies establish startup order and enabled state, not network readiness:
  prepare shared resources in `Start`, or make callers wait for an explicit
  readiness signal owned by the provider.
- `extension.Manager` starts every registered extension (`StartAll`), restarts
  one after its configuration is saved (`Reload`), reports each one's status
  (`Disabled`, `Connecting…`, then whatever the run reports, shown by
  `/api/plugins`) and stops them all (`Close`).
- Reloading an extension also reloads its transitive dependents. They stop in
  reverse dependency order, waiting for each `Serve` to return before stopping
  its provider, then start in dependency order. `Start` is not called until the
  old run has released its resources. Use `defer` in `Serve` for that cleanup;
  return promptly when its context is cancelled. A failed `Start` must release
  any resources it acquired itself.
- Reports from earlier runs are dropped. A run returning on its own stops its
  dependents and is reported as `Stopped` until reloaded. `Close` waits for
  cleanup in reverse dependency order. Nothing restarts after it closes.
- `Start` runs under the manager's lock and reads the saved configuration, so
  concurrent saves end with the last saved configuration running.

## Configuration sections

- A `configuration.Section` describes one plugin's part of the saved
  configuration: its name, a title for menus and a label for messages, the
  `Fields` a generic form asks for (JSON path, label and kind: `bool`, `int`,
  `text` or `secret`), its `Secrets`, whether it is enabled, how its connection
  is tested, and how a submitted configuration is merged with the saved one.
  Sections are built with `section` and listed once in `sections.go`.
- A `Secret` names a credential, where it lives in the configuration, and its
  owner: a blank submission keeps the saved credential only while the owner
  (such as an IMAP host and username) is unchanged.
- `UpdatePlugin`, the connection test, `/test` and `/clear-secret` look the
  plugin up by section. `GET /api/plugins` returns `sections`; the TUI builds its
  connection menu and forms from them. WeChat iLink signs in by QR code in the
  web UI, so it has no fields.
- A test checks every field against the configuration's JSON paths and kinds,
  and that the secret fields are the section's secrets.
- The web UI still has a hand-written form per plugin.
