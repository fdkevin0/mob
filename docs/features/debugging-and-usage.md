# Debug traces and usage

Two observability features: per-turn **debug traces** for the admin, and an
always-on **usage ledger** of tokens and sandbox time.

## Debug traces

When debug mode is on for a chat, every turn also sends a JSON document to
that chat containing:

- model inputs
- tool calls, with their arguments and results
- limits and token usage
- auto-recalled memories

Traces are for observation only and are never added to model history.

- **Turning it on:** Mini App → Settings → Debug. Requires `view_debug`.
- **Excluded:** connection credentials and inline image payloads.
- **Size:** capped at 1,000,000 bytes. Large fields are truncated with a
  `…[truncated]` marker.

**Handling:** traces can contain sensitive conversation text and tool
payloads. Keep them on the admin-only document surface, separate from
operational logs. The JSON document stays in Telegram after it's delivered.

## Usage ledger

Every model call inside the agent records tokens in a daily aggregate keyed
by **(day, user, kind, model)**, updated at the end of each call. Only tokens
are recorded, not money: a per-model price table would go stale.

| Kind | Recorded by |
| --- | --- |
| `chat` | Normal turns |
| `compaction` | History compaction |
| `extraction` | Memory fact extraction |
| `deep_task` | Deep-task fibers (on clean completion) |
| `email_triage` | The Worker's email handler, through RPC to the admin chat's agent |
| `email_reply` | Reply drafting |

Recording is best-effort; a ledger failure never fails a turn. `/usage` shows
today and the previous 7 days by kind and model, together with the
[sandbox budget](code-execution.md).

## Design decisions

- **A JSON document instead of inline debug text.** The visible conversation
  stays clean. Traces don't replace operational logging
  ([ADR-0011](../adr/0011-debug-mode-emits-a-json-trace.md)).
- **The ledger lives in the chat's agent.** No second, global accounting
  store, and the actual resolved model ID is recorded
  ([ADR-0041](../adr/0041-unify-ai-frameworks-on-ai-sdk.md)).

## Source

- [`debug-trace.ts`](../../src/features/agent/debug-trace.ts)
- [`usage-ledger.ts`](../../src/features/agent/usage-ledger.ts),
  [`stores/usage-ledger-store.ts`](../../src/features/agent/stores/usage-ledger-store.ts)
- Tests: `debug-trace`, `usage-ledger` in [`src/tests/`](../../src/tests/)
