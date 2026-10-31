# Features

Each page describes how one part of Mob behaves today. Pages open with what
the feature does and how to use it; how it works and where it lives in the
code come further down. When a change alters that behaviour, update the page
in the same pull request. Design discussion happens in issues and pull
requests; Mob does not keep architecture decision records.

## Use Mob

| Page | Covers |
| --- | --- |
| [Model providers](providers.md) | adding a provider, `/model` per conversation, `providers.json`, presets and the model catalog |
| [Configuration](configuration.md) | files, environment, live reload, who owns the service, access tokens |
| [Turns and context](turns-and-context.md) | replies that outlive their tab, limits, context counting and summaries, token usage |
| [Tools and approvals](tools-and-approvals.md) | built-in and plugin tools, approvals, remembered grants |
| [Sandbox](sandbox.md) | the container sandbox, its limits and gVisor |
| [Slash commands](commands.md) | the command registry, help and completion |
| [Schedules](schedules.md) | prompts the model runs on its own later, once or repeatedly |
| [Desktop app](desktop.md) | the Electron window, tray and packaging |

## Hand work to coding agents

| Page | Covers |
| --- | --- |
| [Coding agents](coding-agents.md) | getting started, the agents, projects and tasks, the Agents page, approvals and notices |
| [Task workflow](task-workflow.md) | blueprints, automatic checks and reviews, sub-tasks, read-only reviewers, results |
| [Plans](plans.md) | several tasks approved at once, drawn as a flow you can review and change |

## Connect and extend

| Page | Covers |
| --- | --- |
| [Messaging channels](channels.md) | Telegram, WeChat iLink and email, and their shared bridge |
| [Plugins](plugins.md) | plugin settings and secrets, the email mailbox, Cloudflare |
| [MCP servers](mcp.md) | external tools over the Model Context Protocol |
| [Skills](skills.md) | Agent Skills the model loads by name, and running their scripts in the sandbox |
| [DeepSeek Harness plugins](deepseek-harness.md) | DSH tool compatibility, the optional runtime, setup and limitations |
| [Extensions](extensions.md) | how plugins add tools, hooks, commands, routes, configuration and background runs |

## Reach Mob from elsewhere

| Page | Covers |
| --- | --- |
| [Remote access](remote-access.md) | which way to pick, the web app at usemob.app, pairing with local Mob, encrypted runners |
| [Mob in the browser](browser-runner.md) | Mob running in the tab with no runner, its models and moving conversations |
| [Runners in the cloud](cloud-runners.md) | a runner at Render that stays on without your computer |

## Releases

| Page | Covers |
| --- | --- |
| [Releases and upgrades](releases.md) | nightly and stable channels, database migration windows |

The retired Cloudflare Worker and Telegram Mini App, and the decision records
written for them, are kept at the `legacy-worker` tag.
