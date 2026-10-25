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

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Validate unknown values once at the boundary that owns them. Pass typed values inward instead of repeating `typeof value === "object"` and property-existence checks. Do not defensively revalidate values already guaranteed by a schema, constructor, or internal type.
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`

Reduce total variable count by inlining when a value is only used once.

## Where to look

- `docs/architecture.md` when a change crosses packages.
- `docs/features/` for how the feature you are changing behaves.
- `CONTRIBUTING.md` before opening a pull request.
