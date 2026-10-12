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
  not repeated. `/deliveries` lists them.
- `channel.Texts` is what a channel says in its own words: the help greeting,
  the approval prompt, the line before a decision's reply, and the answers for
  stale approvals, failures and empty turns. Telegram speaks English and WeChat
  iLink Chinese.
- A plugin keeps its transport and decides who is writing. There is no channel
  registry: a channel registers like any plugin, with an extension for its
  background run (see [Extensions](extensions.md)).
- `/help`, `/new`, `/approve`, `/deny`, `/grants` and `/revoke` are offered to
  every channel; owner-only commands refuse other senders.

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

- Connects through the Bot API with long polling and answers only its configured
  owner, in a private chat.
- Approvals show Approve, Always allow and Deny buttons; a tap is handled as the
  `/approve` or `/deny` message it stands for.
- The bot's `/` menu comes from the [command registry](commands.md).

## WeChat iLink

- Connects natively through Tencent's WeChat iLink HTTP API
  (`ilinkai.weixin.qq.com`) in pure Go: QR-code sign-in in the web UI, long
  polling with `getupdates`, context-bound `sendmessage` and typing indicators.
- Refuses senders not on its allowlist and treats only its first allowed user as
  the owner. Reads 批准 and 拒绝 as `/approve` and `/deny`, and accepts a bare
  reply when one request is pending.
- Deliveries are recorded as `wx:<bot>:<message>`.

## Email

`email.Config.Channel` turns on answering mail. It names the owner's address and
the provider's authserv-id. A background extension named `email` holds one IMAP
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
