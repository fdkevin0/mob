# Sandbox

With the sandbox enabled, the model gets a `sandbox` tool that runs any shell
command (`sh -c`) in a fresh container, without approval. The container is the
security boundary: inside it anything goes, including package installs and,
unless limited, network access.

## Workspace

The only host path a container sees is the conversation's workspace,
`data_dir/sandbox/<conversation ID>`, mounted at `/workspace` and kept between
calls. Everything else in the container is discarded when the command exits. No
host environment variables are passed in. Files the container writes may be
owned by its user (often root) on Linux hosts.

## Configuration

One section, reloaded live. Disabling it withdraws the tool from later turns.

```yaml
sandbox:
  enabled: true
  runtime: ""           # containerd, apple or wslc; empty: the platform's own
  image: python:3.13-slim
  network: none         # empty: the runtime's default network
  cpus: 2               # whole CPUs per command; 0: the runtime's default
  memory: 1g            # at least 64m; empty: the runtime's default
  isolation: gvisor     # Linux with containerd only; empty: the runtime's own
```

`MOB_SANDBOX_ENABLED`, `MOB_SANDBOX_RUNTIME`, `MOB_SANDBOX_IMAGE`,
`MOB_SANDBOX_NETWORK`, `MOB_SANDBOX_CPUS`, `MOB_SANDBOX_MEMORY` and
`MOB_SANDBOX_ISOLATION` override it.

## Runtimes

`apps/mob/src/sandbox/container.ts` drives each platform's own runtime through
its CLI, so Mob needs no Docker Desktop and gains no native dependencies:

| Platform | Runtime | Isolation |
| --- | --- | --- |
| Linux | containerd through `nerdctl`, in its own `mob` namespace | shares the host kernel; with rootful containerd an escape is root. Prefer rootless, or gVisor |
| macOS | Apple's [container](https://github.com/apple/container) | a VM per container |
| Windows | WSL containers (`wslc`) | a VM per session |

The three share Docker's `run` flags, so one argument builder serves them. A
`Runner` seam lets tests run without any runtime installed.

Requirements: containerd needs `nerdctl` and CNI plugins beside it (plain `ctr`
is not supported). Apple's runtime needs macOS 26 on Apple silicon and
`container system start`. `wslc` needs a WSL release that includes it. When the
runtime is not ready the service logs it and the tool returns the reason.

## Bounds

- A command runs for 2 minutes by default, at most 5, and never past its turn.
  On timeout or cancellation the named container is force-removed; on
  containerd Mob runs `stop -t 0` first, since under runsc `rm -f` alone can
  leave it `Exited`.
- Stdout and stderr are each kept up to 1 MiB; how much the model reads is
  decided by the [large tool output](turns-and-context.md#large-tool-output)
  policy.
- A nonzero exit is a result the model reads, not a failure.
- The image is pulled on first use. A failed pull does not block a run while the
  runtime answers, so a local image still works offline.

## Limits

- `network`, `cpus` and `memory` become `--network none`, `--cpus N` and
  `--memory <MiB>m`, spelled so all three CLIs read them alike. CPUs are whole
  because Apple's CLI takes an integer. Memory requires a unit, since the CLIs
  disagree on a bare number. Network accepts only `none`; named networks differ
  per runtime.
- With `network: none` the tool's description tells the model there is no
  network. DNS and every interface but loopback are gone, so package installs
  fail; use an image with the tools already in it. Allowing only some hosts is
  not offered.
- What a limit bounds follows the runtime: a cgroup on containerd and `wslc`,
  the container's VM on Apple's runtime, where `memory` also covers its kernel
  and an unset value means its configured default (1 GiB unless changed). On
  Linux, CPU and memory limits need the cgroup controllers available to
  containerd; rootless containerd needs them delegated.
- There is no process-count limit: only nerdctl documents `--pids-limit`.

## gVisor on Linux

`isolation: gvisor` puts [gVisor](https://gvisor.dev)'s user-space kernel
between the container and the host's, without a VM. It requires the
`containerd` runtime; on macOS and Windows, or with another runtime, the
configuration is refused rather than failing on the first command.

- nerdctl runs it as `--runtime runsc`, which runs runsc under containerd's runc
  shim, so only `runsc` has to be on containerd's `PATH`
  ([install guide](https://gvisor.dev/docs/user_guide/install/)).
- Network, CPU and memory limits and the workspace mount behave as under runc.
- System-call-heavy work is slower. On a VM without KVM (gVisor's systrap
  platform) container start-up was unchanged, while 2,000 file writes and `cat`s
  took 13 s against 1.6 s under runc. Package installs and builds feel this
  most.
- Rootless containerd with runsc is untested.

## Checking a machine

`mob container` uses the same runtime directly, with `--network`, `--cpus`,
`--memory` and `--isolation`, so a user can confirm it works before enabling the
sandbox:

```bash
mob container status                       # which runtime, and is it running
mob container pull python:3.13-slim
mob container run -v "$PWD:/work" -w /work alpine:3.20 ls -la
```
 `scripts/verify-sandbox.sh` and
`scripts/verify-sandbox.ps1` check a machine end to end, including from inside a
container that each limit took effect; see
[sandbox-verification.md](../sandbox-verification.md).
