# Mob documentation

Documentation for the published AI core and Settings Mini App of Mob. For
setup, build commands and configuration, see the
[project README](../README.md).

## Start here

- [Architecture overview](architecture.md): request flow, module map, limits
  at a glance

## Features

Each guide follows the same layout: what the feature does, how it works,
usage, configuration, limits, design decisions, known limitations, and links
to the source.

| Guide | Covers |
| --- | --- |
| [Conversation agent](features/conversation-agent.md) | Per-chat Durable Object, serial turn queue, Session history and compaction, attachments |
| [Models](features/models.md) | DeepSeek through the AI SDK, reasoning effort, utility calls, output limits |
| [Telegram replies](features/telegram-replies.md) | Streaming Rich Messages, the multi-message transcript, tool status lines, outbound queue |
| [Tools](features/tools.md) | Built-in tool catalog, `fetch_url`, web search, weather, read tools, MCP servers |
| [Code execution and tool approval](features/code-execution.md) | Sandbox `run_code` / `run_shell`, daily budget, approval flow |
| [Memory](features/memory.md) | Working and Knowledge facts, extraction, auto-recall, `/forget` |
| [Scheduled turns](features/scheduled-turns.md) | One-off and recurring prompts, local-time cron |
| [Deep tasks](features/deep-tasks.md) | Background fibers with their own step and time budget |
| [Email triage](features/email-triage.md) | Classification schema, HTML conversion, notification buttons |
| [Settings Mini App](features/mini-app.md) | Hosting, `initData` authorization, screens, email preview |
| [Debug traces and usage](features/debugging-and-usage.md) | Admin JSON traces, token usage ledger |

## Architecture decisions

The [decision records](adr/README.md) explain *why* things are built the way
they are. The feature guides above describe the current state and summarize
the relevant decisions.

## Writing documentation

- **Feature guides** describe current behavior. Update the guide in the same
  change as the code. Take numbers from code constants, and link to the file
  that defines them.
- **Decision records** are historical. Don't rewrite an accepted record to
  match new behavior. Add a new record that supersedes it, and set the old
  one's status to `Superseded by ADR-NNNN`. Start from the
  [template](adr/template.md).
- Use relative links, and check that they resolve before committing.
