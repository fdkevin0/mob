---
name: mob-docs
description: Write, revise or organize documentation in the Mob repository.
---

# Mob documentation

Keep each maintained fact in its owning document and link to it elsewhere.
Match the existing document's language; Mob's maintained docs are in English.
Describe shipped behavior, using the relevant code or tests when a claim needs
verification. Keep proposals in the issue or PR rather than presenting them as
current behavior.

## Choose the relevant source

Paths below are relative to this skill. Read only what the task needs.

- User-visible behavior belongs in the existing page under
  [docs/features](../../../docs/features/README.md).
- Package ownership and service boundaries belong in
  [architecture](../../../docs/architecture.md).
- Configuration names, defaults and help come from
  [options.go](../../../internal/configuration/options.go). Edit that source and
  run `go run ./cmd/configdocs` from the repository root to update the generated
  reference. Put operational behavior and migrations in the configuration feature page.
- Setup, validation and contribution workflows belong in
  [CONTRIBUTING.md](../../../CONTRIBUTING.md).

## Editing and organizing

Keep indexes as navigation, with enough context to choose a page. Link to the
owning explanation instead of copying its option lists or procedures. When moving
or deleting a page, update its incoming links and any generator that owns it.
A focused correction does not call for a repository-wide reorganization.

For agent instructions, retain project-specific decisions and invariants that
change how work is done. Use task-specific pointers instead of mandatory reading
lists or fixed itineraries. Keep a skill's description narrow;
add supporting references only when separate workflows need substantial detail.

Completion means the requested docs agree with their source, affected links
resolve, and generated pages are current. Choose checks for the changed artifact;
prose edits do not normally need application-wide tests. Follow the repository's
existing rules in AGENTS.md without duplicating them into each page.
