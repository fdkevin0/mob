# 57. Nightly and stable release channels

Date: 2026-10-11
Status: Accepted

ADR 0054 published every merge to `main` as a release named `{date}.{sha}`.
That kept releases effortless, but every dependency update became a release,
the latest one could be an older commit when two runs finished out of order,
the names could not be ordered or compared, and users had no changelog, no
package manager and no way to verify where a binary came from.

## Decision

- **Two channels.** `.github/workflows/release.yml` runs once CI passes on a
  commit pushed to `main`:
  - **nightly**: the commit is published as a prerelease tagged `{date}.{sha}`,
    as before, but never marked as the latest release;
  - **stable**: [release-please](https://github.com/googleapis/release-please)
    keeps one release PR open with the next `vX.Y.Z` and a `CHANGELOG.md` built
    from the `type(scope):` commit messages. Merging it tags the release, which
    becomes the latest one.
- **Semantic versions below 1.0.** Stable releases start at `v0.1.0`. A `feat`
  raises the minor version, a `fix` the patch version, and a breaking change
  (`!` or `BREAKING CHANGE:`) the minor version until 1.0. Other commit types
  are left out of the changelog.
- **One build definition.** `.goreleaser.yaml` builds both channels with the web
  UI embedded: archives for Linux and macOS (amd64, arm64) and Windows (amd64),
  plus `SHA256SUMS`. A stable build gets its tag through
  `-X internal/version.release`; a nightly build still names itself from the
  VCS stamp, and CI checks that the binary reports the expected version.
  `go install …@vX.Y.Z` reports the tag from the module version.
- **Provenance.** Both channels attest their archives with
  `actions/attest-build-provenance`, verified with `gh attestation verify`.
- **Homebrew.** Each stable release updates the `mob` cask in
  `fdkevin0/homebrew-tap` (`brew install fdkevin0/tap/mob`, macOS and Linux).
  The cask removes the quarantine flag because the binary is not notarized.
  Publishing needs a `HOMEBREW_TAP_TOKEN` secret that can push to that
  repository; without it the cask is built but not pushed.
- **Migration windows name stable releases.** A retired window in
  `internal/chat/migrations.go` must name a `vX.Y.Z` release
  (`TestSchemaHistoryRules`), so the release a user is sent to has a changelog
  and stays published. Nightly releases may be pruned.

## Consequences

Releasing a stable version is a merge of the release PR, so its timing is a
choice rather than a side effect. A release PR opened with the default
`GITHUB_TOKEN` does not start CI; a `RELEASE_PLEASE_TOKEN` secret fixes that.
The repository must allow GitHub Actions to create pull requests. Nightly
releases keep the previous naming, so nothing changes for databases recorded
by existing builds. The Wails desktop app is still not built in CI.
