# 54. Release versions and database migration windows

Date: 2026-10-11
Status: Accepted; release naming and publishing amended by ADR 0057

Every schema change so far has been a migration kept forever, and the code could
only say that a database was "newer than this application". Keeping every
migration makes upgrades from any age possible but leaves old schema code in
the tree indefinitely, and the refusal never told the user what to install.

## Decision

- **Release versions.** A build is named `{date}.{sha}`: the UTC date of its
  commit and the commit's short hash, e.g. `20261011.c0502b6`. `internal/version`
  reads both from the VCS stamp Go adds to builds made in a Git checkout, so
  `go build`, `bun run build:cli` and Wails need no linker flags. A build with
  uncommitted changes gets `-dirty`; `go run` and tests report `dev`.
  `mob --version` and `GET /api/runtime` show it.
- **Releases.** `main` changes only through pull requests. When CI passes on a
  commit pushed to `main`, `.github/workflows/release.yml` builds the CLI with
  the web UI embedded for Linux, macOS and Windows and publishes a GitHub release
  tagged with the version the binary reports. `version.DownloadURL` points to
  that release.
- **Recorded in the database.** `PRAGMA user_version` holds the schema. The `meta`
  table's `service_version` holds the release that last opened the database, so
  a refusal can name it.
- **Migration windows.** Each migration in `internal/chat/migrations.go` records
  the UTC date it was written (`Added`, `YYYYMMDD`; a commit cannot name its own
  hash). A migration stays in the code for at least six months after that date.
  To close a window:
  1. choose the last published release that still contains the migrations to
     remove;
  2. rewrite `baseline` to create the schema they produce, so new databases
     start there, and raise `first` to that schema;
  3. delete those migrations and append `{Below: first, Release: that release}`
     to `retired`.
- **Opening a database:**
  - empty: create it from `baseline`, then apply every migration;
  - schema `first` or newer: apply the remaining migrations, one transaction
    each;
  - older than `first`: refuse, naming the retired release for its schema with
    its download link, and ask the user to start that release once and then come
    back;
  - newer than this code: refuse and ask for the release recorded in `meta`, or
    a newer one.

  A refused database is not changed. The desktop app shows the message in its
  window; the CLI prints it.
- `TestSchemaHistoryRules` keeps the history consistent: `Added` is a date,
  retired windows rise, end at `first` and name release versions, and a baseline
  exists exactly when migrations were retired.

## Consequences

The code carries at most one window of migrations plus a baseline. A user who
skips more than a window upgrades in steps, each refusal naming the next
release, and nothing is lost on the way. Closing a window requires that the
named release stays published. Releases carry the CLI only; the Wails desktop
app is not built in CI.
