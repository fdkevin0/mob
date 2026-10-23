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

### Experimental TypeScript TUI

`bun run tui:pilot -- --url http://127.0.0.1:8787 --token-file /path/to/data/token`
launches the OpenTUI React pilot against an already running service. It shares
`packages/client` with Web. Alternatively, `MOB_TUI=ts ./build/mob tui --demo`
uses the CLI's normal connect-or-start lifecycle; set the absolute
`MOB_TUI_ENTRY` source path for a Go binary outside `build/`. Unset/empty
`MOB_TUI` or `MOB_TUI=go` keeps Bubble Tea as the default.
Use Bun >=1.3.14 and an interactive terminal; OpenTUI uses a native library via
FFI. Node and cross-platform standalone packaging are not validated. See
[the pilot README](apps/tui/README.md) for input controls and limitations.

The workspace packages export TypeScript source for Bun/Vite, not a published
library or a separate release artifact. UI components, browser token storage and
terminal rendering are intentionally not shared.

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

`just test` runs the existing Go/Web/HTTP checks: `go test ./...`, the UI typecheck and Vitest suite
(`bun run test:webapp`), and `scripts/check-chat.ts`, which starts a temporary
service and reads its stream with the real AI SDK UI parser and shared client.
It also runs `bun run test:dsh`: the optional DSH bridge's typecheck, runtime
tests and Go MCP integration. Go-only environments skip that integration when
Bun or the installed DSH dependencies are absent; CI's integration job installs
both. See [DSH plugin setup](docs/features/deepseek-harness.md).
Also run `bun run test:client` (headless Node tests/typecheck) and
`bun run test:tui` (pilot typecheck/tests) when changing the shared client or TUI.
The integration script exercises both client types, concurrent readers,
reconnection, detachment, scoped approvals, stale decisions and Stop. CI also runs
`gofmt`, `go mod tidy -diff`, `go vet` and the race detector.

Tests use temporary data directories, local fixtures and fake providers, so
they need no keys and send nothing to real models, mailboxes or chats.

## Generated references

Edit the source and regenerate the affected artifact. Go tests reject stale output.

| Artifact | Source | Regenerate from the repository root |
| --- | --- | --- |
| `packages/client/src/contracts.ts` (`webapp/src/chat/contracts.ts` re-exports it) | Go contracts in `cmd/contracts` | `bun run generate:contracts` |
| `docs/environment-variables.md` | `internal/configuration/options.go` | `go run ./cmd/configdocs` |

### Documentation site

`apps/docs` builds the site at https://usemob.app/docs with Starlight. It
copies `README.md`, `CONTRIBUTING.md` and `docs/` in at build time, so write the
Markdown as usual; links between those files become site links and links to
other repository files point at GitHub. A new page under `docs/` needs an
entry in `apps/docs/pages.ts`, which sets the sidebar; the build fails without
one, and on broken links.

```bash
bun run --cwd apps/docs dev       # live preview at http://localhost:4321/docs/
bun run build:web                 # landing page, web UI and documentation
```

For documentation writing or organization, the repository skill
[mob-docs](.agents/skills/mob-docs/SKILL.md) points to the relevant sources.

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
