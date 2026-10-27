# MCP servers

Tools from outside Mob come from [Model Context Protocol](https://modelcontextprotocol.io)
servers. Each server runs in its own process; Mob never loads code into itself.

The optional [DeepSeek Harness bridge](deepseek-harness.md) uses this interface
to expose tools from DSH plugins.

## Configuration

`mcp_servers` in `config.yaml` lists servers by name:

- a `command` (with `args`, `env` and `dir`) that Mob starts and speaks to over
  stdin and stdout, or
- a Streamable HTTP `url` (with `headers`, or `oauth: true` to sign in).

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
  cloudflare:
    url: https://mcp.cloudflare.com/mcp
    oauth: true
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

## Signing in with OAuth

With `oauth: true`, a server that refuses Mob's request (401) starts an OAuth
sign-in, following the MCP authorization specification through the official
SDK:

- Mob finds the server's authorization server, registers itself there by
  dynamic client registration, and asks for an authorization code with PKCE.
- The server's status, shown by `/mcp`, becomes `sign in to connect: <link>`.
  The authorization server sends the browser back to a loopback address that
  Mob listens on only while it waits, for at most 10 minutes. In a browser on
  the computer Mob runs on, that finishes the sign-in.
- In a browser elsewhere, such as a phone, the loopback address does not open.
  Copy the address the browser shows and send `/signin ADDRESS` from any client
  or channel the owner uses: Mob matches it to the waiting sign-in by its
  address, takes the code from it, and the SDK checks its state as it would
  the browser's. `/mcp` and an install's result say this beside the link.
- Mob keeps the client and token in its database and refreshes the token, so
  a restart does not sign in again. A sign-in belongs to the server's name and
  URL; changing the URL signs in again. Approvals do not record which account
  signed in.
- `oauth` cannot be combined with an `Authorization` header.

## Behaviour

- The `mcp` plugin keeps every server connected, reconnecting with growing
  pauses, and follows a server's changes to its tool list. It uses the official
  TypeScript SDK, `@modelcontextprotocol/sdk`.
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

## Installing from the catalog

The model can find remote servers that are not set up yet and ask the owner to
install them. Only remote servers are offered: nothing the model picks runs on
this machine.

- The catalog is Mob's own list, which holds Cloudflare's API, documentation,
  Browser Rendering and Radar servers, and, when `mcp_registry.namespaces` is
  set, the servers of an [MCP registry](https://registry.modelcontextprotocol.io)
  whose names match one of its comma-separated globs:

  ```yaml
  mcp_registry:
    url: https://registry.modelcontextprotocol.io   # the default
    namespaces: "com.cloudflare.mcp/*, io.github.example/*"
  ```

  Without namespaces Mob asks no registry. With them, it reads the latest
  version of each matching server in the background, at most once a day or
  when the setting changes, and keeps what it found in the `mcp_catalog`
  setting. A failed read keeps the last list and is not retried for an hour.
  Only active servers are listed,
  one entry for each Streamable HTTP endpoint served over https. The registry
  checks only who owns a name, so keep the namespaces to publishers you trust.
- Servers that are configured or installed already are left out. `tool_search`
  finds the rest, as entries of kind `MCP server`, in the owner's turns.
- `tool_install` takes a listed URL and asks the owner to approve installing it,
  and checks again on approval that the catalog still lists it.
  The approval shows the name the server's tools will carry, the registry name,
  version, URL, repository and where the listing came from. A server whose
  listing requires a header is not installed: its entry tells the model that
  the owner adds it to `config.yaml`.
- An approved server is kept in the `mcp_installed` setting, never in
  `config.yaml`, and joins the configured servers with `oauth: true` under a name
  made from its URL (`cloudflare-docs` for `docs.mcp.cloudflare.com`). When
  `config.yaml` later lists the same name or URL, the configured server is used
  instead. Mob reconnects, and the call returns within a few seconds with the
  server's tools or the sign-in link for the owner; an install that is kept but
  fails to reconnect says so.
- `/mcp` marks installed servers and names installs `config.yaml` shadows.
  `/mcp remove NAME` forgets an installed server and its sign-in; a shadowed
  install's name keeps the configured server's sign-in.

## Web management

**Plugins & cloud services → MCP** has **Installed** and **Discover** views.
Installed servers show their connection status, tool descriptions and exposure,
and whether they are managed by `config.yaml` or were installed from the catalog.
Configuration credentials are not returned in the overview.

Discover uses the same catalog and namespace restrictions as `tool_install`.
Reviewing and confirming a server installs it directly as the owner's action;
it does not need a model turn or grant permission to call its tools. Both Web
and model installs validate catalog membership and name conflicts at installation
time. Servers requiring headers still need configuration in `config.yaml`.

Installation and connection are separate: a saved server can still be connecting,
need sign-in, or fail to connect. The page refreshes its status while visible.
For OAuth, open **Sign in to connect**; on another device, paste the final
loopback address into **Finish sign-in from another device** if it cannot open.
Removing an installation uses the same behavior as `/mcp remove`; a configured
server that shadows it remains configured. Configured servers cannot be deleted
from this page.

Operations run on the connected Mob service, not necessarily on the browser's
computer. The browser-only runner does not offer this management interface.

## Trust

- Every MCP call asks for [approval](tools-and-approvals.md). The approval shows
  the server's command line or URL and records a fingerprint of its whole
  configuration, environment, directory, headers and `oauth` included. The call runs only
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
- Installing from the catalog adds only URL servers, after the owner approves,
  and their calls ask for approval like any other.

## Not supported

Resources, prompts and sampling.

## Web management

**Manage Mob → MCP servers** shows connection status and tool names without
returning server connection credentials. Installed servers can be removed after
confirmation; servers configured in `config.yaml` stay managed there, including
those that override an earlier install. A pending
sign-in offers its browser link. When signing in from another device, paste the
callback address into **Sign-in callback address** to finish the existing
`/signin` flow. Refresh checks the latest connection status.
