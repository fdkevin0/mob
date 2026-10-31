# Mob — local assistant

Mob is a personal AI assistant that runs on your own machine. One service keeps
conversations in SQLite and serves a desktop app, a browser UI, a terminal UI and
the `mob` CLI, and it can answer you in Telegram, WeChat and email. The model can
use tools (a container sandbox, your mailbox, Cloudflare, MCP servers), and
anything with an effect waits for your approval.

## Install

```bash
npm install -g usemob      # or: bun add -g --trust usemob
```

Nightly builds, archives, upgrading and building from source are in
[Install](docs/install.md).

## Use

```bash
mob tui                    # terminal UI; starts the service when needed
mob open                   # sign a browser in to the running service
mob open --web             # or sign in https://usemob.app to it
mob start / status / stop  # run the service in the background
mob serve --demo           # foreground, with an offline demo model
```

With no setup Mob answers with an offline demo model. Add a model provider
for real replies, such as OpenRouter for free models:

```bash
mob provider add openrouter --key-stdin
```

Then `/models` lists models and `/model NAME` switches the conversation. Type `/`
in the web UI or TUI to see and complete commands; `/help` lists them in
messaging apps.

In the TUI: Enter sends, Ctrl+J inserts a newline, F2 switches conversations,
F3 shows tool details, F4 reviews approvals, Ctrl+S stops the reply, PgUp/PgDn
scroll, Ctrl+Q exits. See the [terminal UI](apps/tui/README.md) for the rest.

## Documentation

The documentation is at https://usemob.app/docs; the pages below are its
sources. Start with the first line and go deeper as you need.

- **Set up**: [model providers](docs/features/providers.md),
  [configuration](docs/features/configuration.md) and the
  [desktop app](docs/features/desktop.md).
- **Work with it**: [tools and approvals](docs/features/tools-and-approvals.md),
  the [sandbox](docs/features/sandbox.md) and
  [schedules](docs/features/schedules.md).
- **Hand off coding**: [coding agents](docs/features/coding-agents.md) and
  [plans](docs/features/plans.md).
- **Connect it**: [Telegram, WeChat and email](docs/features/channels.md),
  [MCP servers](docs/features/mcp.md), [skills](docs/features/skills.md) and
  [remote access](docs/features/remote-access.md).
- **Everything else**: [all features](docs/features/README.md),
  [configuration keys](docs/environment-variables.md) and
  [contributing](CONTRIBUTING.md).

## License

[MIT](LICENSE). AI Elements sources keep
[their Apache-2.0 license](packages/app/src/ai-elements/SOURCE.md).
