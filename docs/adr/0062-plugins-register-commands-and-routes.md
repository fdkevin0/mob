# 62. Plugins bring their own commands and routes

Date: 2026-10-11
Status: Accepted

After ADR 0061 the email and Cloudflare tools lived in their plugins, but
`/mail`, `/email`, `/cloud`, the mailbox, Cloudflare and WeChat iLink HTTP
routes, and the Telegram and WeChat iLink background runs were still written in
the server, which had to know each plugin's types and services. This finishes
step four of the extension architecture after ADR 0058–0061.

## Decision

- An `extension.Route` is an HTTP endpoint a plugin serves at
  `/api/plugins/<plugin>/<path>`. `Handle` returns a value for the JSON
  response or an error: a `*chat.CommandError` sets the status, any other
  error is the plugin's service failing (502). `extension.Decode` reads a
  bounded JSON body with no unknown fields, refusing anything else with 400.
- Each plugin package exports what it adds, given what it needs from Mob (its
  configuration reader, the store, the conversation service, the default model
  or the HTTP transport): `Commands`, `Tools`, `Routes`, and `Extension` for a
  plugin that runs in the background.
- The server keeps one list, `plugins()`, with an entry per plugin, and
  registers every entry's commands, tools, routes and background run. The
  commands about plugins in general (`/plugins`, `/test`, `/deliveries`,
  `/clear-secret`) and the configuration routes stay in the server.
- `chat.Reply`, `chat.ReplyJSON` and `chat.Interactive` let plugins answer
  commands the way the server's own commands do.

## Consequences

The URLs, commands and their output are unchanged. Plugin commands are now
listed after the server's own: `/mail`, `/email` and `/cloud` follow
`/clear-secret`. A plugin route's internal failure now answers 502 with the
error, where a few routes answered 500. Adding a plugin is a package plus one
entry in `plugins()` and, for configuration, one `configuration.Section`; the
`configuration.Plugins` struct still names each plugin.
