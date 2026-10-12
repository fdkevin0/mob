# AGENTS.md

Mob is a local Go assistant: one service with SQLite, used from a React UI
(browser and Wails desktop), a Bubble Tea TUI, the `mob` CLI and messaging
channels.

## Working here

- `just` lists the usual recipes. Tests use temporary data directories, local
  fixtures and fake providers; they need no keys and reach nothing outside the
  machine. Run them, fix failures your change causes, and rerun them without
  asking.
- `./build/mob serve --demo` runs the app on an offline model when you want to
  see a change working.
- Go tests fail when `packages/client/src/contracts.ts` is stale; regenerate it with
  `bun run generate:contracts`.

## Rules tooling does not catch

- Schema changes are a new migration in `internal/chat/migrations.go`, with
  `Added` set to today's UTC date (`YYYYMMDD`).
- Commit messages use `type(scope): description`; release-please builds the
  changelog from them.
- Do not write architecture decision records. When a change alters how a
  feature behaves, update its page in `docs/features/` in the same pull request.
- Keep provider keys, tokens and databases out of commits.

## Where to look

- `docs/architecture.md` when a change crosses packages.
- `docs/features/` for how the feature you are changing behaves.
- `CONTRIBUTING.md` before opening a pull request.
