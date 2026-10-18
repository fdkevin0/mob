# DeepSeek Harness plugins

Mob can run tools from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(DSH) plugins through the optional `apps/dsh` bridge. The bridge uses the official
Cordis, system-prompt and tool runtimes, and exposes their tools over
[MCP](mcp.md). Mob still owns the conversation and model loop.

## Try it

Use a Mob source checkout with the Bun version in `package.json`, then run
`bun install --frozen-lockfile` in the repository root. The bridge runs from
source; it is not embedded in the Go release binary.

Add this to Mob's `config.yaml`, replacing `/path/to/mob` with the absolute
checkout path:

```yaml
mcp_servers:
  dsh:
    command: bun
    args:
      - /path/to/mob/apps/dsh/src/main.ts
      - /path/to/mob/apps/dsh/examples/plugins.json
```

`/mcp` shows the connection and `mcp__dsh__greet`. With a model that calls tools,
ask it to greet Ada using that tool, then approve the call. The result is
`Hello, Ada!`. No DeepSeek API key is needed by the bridge itself.

## Load plugins

The second command argument is a JSON file listing plugin modules and their
configuration:

```json
[
  { "module": "./greet.ts", "config": { "greeting": "Hello" } },
  { "module": "installed-dsh-tool-package", "config": {} }
]
```

Replace the package name with a plugin you have installed. Module paths resolve
beside this JSON file; absolute paths work too. Package names resolve through
that directory's `node_modules` ancestry. Install a package with `bun add` in
the project that owns the configuration file, after checking its required DSH
versions. Local plugins also need their imports to resolve from their own
directory. The included example lives inside the bridge workspace for that
reason.

Each entry accepts only `module` and optional `config`. An omitted config is
passed to Cordis for its normal defaults. Function, named `apply`, default
object and service-class plugins use Cordis's own plugin API and configuration
validation. All entries are mounted before required services are checked, so a
provider can appear after its consumer. A top-level plugin that cannot activate
fails startup; `/mcp` reports the connection failure and Mob retries it. Run the
bridge command directly to read startup diagnostics on stderr.

The bridge does not install packages or interpret DSH bundle manifests and
`cordis.yml` patches. List the individual plugin modules and any service
providers they need in this file. To disable a plugin, remove its entry and
restart the bridge by restarting Mob. Changing an MCP server's command, args,
environment or directory also reconnects it through normal config reload.
Plugin files and this JSON file are not watched.

## Execution and lifecycle

- Tools run through DSH's tool runtime, including parameter/output validation
  and execution hooks. Tool additions and removals send MCP tool-list change
  notifications. Mob's next tool listing reflects them.
- Calls are owner-only and use the existing MCP approval flow. DSH policies
  can additionally deny a call. A DSH `ask` decision without an installed DSH
  approval service is denied; it cannot bypass Mob's approval.
- Cancellation reaches the tool's `AbortSignal`. When stdin closes or the
  process receives SIGINT/SIGTERM, the bridge cancels active calls, waits for
  them and disposes the Cordis context. Cordis removes registered effects,
  tools and event listeners. A plugin that does not finish shutdown within
  five seconds causes the process to exit with an error.
- Console logging goes to stderr, keeping stdout for MCP messages. Plugins
  that write directly to stdout are not compatible with this transport.
- The bridge is trusted host code, with the same filesystem and environment
  access as an [MCP command server](mcp.md#trust). Approval gates tool calls,
  not plugin import, setup or background effects. Remembered approvals track
  MCP configuration, not the contents of plugin files; clear remembered grants
  when changing code or config behind the same command.

## Compatibility boundary

The pinned baseline is DSH `0.2.1-rc.2` and Cordis `4.0.5`. Tests use the actual
published runtimes and a plugin built with DSH's `defineTool`, including a real
Go MCP connection. This is tool compatibility, not a claim that every community
plugin works.

The bridge supplies `tools` and `systemPrompt`; additional service plugins can
be listed explicitly. It does not supply a DSH agent/session, model loop,
frontend, plugin marketplace, automatic package upgrades or a DSH approval UI.
Plugins depending on those services need a different integration. System-prompt
sections registered in DSH are not added to Mob's prompt. Agent-loop directives
(`deferContext`, `concludeTurn`) return an explicit unsupported-result error
after execution, since Mob cannot apply them.

Text results are forwarded as text, and canonical values as MCP structured
content. Other DSH content blocks, including attachment references, are rendered
as JSON text; the bridge does not fetch their files or render DSH UI cards.

Mob's native Go plugin dependency and hook APIs are described separately in
[Extensions](extensions.md).
