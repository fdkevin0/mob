# 66. One policy for large tool output

Date: 2026-10-11
Status: Accepted

Each tool cut its own output before the model saw it: sandbox commands kept
the first 16 KiB of stdout and of stderr, the Cloudflare tool the first 32 KiB
of its JSON, and email the first 24000 characters of a message. Each kept only
the beginning, where a build log or test run usually says least, and what was
cut was gone. Other agents keep the whole output and decide in one place how
much the model reads in place (see `research/limits-and-context-management.md`
and ADR 0065).

## Decision

- Tools return their whole result. Sandbox commands keep up to 1 MiB of each
  stream, and network reads keep their own size limits as a defence.
- The turn decides what the model reads. An output up to 24000 bytes of JSON,
  about 8000 tokens, is read whole, as before.
- A larger output is shown as its head (two thirds) and tail (one third),
  with its size and a note. With a sandbox, the whole output is first saved
  as readable text in the conversation's workspace under
  `/workspace/.mob/outputs/`, the preview shrinks to 4000 bytes, and the note
  tells the model to read the rest with the sandbox tool. Without one, the
  preview uses the whole 24000 bytes.
- The stored message keeps the whole output and where it was saved, so the
  interface shows it all and later turns read the same preview. Approved
  calls follow the same policy.

## Consequences

A long log costs the model a few thousand tokens instead of 16 KiB of its
start, and the model can still find an error in the middle with `grep`.
Stored messages can be larger, up to the sandbox's 1 MiB per stream. Saved
files stay in the workspace with the conversation's other files.

Counting the context from provider usage and clearing or compacting old tool
results are later steps.
