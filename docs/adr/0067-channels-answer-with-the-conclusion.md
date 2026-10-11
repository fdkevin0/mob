# 67. Channels answer with the turn's conclusion

Date: 2026-10-11
Status: Accepted

A channel reply (ADR 0064) was every piece of text a turn wrote. A turn that
called tools wrote a line before each call ("Let me check…"), and Telegram
and WeChat iLink joined those lines to the answer with no break, so a long
piece of work read as a running commentary. Agents that answer in messaging
apps and issue trackers (Devin, Cursor and Codex background agents, Claude
Code's GitHub and Slack integrations) send a conclusion, a little progress and
the decisions they need, and keep the full transcript elsewhere.

## Decision

- `channel.Bridge` replies with the text of the turn's last step that wrote
  any, which concludes the turn. Text written between tool calls, reasoning
  and tool calls stay in the local conversation.
- `channel.Texts.Used`, when set, adds one line naming the tools the turn
  called and how often, so the sender knows work happened and where to read
  it. Telegram says it in English and WeChat iLink in Chinese.
- A channel's turn sets `chat.ChatRequest.Channel`, and the model is told
  that the reader sees only its last text, so it ends with an answer that
  stands on its own. Failures and approval requests are still added after
  the conclusion.
- No second model call writes a summary: the concluding step already is one,
  and another call would cost tokens and time and could misreport the work.

## Consequences

A turn whose last step writes nothing falls back to the last text written
before it, such as the line before a tool call that asked for approval. The
web UI and TUI are unchanged; they show the whole turn.
