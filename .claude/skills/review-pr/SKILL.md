---
name: review-pr
description: Review a GitHub pull request for correctness plus workspace cleanup and leftover legacy code, then post a concise review comment signed with model, tools and thinking effort.
---

# Review PR

## 1. Gather
- Read the PR title, description, linked issues, and the full diff (`gh pr view <n>`, `gh pr diff <n>`). Check CI status.
- Read surrounding code where the diff alone is not enough to judge.

## 2. Normal review
- Correctness: logic bugs, edge cases, error handling, races, security.
- Tests: do they cover the change and would they catch a regression?
- Fit: matches surrounding style, naming and conventions; PR title is a conventional commit (repo squash-merges).

## 3. Cleanup and legacy check (required)
- Workspace: no stray debug logs, commented-out code, TODOs without owners, temp/scratch files, generated artifacts, screenshots, lockfile churn, or unrelated changes.
- Legacy: when the PR replaces something, the old path is removed too — dead functions, unused exports/imports/deps, old config keys, feature flags, compat shims, outdated docs/README/comments, orphaned tests and assets. Grep for the old names to confirm nothing still references them.
- If removal is intentionally deferred, the PR should say so and link a follow-up.

## 4. Comment on the PR
Post one concise comment (`gh pr review <n> --comment|--approve|--request-changes --body ...`). Only real findings, most important first, with `file:line`. Format:

```
**Verdict:** Approve / Request changes / Comment

**Issues**
- `path:line` — problem and suggested fix

**Cleanup / legacy**
- `path` — leftover to remove (or "None found")

---
Reviewed by <model id> · tools: <tools used, e.g. gh, Read, Grep, Bash> · thinking: <effort level>
```

Use the actual serving model and effort level of this session; do not guess. Leave out empty sections except Cleanup / legacy.