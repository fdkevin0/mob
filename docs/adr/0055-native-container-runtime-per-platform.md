# 55. A container sandbox on each platform's native runtime

Date: 2026-10-11
Status: Accepted

Mob's model could only read the time and ask to remember facts. Letting it run
commands on the host would make every call a security decision, and asking for
approval each time makes it useless for real work. The retired Worker ran code
in a Cloudflare Sandbox (ADR 0019); the local runtime had nothing. Docker
Desktop is the common answer but is a separate product with its own licence and
VM, while each platform now has a first-party container runtime of its own.

## Decision

- **The sandbox is the boundary.** With `sandbox.enabled`, the model gets a
  `sandbox` tool that runs any shell command (`sh -c`) in a fresh container,
  without approval: inside it, anything goes, including package installs and
  network access. The only host path it sees is the conversation's workspace,
  `data_dir/sandbox/<conversation ID>`, mounted at `/workspace` and kept between
  calls; everything else in the container is discarded when the command exits.
  No host environment variables are passed in.
- **Configuration.** One section, reloaded live:

  ```yaml
  sandbox:
    enabled: true
    runtime: ""                # containerd, apple or wslc; empty: the platform's own
    image: python:3.13-slim
  ```

  `MOB_SANDBOX_ENABLED`, `MOB_SANDBOX_RUNTIME` and `MOB_SANDBOX_IMAGE` override it.
  Disabling it withdraws the tool from later turns.
- **Runtimes.** `internal/container` drives the platform's runtime through its
  CLI: containerd through `nerdctl` (in its own `mob` namespace) on Linux, Apple's
  [container](https://github.com/apple/container) on macOS and WSL containers
  (`wslc`) on Windows. The three share Docker's `run` flags, so one argument
  builder serves them, Mob gains no dependencies or build tags, and one binary
  per OS still cross-compiles with `CGO_ENABLED=0`. A `Runner` seam lets tests
  run without any runtime installed.
- **Bounds.** A command runs for 2 minutes by default, at most 5 and never past
  its turn. On timeout or cancellation the named container is force-removed,
  since interrupting a CLI does not always stop what it started. Stdout and
  stderr are each cut at 16 KiB. A nonzero exit is a result the model reads, not
  a failure. The image is pulled on first use; a failed pull does not block a
  run while the runtime answers, so a local image still works offline.
- `mob container status|pull|run` uses the same runtime directly, so a user can
  confirm it works before enabling the sandbox.

## Consequences

- The isolation is the runtime's: a container on Linux shares the host kernel,
  and with rootful containerd a container escape is root on the host. Apple's
  runtime and `wslc` put each container or session in a VM. Prefer rootless
  containerd on Linux.
- Network access and CPU/memory limits are not restricted: the three CLIs do not
  document the same flags, and a limit that silently does nothing on one
  platform is worse than none. Commands can therefore reach the internet and the
  host's network services; a workspace can hold whatever the model downloads.
- Files the container writes into the workspace may be owned by its user (often
  root) on Linux hosts.
- containerd needs `nerdctl` and CNI plugins beside it; plain `ctr` is not
  supported. Apple's runtime needs macOS 26 on Apple silicon and
  `container system start`; `wslc` needs a WSL release that includes it. When
  the runtime is not ready the service logs it and the tool returns the reason.
