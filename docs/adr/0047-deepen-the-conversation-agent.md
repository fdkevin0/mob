# 47. Conversation Agent module boundaries

Date: 2026-07-18
Status: Accepted

Keep platform lifecycle in the Conversation Agent and put turn orchestration
behind an injected interface. The former monolithic agent mixed SQL, settings,
tool assembly, and delivery, leaving the main turn testable only through a live
Durable Object.

- [ConversationAgent](../../src/features/agent/conversation-agent.ts) owns RPC,
  the persisted turn queue, alarms, fibers, Session history, and dependency assembly.
- [The turn driver](../../src/features/agent/turn-driver.ts) composes models,
  history, memory, tools, approval requests, and delivery through explicit
  dependencies. Passing the entire agent as the dependency interface would
  expose platform details again.
- [Store adapters](../../src/features/agent/stores/) own table access and domain
  mapping. The agent lazily creates a shared Drizzle handle and bootstraps tables
  once through [ensureStoreSchema](../../src/features/agent/stores/db.ts).
  [schema.ts](../../src/features/agent/stores/schema.ts) provides query types;
  bootstrap DDL and in-place memory migration remain explicit in `db.ts`.
- [ChatSettings](../../src/features/agent/chat-settings.ts) owns typed defaults
  and its key/value table. The agent exposes a Mini App snapshot and validated
  patch API. Pending email replies have a separate store; settings no longer
  use a chat-based pending-input flow.

The turn driver can be exercised with a fake model and delivery surface under
Node. These tests do not verify actual Durable Object lifecycle behavior.
[Deep tasks](0040-deep-task-runfiber-in-do.md) stay in the agent because their
tools depend on chat-local state; [approval](0039-tool-approval-as-turn-boundary.md)
remains a turn boundary.
