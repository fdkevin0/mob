# 6. One Conversation Agent per chat

Date: 2026-06-20
Status: Accepted

Conversation state belongs to one `ConversationAgent` Durable Object per Telegram
chat. Keeping history and execution together avoids the lost updates of a KV
read-modify-write history shared across concurrent webhook requests.

The Worker authenticates and dispatches updates; the agent owns history, settings,
queues, alarms, and fibers. The SDK's persisted serial turn queue orders model
turns explicitly; Durable Object identity alone is not a substitute for that queue.
Turns use `maxAttempts: 1` because replaying a turn can duplicate tool side effects.

History uses the [Session API](0017-conversation-history-on-agents-session-api.md).
The [agent module boundaries](0047-deepen-the-conversation-agent.md) keep storage
and platform lifecycle in the agent while exposing testable turn behavior.
