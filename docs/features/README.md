# Features

Each page describes how one part of Mob behaves today and where it lives in the
code. When a change alters that behaviour, update the page in the same pull
request. Design discussion happens in issues and pull requests; Mob does not
keep architecture decision records.

| Page | Covers |
| --- | --- |
| [Model providers](providers.md) | `providers.json`, presets, the model catalog, `/model` per conversation |
| [Turns and context](turns-and-context.md) | turns that outlive their request, limits, context counting, large tool output |
| [Tools and approvals](tools-and-approvals.md) | built-in and plugin tools, approvals, remembered grants |
| [Sandbox](sandbox.md) | the container sandbox, its limits and gVisor |
| [Slash commands](commands.md) | the command registry, help and completion |
| [Messaging channels](channels.md) | Telegram, WeChat iLink and email, and their shared bridge |
| [MCP servers](mcp.md) | external tools over the Model Context Protocol |
| [Extensions](extensions.md) | how plugins add tools, hooks, commands, routes, configuration and background runs |
| [Releases and upgrades](releases.md) | nightly and stable channels, database migration windows |
| [Remote access](remote-access.md) | the experimental gateway and edge nodes |

The retired Cloudflare Worker and Telegram Mini App, and the decision records
written for them, are kept at the `legacy-worker` tag.
