# Extensions

Mob is a small kernel with extensions registered at compile time. Plugins add
tools, commands, HTTP routes, configuration and background runs beside their own
code, and the engine does not name them. Code from outside Mob comes in only
through [MCP servers](mcp.md): Go's `plugin` package has no Windows support and
cannot unload, and Mob ships as one binary.

Adding a plugin is a package, one entry in `plugins()` in `internal/app`, and,
for configuration, one `configuration.Section`. The `configuration.Plugins`
struct still names each plugin.

## Tools

- A `chat.Tool` is an `llm.Tool` definition, an optional `Prompt` added to the
  system prompt when the tool is offered, and `Run`. `Run` gets a `ToolCall`
  with the parsed input, the stored part, the message, the store and the event
  sender. Its output and errors go back to the model, except
  `ErrAwaitingApproval`, which ends the turn after an approval request, and
  errors wrapped by `Abort`, which end the turn as failures. A tool error after
  cancellation ends the turn as cancelled.
- `Available` says when a tool is offered (plugin tools: while their plugin is
  enabled). `OwnerOnly` limits it to the owner's turns.
- To ask for approval, `Run` calls `ToolCall.RequestApproval` with the input the
  user will approve, and `Approved` carries out the call once approved. `Scope`
  decides which later calls a remembered approval covers. See
  [Tools and approvals](tools-and-approvals.md).
- `ConversationService.Tools` is a `ToolRegistry`. Names are unique, and
  `sandbox` is reserved: the sandbox tool is added per turn when a sandbox is
  set. A turn offered two tools with one name fails. `RegisterSource` adds tools
  that change while Mob runs.

## Hooks

`ConversationService.Hooks` run around every turn, in registration order:

- `BeforeTurn` may add to the request's system prompt before history is fitted
  to the context window. Recalling saved facts is one.
- `BeforeTool` may refuse an offered call; its error is handled as the tool's
  own would be.
- `AfterTurn` sees the saved reply and the turn's error.

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
- `extension.Manager` starts every registered extension (`StartAll`), restarts
  one after its configuration is saved (`Reload`), reports each one's status
  (`Disabled`, `Connecting…`, then whatever the run reports, shown by
  `/api/plugins`) and stops them all (`Close`).
- A replacement run waits for the previous run to return, so two pollers never
  share a connection; reports from an earlier run are dropped; `Close` waits for
  every run, including a cancelled one still shutting down. After `Close`
  nothing restarts.
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
