# Turns and context

A turn is one reply from the model, including every tool call it makes. This
page covers how a turn runs, how clients follow it, and what limits apply.

## Turns outlive their request

- `ConversationService.Start` admits a turn and runs it on the service's own
  context. Closing the tab, reloading or losing the network does not end it.
  Only `POST /api/conversations/{id}/stop`, `Close`, or replacing the access
  token that started it end it early. The token is checked at admission and
  watched after it, so a turn started with a replaced token does nothing, and a
  replacement also stops an approved call that runs before the turn's first
  event.
- Errors before the turn emits anything (busy, repeated request, stale approval,
  no model) are returned as HTTP errors. One turn runs per conversation; a
  competing send gets 409.
- Every admitted turn, including those channels start with `Execute`, keeps a
  `chat.Running` log of its events in memory. Events are numbered from 1 and
  written as SSE `id:` lines.
- `GET /api/chat/{id}/stream` replays the running turn from its first event, or
  from the event after `Last-Event-ID`, and then follows it live. It answers 204
  when no turn is running. Any number of clients can follow one turn, and a
  client that leaves ends only its own stream.
- The web UI and experimental TypeScript TUI use the same `@mob/client`
  conversation state and follow a running turn whenever a snapshot says one is
  active. The client reads the replay itself (`reconnectToStream` and
  `readUIMessageStream`) rather than through `resumeStream`, so every attempt
  builds the reply from fresh state and replaces the saved draft; one reconnect
  is in flight at a time, polling pauses until it ends, and a failed attempt
  waits for the next poll. Idle snapshots poll every two seconds. A snapshot
  requested before a local send or view detachment cannot overwrite newer
  state. Once an eligible result from a newer issued read has been published,
  neither an older success nor an older error can replace it. Successes and
  failures both advance this publication order. A later read that is merely
  pending does not block a completed result, so reads slower than the polling
  interval still update history and model rather than silently starving.
  Successful snapshot reconciliation clears transient polling/follow errors,
  but does not dismiss a failed command or approval decision.
  The original Go terminal follows the same service contract independently.
- A retained shared-client instance keeps uncertain send text and its original
  SDK-generated request ID across detach/start. Abort alone does not mean Go
  refused the request. The client stays busy until the local send settles and
  fresh history can be checked for that exact user-message ID, never by text.
  While history cannot be read (the service is unreachable), it stays busy but
  returns the original to an empty, unedited editor so the text is not lost.
  If found, it follows the accepted turn or shows completed history. If absent,
  it exposes `recovery: {requestId, text}` and a delivery-not-confirmed warning;
  it restores the editor only if no newer draft edit exists, even if the newer
  editor is now empty. It never automatically resends or replaces the ID.
  Later history can confirm that ID and clear recovery; a restored editor is
  cleared only if it has not been edited since. A manual Send is a new request,
  not a delivery guarantee for the uncertain original. Recovery is memory-only.
- Leaving a shared-client view cancels only that view's streams and polling;
  explicit Stop posts to the service and cancels the local readers. The direct
  Bun pilot only attaches to an existing service. `MOB_TUI=ts mob tui` instead
  uses the normal CLI lifecycle: it closes a service it starts when the terminal
  exits, but leaves an already running service and its turns alone.
- The reply is saved about once a second while it streams, so a forced
  termination can lose the last second. The event log is not persisted: the
  saved message is the result once a turn ends, and a service restart marks
  turns in progress interrupted rather than rerunning them.

## Limits follow the model

- **Messages.** A chat message has no length limit of its own. The chat request
  body is capped at 8 MiB only to stop runaway bodies, and neither the web
  composer nor the terminal input limits what is typed or pasted. A message that
  alone exceeds what the model's context leaves room for ends the turn with an
  error naming its size and the model, before any model request.
- **Terminal pastes.** The original Bubble Tea input keeps at most 10000 lines, so a
  bracketed paste that would bring the input to 100 lines is held aside, shown
  as `[Pasted text #1 · N lines · <random tag>]`, and sent whole. Only the
  placeholders the input made are expanded, in one pass. The experimental
  TypeScript terminal uses its native textarea rather than paste placeholders.
- **Replies.** A reply may use the model's output limit, up to 32000 tokens and
  at most a quarter of its context window. Without a known limit, the
  OpenAI-compatible driver lets the provider choose and the Anthropic driver
  asks for 32000; history still leaves room for a 32000-token reply. Anthropic
  thinking comes out of those reserved tokens, at most half of them; a reply
  under 2048 tokens has no thinking, as Anthropic requires at least 1024.
- **Time.** A turn has no deadline. It ends when it finishes, when it is
  stopped, or when it reaches the tool step limit (`max_tool_steps`, default
  20, at most 100, reloaded live). A reply that reaches the limit is saved with
  status `step-limit` and its stream ends as finished (`tool-calls`), not as
  an error. The web UI offers a Continue button under it that sends
  "Continue" without clearing or sending an existing editor draft; channels
  show the limit, and any message continues. A model request fails
  with "model stopped responding" when its response does not start, or stops
  arriving, for two minutes; a reply that keeps arriving is never cut off.
- **Tool arguments** may be up to 1 MiB.

## Counting the context

- A prompt may use the model's context window less the reply's reserve. The
  system prompt, the tool definitions and history count against it, as do the
  notice that history was cut and the note an approved call continues with.
- At the start of a turn, history is fitted to that budget from an estimate of
  about three bytes a token. When the model's window is unknown, the last 40
  messages are kept. Older history remains visible in the UI.
- When history does not fit, old tool outputs are cleared first (below), then
  older messages are summarized (below); only when that fails are whole turns
  omitted, oldest first.
- Within a turn, the prompt's size is what the provider reported for the last
  step, its input and output, plus an estimate of the tool results added since.
  Without a report, every added message is estimated.
- Before each further step, a prompt over budget first clears outputs the
  model has already read. If that is not enough, the turn ends with an error
  naming the model and the size, and asks the user to send another message,
  whose turn fits history to the window again.
- Providers count tokens their own way and can refuse a prompt the estimate let
  through. Drivers mark that refusal (`llm.ErrContextOverflow`), and the turn
  then frees about a quarter of the prompt once and asks again: before the
  model has replied, by fitting history to less; after, by clearing outputs the
  model has already read, never those of the step just run. A second refusal,
  or nothing to free, ends the turn and suggests `/compact`.

## Clearing old tool outputs

- Tool outputs are replaced, oldest first, with a short note naming the tool
  and the size of what was cleared. The note gives the saved file's path when
  there is one, so the model can read it again; otherwise it says to run the
  tool again.
- When history is fitted, the latest turn keeps its outputs. Within a turn,
  outputs from the step just run are never cleared, and once the provider has
  counted the prompt only outputs whose size was measured from its usage are
  cleared, so clearing never claims more room than it frees.
- Outputs smaller than about twice their note are left as they are. Stored
  messages keep every output; clearing changes only what the model reads.
- Clearing changes the prompt's prefix, so the provider's prompt cache misses
  once after each clearing. The code is in `internal/chat/prune.go`.

## Large tool output

- Tools return their whole result. Sandbox commands keep up to 1 MiB of each
  stream, and network reads keep their own size limits as a defence.
- The turn decides what the model reads. An output up to 24000 bytes of JSON,
  about 8000 tokens, is read whole.
- A larger output is shown as its head (two thirds) and tail (one third), with
  its size and a note. With a sandbox, the whole output is first saved as text
  in the conversation's workspace under `/workspace/.mob/outputs/`, the preview
  shrinks to 4000 bytes, and the note tells the model to read the rest with the
  sandbox tool. Without one, the preview uses the whole 24000 bytes. The budget
  counts the preview as the model receives it, escaping and note included.
- Each saved output gets a new file name, as call IDs repeat across turns. The
  save resolves every step of its path inside the workspace and never replaces
  an existing file, since commands can plant symlinks there.
- The stored message keeps the whole output and where it was saved, so the
  interface shows it all and later turns read the same preview. Approved calls
  follow the same policy.

## Summarizing older history

- When history does not fit after clearing, the conversation's model folds the
  older messages into the conversation's summary, stored with the ID of the
  last message it covers. Turns read the summary in the system prompt in place
  of those messages.
- The summary covers enough that the recent messages fill at most half the room
  beside it, so the next turns need not summarize again. It is written in parts
  that fit the model's window, each part refitted as the summary grows, and is
  at most 4000 tokens and no more than the latest message leaves room for.
- A stored summary is read whenever it fits beside the latest message. One that
  does not, as after switching to a model with a smaller window, is set aside
  for the turn, which reads the messages it covers instead. With an unknown
  window it is always read.
- When an approval is decided or expires, the call's stored message changes; a
  summary that covers it is dropped, and the next turn reads the call as it is.
- A failed summary, or one that comes out too long, is not used: the turn omits
  the older messages instead.
- `/compact` summarizes every message since the summary on request, with the
  conversation's model, and records what that cost on its reply, also when it
  is stopped. The code is in
  `internal/chat/compact.go`.
