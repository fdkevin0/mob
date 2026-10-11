# 65. Limits follow the model, not fixed numbers

Date: 2026-10-11
Status: Accepted

Several limits predate the model catalog and ignore what the model can do. A
message over 16000 bytes (about 5300 Chinese characters) was refused, a reply
stopped at 8192 tokens even on models that write 64K or 128K, a turn ended
after five minutes whatever it was doing, and a model request ended after three
minutes even while its reply was still streaming. With up to 20 tool steps per
turn (ADR 0063), the five-minute deadline ends most long turns early. Current
agents bound the context window instead and leave single messages and replies
to the model (see `research/limits-and-context-management.md`).

## Decision

- A chat message has no length limit of its own. The chat request body is
  capped at 8 MiB only to stop runaway bodies, and neither the web composer nor
  the terminal input limits what is typed or pasted. The terminal's input
  component keeps at most 10000 lines, so a bracketed paste of 100 lines or
  more is held aside, shown as `[Pasted text #1 · N lines]`, and sent whole.
  A message that alone exceeds what the model's context leaves room for ends
  the turn with an error naming its size and the model, before any model
  request.
- A reply may use the model's output limit, up to 32000 tokens and at most a
  quarter of its context window. Without a known limit, the OpenAI-compatible
  driver lets the provider choose and the Anthropic driver asks for 32000;
  history still leaves room for a 32000-token reply. Anthropic thinking comes
  out of those reserved tokens, at most half of them, so `max_tokens` never
  exceeds what history was fitted around; a reply under 2048 tokens has no
  thinking, as Anthropic requires at least 1024.
- A turn has no deadline. It ends when it finishes, when it is stopped, or when
  it reaches the tool step limit; each model call and tool bounds its own wait.
- A model request fails with "model stopped responding" when its response does
  not start, or stops arriving, for two minutes. A reply that keeps arriving is
  never cut off.
- Tool call arguments may be up to 1 MiB, as they are model output already
  bounded by the reply size.

## Consequences

Long pastes, long replies and long tool-using turns work as the model allows.
A stuck provider still ends a turn after two minutes without data, and Stop
ends any turn. A long turn can now spend more tokens before the user notices;
the tool step limit and the per-message usage display remain the guards.

Context management (clearing old tool results, compaction) and one policy for
large tool output are later steps; the per-tool output caps stay until then.
