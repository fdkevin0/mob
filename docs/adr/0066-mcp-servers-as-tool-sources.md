# 66. MCP servers as tool sources

Date: 2026-10-11
Status: Accepted

After ADR 0058–0064 every capability Mob offers the model is compiled in. The
extension plan chose the Model Context Protocol, rather than loading code into
Mob, as the way to add tools from outside: MCP servers already exist for most
services, and a server runs in its own process. This is step six of that plan.

## Decision

- `mcp_servers` in `config.yaml` lists servers by name: a `command` (with
  `args`, `env` and `dir`) that Mob starts and speaks to over stdin and
  stdout, or a Streamable HTTP `url` (with `headers`). The file is owner-only
  and already reloads live; a change reconnects the servers. Names use a-z,
  0-9, `-` and single `_`, since tool names carry them.
- The `mcp` plugin keeps every server connected, reconnecting with growing
  pauses, and follows a server's changes to its tool list. It uses the
  official Go SDK, `github.com/modelcontextprotocol/go-sdk`.
- `ToolRegistry.RegisterSource` adds tools that change while Mob runs. Each
  MCP tool is `mcp__<server>__<tool>`, offered only to the owner's turns and
  only while its server is connected.
- Every MCP call asks for approval. The approval records the server's command
  line or URL, and the call runs only against that same target. Always
  allowing a tool covers it on that target only, so a server renamed or
  reconfigured asks again.
- A command inherits Mob's environment without the `MOB_*` variables, such
  as the service token, plus its own `env`.
- `/mcp` shows each server's status and tools.

## Consequences

A server started by Mob runs as the user, outside the sandbox, and can read
what the user can, `providers.json` included. Configuring a server is
trusting it, as installing a program is. Mob only withholds its own token,
and gives the model nothing from a server without the owner's approval.
Server results reach the model as text, at most 32 KiB per call. Resources,
prompts and sampling are not supported yet.
