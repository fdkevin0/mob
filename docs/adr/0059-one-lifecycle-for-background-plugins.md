# 59. One lifecycle for plugins that run in the background

Date: 2026-10-11
Status: Accepted

Telegram and WeChat iLink each had their own restart function and their own
cancel, done, status and generation fields on the server, kept in step by
hand. A third channel would have meant a third copy, and the server stopped
and reported each one separately. This is step two of the extension
architecture begun in ADR 0058.

## Decision

- Package `extension` owns the lifecycle. An `Extension` is a name and a
  `Start` that reads the extension's current configuration and returns a
  `Serve` function, or nil when the configuration leaves it off.
- `extension.Manager` starts every registered extension (`StartAll`),
  restarts one after its configuration is saved (`Reload`), reports each one's
  status (`Disabled`, `Connecting…`, then whatever the run reports) and stops
  them all (`Close`). A replacement run waits for the previous run to return,
  so two pollers never share a connection; reports from an earlier run are
  dropped; `Close` waits for every run, including a cancelled one still
  shutting down. After `Close` nothing restarts.
- The server registers Telegram and WeChat iLink as extensions beside the code
  that configures them. Saving a plugin reloads the extension with its name,
  if there is one: email and Cloudflare have no background run.
- `Start` runs under the manager's lock and reads the saved configuration, so
  concurrent saves end with the last saved configuration running.

## Consequences

`/api/plugins` reports the same statuses as before. Adding a channel is one
`Extension` in the server's list. Later steps let extensions declare their
configuration schema, tools, commands and routes, so the server no longer
names each plugin.
