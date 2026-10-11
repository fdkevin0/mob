# 64. Messaging channels share a bridge

Date: 2026-10-11
Status: Accepted

After ADR 0062 Telegram and WeChat iLink were plugins, but each answered
messages its own way. Telegram ran the command registry and recorded each
delivery so a restart never answered or sent a message twice; WeChat iLink
recognised only its approval words, sent its replies without recording them,
dropped a reply whenever the turn failed, and passed the model's reasoning to
the sender along with its answer. This is step five of the extension
architecture after ADR 0058–0062.

## Decision

- `channel.Bridge` is what a messaging app's plugin answers with. `Answer`
  runs a message as a command in the app's client or as a turn in the
  sender's conversation, carries out the actions commands return (open a
  conversation, decide an approval), and keeps only what the sender should
  read: the turn's text, its failures and the approvals it asks for.
  `Deliver` records each message under its ID in the deliveries table, so a
  message is answered and sent at most once and an interrupted send is
  reported, not repeated.
- `channel.Texts` is what a channel says in its own words: the help
  greeting, the approval prompt, the line before a decision's reply, and the
  answers for stale approvals, failures and empty turns. Telegram speaks
  English and WeChat iLink Chinese, as before.
- A plugin keeps its transport and who is writing: Telegram answers only its
  owner and offers buttons for approvals; WeChat iLink refuses senders not on
  its allowlist, treats only its first allowed user as the owner, and reads
  批准 and 拒绝 as `/approve` and `/deny`.
- The approval and conversation commands (`/new`, `/approve`, `/deny`,
  `/grants`, `/revoke`) and `/help` are offered to WeChat iLink as well.

There is no channel registry: a channel registers like any plugin, with an
extension for its background run.

## Consequences

WeChat iLink messages appear in `/deliveries` under `wx:<bot>:<message>`, and
a failed turn now answers the sender with what went wrong. A request the
sender may not make, such as a guest remembering an approval, is answered
rather than counted as a failure. A later email channel, or a summary of a turn in place of its full
text, goes through the same bridge: the first is another plugin calling
`Deliver`, the second a change to what `Answer` collects.
