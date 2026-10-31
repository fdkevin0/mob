# Releases and upgrades

Mob publishes two channels from `main`, and a database is upgraded only within a
migration window, so old schema code does not stay in the tree forever.

## Versions

- A nightly build is named `{date}.{sha}`: the UTC date of its commit and the
  commit's short hash, e.g. `20261011.c0502b6`. The release workflow passes it to
  `scripts/release.ts`, which compiles it into the binary.
- A stable build reports its `vX.Y.Z` tag the same way. A build made without a
  version, such as `bun run build:cli`, and a run from source report `dev`.
- `mob --version` and `GET /api/runtime` show the version.

## Channels

`.github/workflows/release.yml` runs once CI passes on a commit pushed to
`main`:

- **nightly**: the commit is published as a prerelease tagged `{date}.{sha}`,
  never marked as the latest release. Nightly releases may be pruned.
- **stable**: [release-please](https://github.com/googleapis/release-please)
  keeps one release PR open with the next `vX.Y.Z` and a `CHANGELOG.md` built
  from the `type(scope):` commit messages, which are the titles of the
  squash-merged pull requests. Merging it tags the release, which
  becomes the latest one.

Stable releases start at `v0.1.0`. Below 1.0, a `feat` raises the minor version,
a `fix` the patch version, and a breaking change (`!` or `BREAKING CHANGE:`) the
minor version. Other commit types are left out of the changelog.

## Builds

- `scripts/release.ts` builds both channels with the web UI embedded, using
  `bun build --compile` from one Linux runner: archives for Linux (amd64,
  arm64, each for glibc and for musl), macOS (amd64, arm64) and Windows
  (amd64), plus `SHA256SUMS`. A musl build tells OpenTUI to load its musl
  library (`OPENTUI_LIBC`, set at build time). The release job installs
  every platform's native packages (`bun install --os='*' --cpu='*'`) so each
  target finds them. CI checks that the binary reports the expected version. The
  desktop app is built by the `desktop` job (see [Desktop app](desktop.md)).
- Both channels attest their archives with `actions/attest-build-provenance`,
  verified with `gh attestation verify`.
- With `--npm`, `scripts/release.ts` also writes the npm packages to
  `dist/npm`, and `scripts/npm/publish.ts` publishes them with provenance once
  the GitHub release exists. `usemob` holds the `mob` launcher
  (`scripts/npm/mob.js`) and lists one `@usemob/OS-ARCH` package per binary
  (`@usemob/linux-x64-musl` for musl) as an optional dependency. Their `os`,
  `cpu` and, on Linux, `libc` fields let npm and Bun install only the one for
  the machine; `scripts/npm/platform.js` finds it the same way. On
  Linux and macOS the package's postinstall (`scripts/npm/install.js`) hard
  links that binary over the launcher, so the command runs natively; on
  Windows, or when install scripts are skipped, the launcher runs the binary
  with Node.js. A stable `vX.Y.Z` is published as `X.Y.Z` under
  the `latest` tag. A nightly is published under the `nightly` tag as a
  prerelease of the next minor version, ordered by commit time, e.g.
  `0.3.0-nightly.20261030220535.g5caa651`. npm gave `latest` to the first
  nightly, so until a stable release takes it, each nightly moves `latest` too.
  Installing them is described in [Install](../install.md).
- An experimental workflow reports how much of the host
  [scriptc](https://github.com/vercel-labs/scriptc) can compile natively, after
  host changes reach `main` and weekly. It never blocks a merge, and no release contains a scriptc build.

Repository setup: on npmjs.com, each package (`usemob` and every
`@usemob/*`) names `fdkevin0/mob`'s `release.yml` as its trusted publisher, so
the workflow publishes without a long-lived token. An `NPM_TOKEN` secret, a
granular token for `usemob` and the `@usemob` scope, covers packages that have
no trusted publisher yet, such as a new platform's first release, and moves
the `latest` tag (without either, the packages are built but not published); a
`RELEASE_PLEASE_TOKEN` secret so the release PR starts CI; and GitHub Actions
allowed to create pull requests.

## Database upgrades

- `PRAGMA user_version` holds the schema. The `meta` table's `service_version`
  holds the release that last opened the database, so a refusal can name it.
- `packages/core/src/chat/schema.ts` holds the current schema and, by version,
  the statements that bring the one before it up to date. Opening a database:
  - empty: create the current schema;
  - schema 10 or newer: apply the remaining upgrades and the current schema in
    one transaction;
  - older than 10: refuse, and ask the user to start a Go release of Mob once
    to upgrade it;
  - newer than this code: refuse and ask for the release recorded in `meta`, or
    a newer one.

  A refused database is not changed. The desktop app shows the message in its
  window; the CLI prints it.
- An upgrade stays in the code for at least six months after it was written.
  To retire older ones, raise the oldest schema `open` accepts and name, in its
  refusal, the last release that still upgrades from there.
