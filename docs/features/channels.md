# Messaging channels

Mob can be reached from Telegram, WeChat iLink and email. A channel is a plugin
that receives messages and answers them through one shared `channel.Bridge`, so
commands, approvals, delivery records and replies behave the same everywhere.

## The bridge

- `Answer` runs a message as a command in the channel's client or as a turn in
  the sender's conversation, carries out the actions commands return (open a
  conversation, decide an approval), and keeps only what the sender should read.
- `Deliver` records each message under its ID in the deliveries table, so a
  message is answered and sent at most once and an interrupted send is reported,
  not repeated. `/deliveries` lists them. A channel that answers while it
  keeps receiving calls `Accept` as each message arrives and `Finish` once it
  answers; `Message.Started` hands it the turn's stop as soon as the turn is
  admitted, so it can keep later messages in order.
- A message for a conversation whose turn is still running is answered with
  `channel.Texts.Busy` instead of waiting, and a turn stopped by the sender ends
  with what it wrote so far and `channel.Texts.Stopped`. A decision answered
  that way is not taken; `Reply.Settled` names an approval only once it no
  longer waits.
- `channel.Texts` is what a channel says in its own words: the help greeting,
  the approval prompt, the line before a decision's reply, and the answers for
  stale approvals, failures and empty turns. Telegram speaks English and WeChat
  iLink Chinese.
- A plugin keeps its transport and decides who is writing. There is no channel
  registry: a channel registers like any plugin, with an extension for its
  background run (see [Extensions](extensions.md)).
- `/help`, `/new`, `/approve`, `/deny`, `/grants`, `/revoke`, `/memories` and
  `/forget` are offered to every channel; owner-only commands refuse other
  senders.

## Replies are the turn's conclusion

- The bridge replies with the text of the turn's last step that wrote any, which
  concludes the turn. Text written between tool calls, reasoning and tool calls
  stay in the local conversation, where the web UI and TUI show the whole turn.
- `channel.Texts.Used`, when set, adds one line naming the tools the turn called
  and how often, so the sender knows work happened and where to read it.
- A channel's turn sets `chat.ChatRequest.Channel`, and the model is told that
  the reader sees only its last text, so it ends with an answer that stands on
  its own. No second model call writes a summary.
- Failures and approval requests are added after the conclusion. A turn whose
  last step writes nothing falls back to the last text written before it, such
  as the line before a tool call that asked for approval. A failed turn answers
  the sender with what went wrong.

## Telegram

- Setup: enter the BotFather token and your numeric allowed user ID, then
  enable. Mob long-polls the Bot API and answers only that user's private chat;
  no public listener is needed, and this machine must stay running.
- The bot must not have an active webhook or another polling process. Mob
  reports the conflict and does not remove an existing webhook. `/test telegram`
  checks the bot's identity and webhook state.
- An update is acknowledged only after its receipt commits, and polling offsets
  survive restart. Restart marks in-flight processing failed and in-flight sends
  uncertain; neither is replayed. There is no resend: a new message is a new
  attempt.
- Polling continues while a reply is written: each message is answered on its
  own, in the order it arrived. A message sent while the
  conversation's turn runs gets a busy reply with a Stop button, so it is never
  queued behind the turn.
- After a second, a reply in progress shows as a "Thinking…" draft
  (`sendMessageDraft`) with Telegram's stop button, renewed until the reply is
  sent; where drafts are unavailable the bot shows typing instead. The stop
  button and `/stop` (Telegram only) stop the running turn, which ends with
  what it wrote and "Stopped."
- Replies are Markdown rendered to Telegram's HTML subset: headings become bold
  lines, lists bulleted lines and tables aligned preformatted text, and only
  http, https and tg links are kept. Long replies are split between blocks
  (inside a block only when it alone is too long) to fit Telegram's 4096
  UTF-16 unit limit. Link previews are off. If Telegram rejects the HTML, the
  same text is sent plain.
- Captions are read as the message's text. Photos, files, voice and other media
  are not read; a message with only media is answered with a note saying so.
- Approvals show Approve, Allow in conversation, Always allow and Deny buttons; a tap is handled as the
  `/approve` or `/deny` message it stands for, and its row is removed once that
  approval is decided or found stale. A tap while that conversation's turn runs
  leaves the row in place. Approval buttons use the conversation saved with the
  approval, even after `/new`, `/open` or a restart, without changing the bot's
  currently selected conversation; so does `/approve ID` or `/deny ID` typed
  with an approval's ID. A conversation-scoped grant applies to that
  original conversation.
- Notices: while the bot polls, it sends the owner the notices Mob raises, such
  as a [coding agent's task](coding-agents.md) that waits for a decision, is
  done or failed, with approval buttons for what waits. A tap decides in the
  task's conversation and the reply is how the agent went on, so the turns a
  decision from the bot started send no notice of their own. Notices raised
  while the bot is not polling are not sent later; the conversation keeps
  them.
- Buttons stand in for typing commands. A tap on any button is handled as the
  command its data holds, as if the owner had typed it; a command longer than
  Telegram's 64-byte limit rides on a short token kept in memory, and a tap on
  a token from before a restart answers that the button expired, with the
  menu.
  - `/start` and `/help` offer New conversation, Conversations, Model, Compact,
    Memories, Remembered approvals, Usage and More. More lists Schedules and
    Tasks when those plugins provide their commands.
  - Conversation, model, memory, approval, schedule and task lists have Previous
    and Next buttons, eight entries per page. They read full service data rather
    than the command completer's twenty suggestions. The current conversation
    and effective model are marked ✓; models also offer following the default.
  - Memory and approval entries show their scope. Deleting a memory, cancelling
    a schedule, or clearing a whole list requires a confirmation tap. Completed
    mutations offer Back to list. Typed commands keep their existing behavior.
  - Task buttons open the task's conversation. Notices also offer Open
    conversation and, when available, Schedules, alongside approval buttons.
  - A tap on a list's choice removes the old choice buttons. Long callback
    commands still use expiring tokens. List menus query their data once; paging,
    confirmations and More stay local even when their internal commands are
    typed instead of tapped. They do not send prompts to the model.
- The bot's `/` menu comes from the [command registry](commands.md).

## WeChat iLink

- Connects natively through Tencent's WeChat iLink HTTP API
  (`ilinkai.weixin.qq.com`) in TypeScript (`apps/mob/src/wechat`).
- Sign-in is a QR code shown in the web UI (`get_bot_qrcode`, then
  `get_qrcode_status` until confirmed). After confirmation, click **Save
  configuration** to store the bot token and ID locally and enable polling;
  confirmation alone leaves them in the form, unsaved.
- Messages arrive by long polling `getupdates` with its sync cursor; replies use
  `sendmessage` bound to the incoming `context_token`, with typing indicators.
- Refuses senders not on its allowlist and treats only its first allowed user as
  the owner. Reads 批准 and 拒绝 as `/approve` and `/deny`, and accepts a bare
  reply when one request is pending.
- Deliveries are recorded as `wx:<bot>:<message>`.
- Messages with IDs must have saved receipts before the polling cursor advances.
  A receipt or cursor storage failure stops polling; resolve the storage problem
  and restart the plugin to resume. A recorded failed or uncertain send is not
  retried when the same message arrives again.
- A nonzero API `ret` is an error even with HTTP 200. Polling errors use the
  normal retry delay; failed sends appear as `failed-or-unknown` in deliveries.

## Email

**Answer mail** in the email plugin's settings (`email.Config.Channel`) turns on
answering mail. It names the owner's address and the authserv-id the provider
writes first in the `Authentication-Results` header of mail it receives
(`mx.google.com` for Gmail; a received message's original source shows yours). A background extension named `email` holds one IMAP
connection, waits with IDLE (or polls where the server has none), and answers
new INBOX mail as the `email` client.

- **Who is answered.** Mail is answered only when its one sender is the owner
  and the topmost `Authentication-Results` header with the configured
  authserv-id says the owner's domain passed DMARC, or signed it with DKIM. A
  `From` header alone is never trusted. This depends on the provider stripping
  forged `Authentication-Results` headers that claim its authserv-id, as
  providers following RFC 8601 do; a wrong authserv-id means no mail is answered
  rather than any mail being trusted.
- **No loops.** Mail marked as sent by a program (`Auto-Submitted`,
  `Precedence`, `List-Id`, an empty `Return-Path`) is not answered, and Mob's
  replies carry `Auto-Submitted: auto-replied`.
- **Threads.** A thread is a conversation: the key is the first of its
  `References`, or its `In-Reply-To`, or the message's own ID. Replies set
  `In-Reply-To` and `References` and keep the subject with `Re:`. Only what a
  reply adds is sent to the model: the text above the quoted message and the
  signature. A command is the first line.
- **Cursor.** UIDVALIDITY and the last UID handled are saved per mailbox. The
  first run, or a new UIDVALIDITY, starts from the newest message, so old mail
  is never answered. New mail is handled oldest first, read with `BODY.PEEK`,
  and stays unread.
- **Not supported.** Attachments are not read, and mail over 2 MiB is skipped
  without being downloaded.
