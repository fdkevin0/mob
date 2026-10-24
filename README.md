# Mob — local assistant

Mob is a personal AI assistant that runs on your own machine. One service keeps
conversations in SQLite and serves a desktop app, a browser UI, a terminal UI and
the `mob` CLI, and it can answer you in Telegram, WeChat and email. The model can
use tools (a container sandbox, your mailbox, Cloudflare, MCP servers), and
anything with an effect waits for your approval.

## Install

Download an archive for Linux, macOS or Windows from the
[releases page](https://github.com/fdkevin0/mob/releases). Every change to `main`
is published there as a nightly prerelease named `{date}.{sha}`. To build from
source, see [CONTRIBUTING.md](CONTRIBUTING.md).

Stable `vX.Y.Z` releases and `brew install fdkevin0/tap/mob` start with the first
stable release; none is published yet.

## Use

```bash
mob tui                    # terminal UI; starts the service when needed
mob open                   # sign a browser in to the running service
mob open --web             # or sign in https://usemob.app to it
mob start / status / stop  # run the service in the background
mob serve --demo           # foreground, with an offline demo model
```

With no setup Mob uses a free model (OpenCode Zen). To use your own:

```bash
mob provider add deepseek --key-stdin
```

Then `/models` lists models and `/model NAME` switches the conversation. Type `/`
in the web UI or TUI to see and complete commands; `/help` lists them in
messaging apps.

In the TUI: Enter sends, Ctrl+J inserts a newline, F2 switches conversations,
F3 shows tool details, F4 reviews approvals, Ctrl+S stops the reply, PgUp/PgDn
scroll, Ctrl+Q exits. See the [terminal UI](apps/tui/README.md) for the rest.

## Documentation

The documentation is at https://usemob.app/docs; the pages below are its
sources.

- [Model providers](docs/features/providers.md)
- [Configuration and running the service](docs/features/configuration.md)
- [Tools and approvals](docs/features/tools-and-approvals.md)
- [Sandbox](docs/features/sandbox.md)
- [Messaging channels](docs/features/channels.md): Telegram, WeChat iLink, email
- [Plugins: email and Cloudflare](docs/features/plugins.md)
- [MCP servers](docs/features/mcp.md)
- [All feature pages](docs/features/README.md) and [architecture](docs/architecture.md)

## License

[MIT](LICENSE). AI Elements sources keep
[their Apache-2.0 license](webapp/src/components/ai-elements/SOURCE.md).
