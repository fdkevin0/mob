# Environment variables and configuration

Generated from apps/mob/src/config.ts; run bun run --cwd apps/mob configdocs.

Explicit CLI flags > nonempty MOB_ environment variables > configuration file > defaults.
Empty environment values are ignored consistently; use a flag or file value to clear a string.
There is no .env loader. Restart after changing the process environment.

Keys map to flags by replacing dots/underscores with hyphens, and to environment
variables by replacing dots with underscores, uppercasing and prefixing MOB_.
The config selector chooses the file before loading it and cannot appear inside that file.
The file is YAML (config.yaml) or JSON (config.json).

| File key | CLI flag | Environment | Default | Purpose |
| --- | --- | --- | --- | --- |
| `config` | `--config` | `MOB_CONFIG` | `XDG config home/mob/config.yaml` | Configuration file path (selector only; not a file field) |
| `data_dir` | `--data-dir` | `MOB_DATA_DIR` | `XDG data home/mob (existing legacy database reused)` | SQLite, token and conversation workspaces; restart required |
| `state_dir` | `--state-dir` | `MOB_STATE_DIR` | `XDG state home/mob` | Background logs; restart required |
| `addr` | `--addr` | `MOB_ADDR` | `127.0.0.1:8787` | Local service loopback IP and port; restart required |
| `demo` | `--demo` | `MOB_DEMO` | `false` | Use offline model simulation; restart required |
| `max_tool_steps` | `--max-tool-steps` | `MOB_MAX_TOOL_STEPS` | `20` | Model calls per turn (1-100) |
| `web_url` | `--web-url` | `MOB_WEB_URL` | `https://usemob.app` | Public web UI URL; an empty flag or file value disables it |
| `token` | `--token` | `MOB_TOKEN` | `""` | Local access token (at least 32 bytes); empty uses the managed token file; restart required; sensitive: prefer a protected file or environment over argv |
| `sandbox.enabled` | `--sandbox-enabled` | `MOB_SANDBOX_ENABLED` | `false` | Expose the container sandbox tool |
| `sandbox.runtime` | `--sandbox-runtime` | `MOB_SANDBOX_RUNTIME` | `""` | Container runtime: containerd, apple or wslc; empty selects by platform |
| `sandbox.image` | `--sandbox-image` | `MOB_SANDBOX_IMAGE` | `python:3.13-slim` | Container image for commands |
| `sandbox.network` | `--sandbox-network` | `MOB_SANDBOX_NETWORK` | `""` | Container network; none disables it, empty uses runtime default |
| `sandbox.cpus` | `--sandbox-cpus` | `MOB_SANDBOX_CPUS` | `0` | Nonnegative CPU limit; zero uses runtime default |
| `sandbox.memory` | `--sandbox-memory` | `MOB_SANDBOX_MEMORY` | `""` | Memory limit with unit, at least 64m; empty uses runtime default |
| `sandbox.pids` | `--sandbox-pids` | `MOB_SANDBOX_PIDS` | `0` | Nonnegative process limit, containerd only; zero uses runtime default |
| `sandbox.user` | `--sandbox-user` | `MOB_SANDBOX_USER` | `""` | UID[:GID] or name commands run as; empty uses the image's user |
| `sandbox.isolation` | `--sandbox-isolation` | `MOB_SANDBOX_ISOLATION` | `""` | gvisor requires containerd; empty uses runtime default |
| `mcp_servers` | `--mcp-servers` | `MOB_MCP_SERVERS` | `{}` | MCP server map; JSON object in flags/environment, native map in files; sensitive: prefer a protected file or environment over argv |
| `mcp_registry.url` | `--mcp-registry-url` | `MOB_MCP_REGISTRY_URL` | `https://registry.modelcontextprotocol.io` | MCP registry the model searches for remote servers to install |
| `mcp_registry.namespaces` | `--mcp-registry-namespaces` | `MOB_MCP_REGISTRY_NAMESPACES` | `""` | Comma-separated registry name globs, such as com.cloudflare.mcp/*, the model may install from; empty offers only Mob's own list |

This reference covers runtime configuration. Provider keys and plugin settings
use their own stores; command actions such as open --print are not settings.
XDG_* directory conventions and CI/build variables belong to their respective tools.

See [Configuration](features/configuration.md) for file safety, reload behavior
and migration; [Sandbox](features/sandbox.md) and [MCP](features/mcp.md) describe
their execution and environment boundaries.
