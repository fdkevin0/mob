# 68. Email as a channel

Date: 2026-10-11
Status: Accepted

The email plugin read, summarized and sent mail on request, and its tools let
the model do the same (ADR 0061), but no one could talk to Mob by mail the
way they do in Telegram and WeChat iLink (ADR 0064).

## Decision

- `email.Config.Channel` turns on answering mail. It names the owner's
  address and the provider's authserv-id. A background extension named
  `email` holds one IMAP connection, waits with IDLE (or polling where the
  server has none), and answers new INBOX mail through `channel.Bridge` as
  the email client, so commands, approvals, recorded deliveries and
  conclusion-only replies (ADR 0067) work as in the other channels.
- Mail is answered only when its one sender is the owner and the topmost
  `Authentication-Results` header with the configured authserv-id says the
  owner's domain passed DMARC, or signed it with DKIM. A `From` header alone
  is never trusted: anyone can write it. Mail marked as sent by a program
  (`Auto-Submitted`, `Precedence`, `List-Id`, an empty `Return-Path`) is not
  answered, and Mob's replies carry `Auto-Submitted: auto-replied`, so Mob
  never answers itself or another robot.
- A thread is a conversation: the key is the first of its `References`, or
  its `In-Reply-To`, or the message's own ID. Replies set `In-Reply-To` and
  `References` and keep the subject with `Re:`. Only what a reply adds is
  sent to the model: the text above the quoted message and the signature.
  A command is the first line.
- The cursor (UIDVALIDITY and the last UID handled) is saved per mailbox.
  The first run, or a new UIDVALIDITY, starts from the newest message, so
  old mail is never answered. Mail is read with `BODY.PEEK` and stays unread.

## Consequences

The channel depends on the provider stripping forged `Authentication-Results`
headers that claim its authserv-id; providers following RFC 8601 do. A wrong
authserv-id means no mail is answered rather than any mail being trusted.
Attachments are not read yet, and mail over 2 MiB is skipped.
