# Configuration and running the service

Mob is one service that owns the SQLite database; the desktop app, browser, TUI
and channels are its clients. Start from
[config.example.yaml](../../config.example.yaml).

## Files and environment

| Variable | Default / meaning |
| --- | --- |
| `MOB_CONFIG` | XDG config home + `mob/config.yaml`; an explicitly selected file must exist |
| `MOB_DATA_DIR` | XDG data home + `mob`; existing pre-XDG databases are reused in place |
| `MOB_STATE_DIR` | XDG state home + `mob`; background logs |
| `MOB_ADDR` | `127.0.0.1:8787`; loopback addresses only |
| `MOB_TOKEN` | optional local access token, at least 32 characters; otherwise generated in `MOB_DATA_DIR/token` |
| `MOB_DEMO` | `1` makes the offline `demo/echo` model the default |
| `MOB_SANDBOX_*` | override the `sandbox` section; see [Sandbox](sandbox.md) |

- Precedence is explicit CLI flags, then environment, then the configuration
  file, then defaults. Persistent flags: `--config`, `--data-dir`,
  `--state-dir`, `--addr`, `--demo`. There is no `.env` loader.
- On macOS the default file is `~/Library/Application Support/mob/config.yaml`;
  on Linux normally `~/.config/mob/config.yaml`. YAML, JSON and TOML are
  accepted. Model providers and keys live in `providers.json` beside it (see
  [Model providers](providers.md)); plugin settings live in the database.
- `mob config check` validates `config.yaml` and `providers.json` without
  printing credentials.

## Live reload

- The service watches the configuration file's directory, so atomic replacement
  works. Each reload rejects unknown fields and validates a complete candidate
  before applying it. Syntax errors, unsafe permissions, deletion and invalid
  values keep the last valid configuration; diagnostics omit file contents and
  appear in stderr, the background log and `/api/runtime`.
- Changing `addr`, `data_dir`, `state_dir` or `demo` requires a restart, as do
  environment changes and removing the watched directory.
- Files must be regular (not symlinks), at most 64 KiB, and not group- or
  world-writable on Unix. `providers.json` must be owner-only (`chmod 600`); on
  Windows protect it with the user directory's ACLs. A missing default file is
  fine; a missing or malformed explicitly selected one fails startup.
- Active turns keep the model they started with.

## Who owns the service

- `mob start` runs the service in the background; `mob status` reports it and
  any reload errors; `mob stop` authenticates to it and waits for shutdown. Start,
  status and stop must use the same address and data-directory overrides.
- Without `mob start`, the first desktop app or TUI owns the service until it
  exits, and later clients attach to it. `mob serve` stays tied to its terminal.
  To change ownership, close the current owner and run `mob start` with the same
  environment. No login item or system service is installed.
- The database owner holds a process lock; clients use HTTP rather than opening
  the SQLite file.

## Access

- Authentication represents one local user, not a multi-user permission system.
  The desktop app gets the token directly. `mob open` signs a browser in with a
  one-time link that expires after 5 minutes; otherwise open
  `http://127.0.0.1:8787` and paste the token from `MOB_DATA_DIR/token`. The
  browser keeps it until Disconnect.
- `mob token rotate` replaces the token and signs out every browser, terminal and
  desktop window, and stops turns started with the old token.
- Browser dev origins on localhost port 5173 and the Wails WebView origin are
  allowed.
