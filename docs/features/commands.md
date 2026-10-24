# Slash commands

Every slash command is written once, in the service, and every client that lists it gets
help, completion and execution from the same definition.

## Registry

- The command registry on `ConversationService` holds every command as a
  `Command`: its spec (name, usage, summary, clients), argument completers and
  how it runs. Commands about conversations and models register in
  `packages/core/src/chat/builtins.ts`; commands about plugins in general in
  `packages/core/src/app/server.ts`; a plugin's own commands live in its
  directory (see [Extensions](extensions.md)).
- A command lists only the clients that can carry it out (`web`, `tui`,
  `telegram`, `wechat`, `email`). Owner-only commands refuse other callers;
  holders of the local token and each channel's owner are owners.

## Running a command

- A **transcript** command (`/model`, `/models`, `/compact`) is answered by the
  chat stream and recorded in the conversation.
- Every other command runs through `POST /api/commands/run` and returns a
  `CommandResult`: Markdown to show (tables for listings, fenced blocks for raw
  output) and an optional `Action` the client performs itself:
  `open-conversation`, `decide` (an approval, sent through the client's own
  stream), `open-plugins` or `compose-mail`.
- Text that is not a command comes back `handled: false` and the client sends it
  as chat, so unknown `/words` still reach the model.

## Help and completion

- `GET /api/commands?client=NAME` returns a client's specs.
- `POST /api/commands/complete` takes `{client, conversationId, text}`, where
  `text` is the input up to the cursor, and returns suggestions that replace its
  last whitespace-separated token. Free text, multi-line input and finished
  arguments return `[]`. Arguments complete from live state: models,
  conversations, pending approvals, plugin secret fields and fixed choices.
  Vendor model listings get two seconds, so typing never waits on a slow
  provider.
- In Web, Tab accepts, ↑/↓ choose, Esc dismisses, and Enter accepts only when
  the suggestion changes a partly typed token, so a complete command still
  sends. Stale answers are dropped.
- The contract types live in `packages/client/src/contracts.ts`, which the
  service and every client import. `webapp/src/chat/contracts.ts` re-exports
  them for existing Web imports.

## Terminal

`mob tui` opens the OpenTUI React terminal UI (see [its README](../../apps/tui/README.md)).
It reuses an existing service or starts one in the background; use `mob start`
first to keep it running after exit.

- Enter sends; Ctrl+J inserts a newline. Drafts survive conversation switching
  in memory, not application restarts. Pasted multiline text is sent whole.
- The terminal retains one shared conversation client per conversation.
  Switching detaches its readers, not the service's turn. On reopening, an
  uncertain send is checked against history by its original request ID before
  offering recovery; newer drafts stay untouched and the original text is shown
  separately. An unconfirmed message is never automatically resent (see
  [Turns](turns-and-context.md)).
- F2 opens conversations, F3 tool details, F4 approval controls. Ctrl+S requests
  backend Stop; Ctrl+Q closes the terminal and leaves the service turn running.
- Slash commands run through the shared client, but the terminal has no
  autocomplete UI yet. Tab switches search/list focus in F2; Esc returns to chat.
- Plugin settings and mail-compose forms are not implemented in the terminal;
  their command actions point to Web.

## Clients

- Web and the terminal use `@mob/client` for command
  requests, chat fallback and approval continuations. Web completion requests
  also use this client; the same API is available to future terminal completion.
  Keyboard behavior and forms remain in each UI; single-line slash input is
  checked by the service, while multiline input goes to chat without being interpreted
  as a client command. The terminal uses `client: 'tui'`.
- Clients own their forms (plugin settings, mail compose); an action opens them.
- Messaging channels run commands through the registry too; see
  [Channels](channels.md). After each connection the Telegram bot calls
  `setMyCommands`, scoped to the owner's private chat, with the commands listed
  for `telegram` (names Telegram rejects are left out). A failure leaves polling
  running and is retried on the next connection.
