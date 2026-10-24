# AGENTS.md

Mob is a local TypeScript assistant: one Bun service with SQLite, used from a
React UI (browser and Electron desktop), an OpenTUI terminal UI, the `mob` CLI
and messaging channels.

## Working here

- `just` lists the usual recipes. Tests use temporary data directories, local
  fixtures and fake providers; they need no keys and reach nothing outside the
  machine. Run them, fix failures your change causes, and rerun them without
  asking.
- `./build/mob serve --demo` runs the app on an offline model when you want to
  see a change working.
- `packages/client/src/contracts.ts` is the wire contract the service and its
  clients share; change both sides in the same pull request.
- Tests fail when `docs/environment-variables.md` is stale; regenerate it with
  `bun run generate:configdocs`.

## Rules tooling does not catch

- Schema changes raise `schemaVersion` in `packages/core/src/chat/schema.ts`
  and add the upgrade from the previous version to `upgrades`.
- Pull request titles use `type(scope): description`. Pull requests are
  squash-merged with the title as the commit message, and release-please builds
  the changelog from them.
- Do not write architecture decision records. When a change alters how a
  feature behaves, update its page in `docs/features/` in the same pull request.
- Keep provider keys, tokens and databases out of commits.

## Where to look

- `docs/architecture.md` when a change crosses packages.
- `docs/features/` for how the feature you are changing behaves.
- `CONTRIBUTING.md` before opening a pull request.
