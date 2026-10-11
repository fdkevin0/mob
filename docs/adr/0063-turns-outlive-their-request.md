# 63. Turns outlive the request that started them

Date: 2026-10-11
Status: Accepted

A turn started over `POST /api/chat` ran on the request's context. Closing the
tab, reloading or losing the network cancelled the reply, and other clients
could only poll the draft the turn saved every second. Remote access through a
relay (see the remote-access research) depends on this changing first, since a
phone's connection drops far more often than a local tab's.

## Decision

- `ConversationService.Start` admits a turn and runs it on the service's own
  context. Only `POST /api/conversations/{id}/stop`, `Close`, the five-minute
  turn limit, or replacing the access token that started it end it early;
  the token is watched from admission, so its replacement also stops an
  approved call that runs before the turn's first event.
  Errors before the turn emits anything (busy, repeated request, stale
  approval, no model) are still returned as HTTP errors.
- Every admitted turn, including those Telegram and WeChat iLink start with
  `Execute`, keeps a `chat.Running` log of its events in memory. Events are
  numbered from 1 and written as SSE `id:` lines.
- `GET /api/chat/{id}/stream` replays the running turn from its first event,
  or from the event after `Last-Event-ID`, and then follows it live. It answers
  204 when no turn is running. Any number of clients can follow one turn, and
  a client that leaves ends only its own stream.
- The web UI follows a running turn whenever a conversation snapshot says one
  is active. It reads the replay itself (`reconnectToStream` and
  `readUIMessageStream`) rather than through `resumeStream`, so every attempt
  builds the reply from fresh state and replaces the saved draft; one reconnect
  is in flight at a time and polling pauses until it ends. The terminal follows
  the same way.

## Consequences

Reloading, closing the window, or opening the conversation on another client
shows the reply still streaming instead of a cancelled message. Stop is the
only way to end a turn from a client.

The log is not persisted: a turn's events matter only while it runs, the saved
message is the result once it ends, and a service restart cancels running
turns as before. Writing every delta to SQLite would add many writes per turn
for no new capability, so no migration is needed. A relay can later carry the
same numbered events, and its mailbox can hold the finished message instead of
the deltas.
