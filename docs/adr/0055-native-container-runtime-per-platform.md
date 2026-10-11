# 55. A native container runtime per platform

Date: 2026-10-11
Status: Accepted

Mob needs somewhere to run untrusted or heavyweight work, such as model-authored
code, away from the user's files. The retired Worker used a Cloudflare Sandbox
(ADR 0019); the local runtime had nothing. Docker Desktop is the common answer
but is a separate product with its own licence and VM. Each platform now ships,
or has a first-party, container runtime of its own.

## Decision

- `internal/container` runs OCI images through the platform's native runtime:
  **containerd** on Linux, Apple's [container](https://github.com/apple/container)
  on macOS and **WSL containers** (`wslc`) on Windows. `container.Default(GOOS)`
  picks it; `container_runtime` in config.yaml (`MOB_CONTAINER_RUNTIME`,
  `--container-runtime`) may name `containerd`, `apple` or `wslc` instead.
- Each runtime is driven through its CLI rather than a client library: `nerdctl`
  for containerd (in its own `mob` namespace), `container` on macOS and `wslc` on
  Windows. The three share Docker's `run` flags, so one argument builder serves
  them, Mob gains no dependencies or build tags, and one binary per OS still
  cross-compiles with `CGO_ENABLED=0`. A `Runner` seam lets tests run without any
  runtime installed.
- The interface is deliberately small: `Check` (is the CLI present and its
  service running), `Pull`, and `Exec`/`Stream` of a `Spec` — image, command,
  `KEY=VALUE` environment, bind mounts, working directory and optional stdin.
  Containers are always `--rm`. A nonzero exit is a result, not an error.
- `mob container status|pull|run` exposes the runtime directly so a user can
  confirm it works before anything depends on it.

## Consequences

- Network isolation and CPU/memory limits are not in `Spec` yet: the three CLIs
  do not document the same flags for them, and a limit that silently does
  nothing on one platform is worse than none. Add them per runtime when a caller
  needs them.
- containerd needs `nerdctl` and CNI plugins installed beside it; plain `ctr`
  is not supported. Apple's runtime needs macOS 26 on Apple silicon and
  `container system start`. `wslc` needs a WSL release that includes it.
  `Check` reports which is missing.
- No chat tool uses the runtime yet. A code or shell tool built on it must go
  through tool approval (ADR 0039's rule carries over) before it runs anything.
