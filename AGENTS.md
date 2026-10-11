# Repository Guidelines

## Project Structure & Module Organization

Mob is a local Go assistant with SQLite persistence, a React web UI, a Wails desktop app, and a Bubble Tea TUI.

- `cmd/mob/` contains the CLI; `main.go` launches the desktop app.
- `internal/` contains application services, chat, providers, configuration, plugins, and TUI packages. Go tests sit beside their implementation.
- `webapp/src/chat/` contains the current UI; `webapp/src/components/ai-elements/` holds shared UI components. Built assets in `webapp/dist/` are embedded into Go binaries.
- `docs/adr/` records architecture decisions; `scripts/check-chat.ts` exercises the Go/AI SDK integration.

## Build, Test, and Development Commands

Use Go 1.26+ and Bun 1.4.3. Desktop development also needs Wails platform prerequisites.

- `bun install --frozen-lockfile`: install workspace dependencies.
- `bun run build:cli`: build frontend assets and `build/mob`.
- `./build/mob serve --demo`: run the service with an offline model.
- `bun run dev`: start Vite alongside the service.
- `bun run desktop`: start Wails development.
- `just test`: run Go, current UI, and integration checks.
- `bun run test:webapp`: typecheck and run UI tests.
- `go test ./...` and `go vet ./...`: test and inspect Go packages.
- `bun run generate:contracts`: regenerate UI contracts after changing their Go definitions.

## Coding Style & Naming Conventions

Change the database schema only by adding a migration to `internal/chat/migrations.go` with `Added` set to today's UTC date (`YYYYMMDD`); migrations are retired after their window (`docs/adr/0054`). Format Go with `gofmt`; use lowercase package names and exported PascalCase identifiers. Follow `.editorconfig`: tabs with width two, LF endings, and final newlines. `.prettierrc` specifies tabs, single quotes, semicolons, and a 140-character print width. Use PascalCase React components and `use`-prefixed hooks. Keep generated contracts synchronized through the generator.

## Testing Guidelines

Use Go's `testing` package with `*_test.go` and `TestName` functions. UI tests use Vitest, happy-dom, and React Testing Library in `*.test.ts` or `*.test.tsx`. Add regression coverage for changed behavior; no numeric coverage threshold is configured. Use temporary data directories and local fixtures for service tests.

## Commit & Pull Request Guidelines

`main` changes only through pull requests; each merge that passes CI is published as a nightly `{date}.{sha}` prerelease, and merging the release-please PR publishes a stable `vX.Y.Z` (`.github/workflows/release.yml`, `docs/adr/0057`). Follow history's `type(scope): description` convention, such as `fix(models): close reload race`. Keep commits focused. Describe the behavior change, link relevant issues, record validation commands and results, and include screenshots for UI changes.

## Security & Configuration

Start from `config.example.yaml`. Keep provider keys, tokens, and runtime databases out of commits. Provider credentials belong in owner-only `providers.json`; use `mob provider add deepseek --key-stdin` to supply a key.
