# Configuration and running the service

Mob is one service that owns the SQLite database; the desktop app, browser, TUI
and channels are its clients. Start from
[config.example.yaml](../../config.example.yaml).

## Files and environment

The [configuration reference](../environment-variables.md) lists file keys,
CLI flags, `MOB_` variables, defaults and precedence.

On macOS the default file is `~/Library/Application Support/mob/config.yaml`;
on Linux normally `~/.config/mob/config.yaml`. YAML, JSON and TOML are accepted.
Model providers and keys live in `providers.json` beside it (see
[Model providers](providers.md)); plugin settings live in the database.
`mob config check` validates both files without printing credentials.

## Live reload

- The service watches the configuration file's directory, so atomic replacement
  works. Each reload rejects unknown fields and validates a complete candidate
  before applying it. Syntax errors, unsafe permissions, deletion and invalid
  values keep the last valid configuration; diagnostics omit file contents and
  appear in stderr, the background log and `/api/runtime`.
- Changing `addr`, `data_dir`, `state_dir`, `demo`, `token` or `gateway.url`
  requires a restart, as do environment changes and removing the watched directory.
  With a gateway connection configured, `gateway.node_id` and `gateway.token`
  also require restart. Gateway server address changes do not block local
  service reloads; restart `mob gateway` to apply them.
- Files must be regular (not symlinks), at most 64 KiB, and not group- or
  world-writable on Unix. `providers.json` must be owner-only (`chmod 600`); on
  Windows protect it with the user directory's ACLs. A missing default file is
  fine; a missing or malformed explicitly selected one fails startup.
- Active turns keep the model they started with.

## Who owns the service

- `mob start` runs the service in the background; `mob status` reports it and
  any reload errors; `mob stop` authenticates to it and waits for shutdown. Start,
  status and stop must use the same address and data-directory overrides.
- Without `mob start`, the first desktop app or Bubble Tea TUI owns the service until it
  exits, and later clients attach to it. `mob serve` stays tied to its terminal.
  To change ownership, close the current owner and run `mob start` with the same
  environment. No login item or system service is installed.
- The experimental TypeScript terminal (`bun run tui:pilot`) only attaches to
  an existing service. It neither starts nor shuts down the Go process.
- The database owner holds a process lock; clients use HTTP rather than opening
  the SQLite file.

## Access

- Authentication represents one local user, not a multi-user permission system.
  The desktop app gets the token directly. `mob open` signs a browser in with a
  one-time link that expires after 5 minutes; otherwise open
  `http://127.0.0.1:8787` and paste the token from `MOB_DATA_DIR/token`. The
  browser keeps it until Disconnect.
- `mob token rotate` replaces the managed token, signs out every client and
  stops turns started with the old token. A token supplied through configuration
  is fixed until restart and cannot be rotated by Mob.
- Files declaring `token` or `gateway.token` must be owner-only on Unix
  (`chmod 600`). Prefer a file or environment variable for secrets: CLI flags
  are visible in the invoking process's arguments. Background startup forwards
  secret flags through its child environment instead of child arguments.
- Browser dev origins on localhost port 5173, the Wails WebView origin and the
  `web_url` origin are allowed.

## Migrating older configuration

There are no legacy aliases. Update scripts and service definitions:

| Previous setting | Current setting |
| --- | --- |
| `MOB_NODE_ID` | `MOB_GATEWAY_NODE_ID` |
| `--node-id` | `--gateway-node-id` |
| `--connect-gateway` | `--gateway-url` |
| `mob gateway --addr` | `mob gateway --gateway-addr` |
| `mob gateway --token` | `mob gateway --gateway-token` |
| `MOB_WEB_URL=` to disable public Web | `--web-url=` or `web_url: ""` in the file |

`mob gateway` rejects explicit `--addr` and `--token` flags before startup,
with guidance to use their `--gateway-*` counterparts. Empty environment values
now fall back to the file or default.
