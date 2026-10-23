# Features

Each page describes how one part of Mob behaves today and where it lives in the
code. When a change alters that behaviour, update the page in the same pull
request. Design discussion happens in issues and pull requests; Mob does not
keep architecture decision records.

| Page | Covers |
| --- | --- |
| [Configuration](configuration.md) | files, environment, live reload, who owns the service, access tokens |
| [Model providers](providers.md) | `providers.json`, presets, the model catalog, `/model` per conversation |
| [Turns and context](turns-and-context.md) | turns that outlive their request, limits, context counting, large tool output |
| [Tools and approvals](tools-and-approvals.md) | built-in and plugin tools, approvals, remembered grants |
| [Sandbox](sandbox.md) | the container sandbox, its limits and gVisor |
| [Slash commands](commands.md) | the command registry, help and completion |
| [Messaging channels](channels.md) | Telegram, WeChat iLink and email, and their shared bridge |
| [Plugins](plugins.md) | plugin settings and secrets, the email mailbox, Cloudflare |
| [MCP servers](mcp.md) | external tools over the Model Context Protocol |
| [DeepSeek Harness plugins](deepseek-harness.md) | DSH tool compatibility, the optional runtime, setup and limitations |
| [Coding agents](coding-agents.md) | projects and tasks handed to Codex and other ACP agents, with Mob as project manager |
| [Schedules](schedules.md) | prompts the model runs on its own later, once or repeatedly |
| [Skills](skills.md) | Agent Skills the model loads by name, and running their scripts in the sandbox |
| [Extensions](extensions.md) | how plugins add tools, hooks, commands, routes, configuration and background runs |
| [Desktop app](desktop.md) | the Electron window, tray and packaging |
| [Releases and upgrades](releases.md) | nightly and stable channels, database migration windows |
| [Remote access](remote-access.md) | the public site (landing page, GitHub sign-in, web UI) and encrypted remote runners |

The retired Cloudflare Worker and Telegram Mini App, and the decision records
written for them, are kept at the `legacy-worker` tag.
