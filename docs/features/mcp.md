# MCP servers

Tools from outside Mob come from [Model Context Protocol](https://modelcontextprotocol.io)
servers. Each server runs in its own process; Mob never loads code into itself.

The optional [DeepSeek Harness bridge](deepseek-harness.md) uses this interface
to expose tools from DSH plugins.

## Configuration

`mcp_servers` in `config.yaml` lists servers by name:

- a `command` (with `args`, `env` and `dir`) that Mob starts and speaks to over
  stdin and stdout, or
- a Streamable HTTP `url` (with `headers`).

```yaml
mcp_servers:
  github:                       # tools appear as mcp__github__<tool>
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    env: [GITHUB_PERSONAL_ACCESS_TOKEN=...]
  docs:
    url: https://example.com/mcp
    headers:
      Authorization: Bearer ...
```

A server's `exposure` sets how its tools reach the model: `deferred`, the
default, until `tool_search` loads them; `direct`, declared to every turn; or
`hidden`. `tool_exposure` overrides it for tools whose names match a glob; an
exact name wins over a glob, and a longer glob over a shorter one:

```yaml
mcp_servers:
  github:
    command: npx
    args: [-y, "@modelcontextprotocol/server-github"]
    tool_exposure:
      search_*: direct
      delete_*: hidden
```

Keep `config.yaml` owner-only (`chmod 600`) when it holds keys. It reloads live;
a change reconnects the servers. Names use a-z, 0-9, `-` and single `_`, since
tool names carry them.

## Behaviour

- The `mcp` plugin keeps every server connected, reconnecting with growing
  pauses, and follows a server's changes to its tool list. It uses the official
  Go SDK, `github.com/modelcontextprotocol/go-sdk`.
- Each tool is `mcp__<server>__<tool>`, offered only to the owner's turns and
  only while its server is connected. A name with characters models refuse, or
  longer than 64, is cut and ends in a hash of the real name, so two tools never
  share one. Tools are added through `ToolRegistry.RegisterSource`, which allows
  tools that change while Mob runs.
- Tools wait until the model loads them with `tool_search`, which finds them by
  name, server, description and parameters; see
  [Exposure and tool_search](tools-and-approvals.md#exposure-and-tool_search).
  A conversation keeps the tools it has loaded or called.
- `/mcp` shows each server's status and tools, marking those that are direct or
  hidden.

## Trust

- Every MCP call asks for [approval](tools-and-approvals.md). The approval shows
  the server's command line or URL and records a fingerprint of its whole
  configuration, environment, directory and headers included. The call runs only
  while the fingerprint is unchanged. Always allowing a tool covers that tool on
  that configuration only, so a server switched to another account or program
  asks again.
- Configured headers go only to the server's own origin, and a redirect to
  another origin is refused.
- A command inherits Mob's environment without the `MOB_*` variables, such as
  the service token, plus its own `env`.
- A server started by Mob runs as the user, outside the sandbox, and can read
  what the user can, `providers.json` included. Configuring a server is
  trusting it, as installing a program is.

## Not supported

Resources, prompts and sampling.
