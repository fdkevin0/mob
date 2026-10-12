# Contributing

## Setup

You need Go (version in `go.mod`), Bun (version in `package.json`), and for the
desktop app the platform prerequisites for
[Wails v2](https://wails.io/docs/gettingstarted/installation). Desktop packaging
has been checked on macOS arm64 only; the app is signed locally, not notarized.

```bash
bun install --frozen-lockfile
bun run build:cli                 # web UI + build/mob
./build/mob serve --demo          # offline model, no keys needed
bun run dev                       # Vite, alongside a running service
bun run desktop                   # Wails development
```

`just` lists the same recipes (`just build`, `just test`, `just desktop`,
`just mob serve --demo`).

### Amp orbs

`.agents/setup` prepares a Debian orb with the toolchain versions above, `just`
and the Linux Wails prerequisites, installs locked dependencies and builds the
CLI. Stale snapshots rerun it without reinstalling unchanged tools.
`.agents/resume` only checks that the tools are there. Both scripts must reach
`main` before new orbs use them. The container sandbox runtime is not installed.
To expose the offline app through an orb portal:

```bash
amp orb service start mob --command './build/mob serve --demo' --port 8787 --portal
```

## Tests

`just test` runs everything: `go test ./...`, the UI typecheck and Vitest suite
(`bun run test:webapp`), and `scripts/check-chat.ts`, which starts a temporary
service and reads its stream with the real AI SDK UI parser. CI also runs
`gofmt`, `go mod tidy -diff`, `go vet` and the race detector.

Tests use temporary data directories, local fixtures and fake providers, so
they need no keys and send nothing to real models, mailboxes or chats. Go tests
also fail when `webapp/src/chat/contracts.ts` is out of date; regenerate it with
`bun run generate:contracts`.

## Changes

- `main` changes only through pull requests, merged by rebase; keep branches
  linear and rebase onto `main` rather than merging it in.
- Commit messages follow `type(scope): description`, e.g.
  `fix(models): close reload race`. release-please builds the changelog and the
  next version from them (see [Releases](docs/features/releases.md)).
- A pull request describes the behaviour change, links related issues, lists the
  checks run, and includes screenshots for UI changes.
- Design discussion happens in issues and pull requests. Mob does not keep
  architecture decision records; when a change alters how a feature behaves,
  update its page in [docs/features/](docs/features/README.md) in the same pull
  request.
- Schema changes are a new migration in `internal/chat/migrations.go` with
  `Added` set to the UTC date it was written (`YYYYMMDD`).
- Formatting: `gofmt` for Go; `.editorconfig` and `.prettierrc` for the rest.
- Never commit provider keys, tokens or databases.

AI Elements sources in `webapp/src/components/ai-elements/` keep
[their Apache-2.0 license and provenance](webapp/src/components/ai-elements/SOURCE.md).
