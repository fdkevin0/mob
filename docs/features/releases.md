# Releases and upgrades

Mob publishes two channels from `main`, and a database is upgraded only within a
migration window, so old schema code does not stay in the tree forever.

## Versions

- A nightly build is named `{date}.{sha}`: the UTC date of its commit and the
  commit's short hash, e.g. `20261011.c0502b6`. `internal/version` reads both
  from the VCS stamp Go adds to builds made in a Git checkout, so `go build`,
  and `bun run build:cli` need no linker flags. A build with uncommitted
  changes gets `-dirty`; `go run` and tests report `dev`.
- A stable build gets its `vX.Y.Z` tag through `-X internal/version.release`.
  `go install …@vX.Y.Z` reports the tag from the module version.
- `mob --version` and `GET /api/runtime` show the version.

## Channels

`.github/workflows/release.yml` runs once CI passes on a commit pushed to
`main`:

- **nightly**: the commit is published as a prerelease tagged `{date}.{sha}`,
  never marked as the latest release. Nightly releases may be pruned.
- **stable**: [release-please](https://github.com/googleapis/release-please)
  keeps one release PR open with the next `vX.Y.Z` and a `CHANGELOG.md` built
  from the `type(scope):` commit messages. Merging it tags the release, which
  becomes the latest one.

Stable releases start at `v0.1.0`. Below 1.0, a `feat` raises the minor version,
a `fix` the patch version, and a breaking change (`!` or `BREAKING CHANGE:`) the
minor version. Other commit types are left out of the changelog.

## Builds

- `.goreleaser.yaml` builds both channels with the web UI embedded: archives for
  Linux and macOS (amd64, arm64) and Windows (amd64), plus `SHA256SUMS`. CI
  checks that the binary reports the expected version. The desktop app is built by
  the `desktop` job (see [Desktop app](desktop.md)).
- Both channels attest their archives with `actions/attest-build-provenance`,
  verified with `gh attestation verify`.
- Each stable release updates the `mob` cask in `fdkevin0/homebrew-tap`
  (`brew install fdkevin0/tap/mob`, macOS and Linux). The cask removes the
  quarantine flag because the binary is not notarized.

Repository setup: a `HOMEBREW_TAP_TOKEN` secret that can push to the tap (without
it the cask is built but not pushed); a `RELEASE_PLEASE_TOKEN` secret so the
release PR starts CI; and GitHub Actions allowed to create pull requests.

## Database upgrades

- `PRAGMA user_version` holds the schema. The `meta` table's `service_version`
  holds the release that last opened the database, so a refusal can name it.
- Each migration in `internal/chat/migrations.go` records the UTC date it was
  written (`Added`, `YYYYMMDD`; a commit cannot name its own hash). A migration
  stays in the code for at least six months after that date.
- Opening a database:
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
- A user who skips more than a window upgrades in steps, each refusal naming the
  next release, and nothing is lost on the way.

### Closing a migration window

1. Choose the last published stable release that still contains the migrations
   to remove.
2. Rewrite `baseline` to create the schema they produce, so new databases start
   there, and raise `first` to that schema.
3. Delete those migrations and append `{Below: first, Release: that release}` to
   `retired`.

`TestSchemaHistoryRules` keeps the history consistent: `Added` is a date,
retired windows rise, end at `first` and name `vX.Y.Z` releases, and a baseline
exists exactly when migrations were retired. The named release must stay
published.
