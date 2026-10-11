# 56. Optional network and resource limits for the sandbox

Date: 2026-10-11
Status: Accepted

ADR 0055 left the sandbox's network open and its CPU and memory unbounded,
because the three runtime CLIs did not document the same flags and a limit that
silently does nothing on one platform is worse than none. Reading the CLIs'
sources settles it: nerdctl takes Docker's flags, Apple's `container run`
takes `--cpus` (whole CPUs), `--memory` and `--network none` (the last is in
its source since 1.3, not in its command reference), and `wslc run` in WSL
2.9.3 takes `--cpus`, `--memory` and `--network none`, which it hands to the
session's Docker engine as `NanoCpus`, `Memory` and network mode `none`.

## Decision

- **Three optional settings**, reloaded live like the rest of the section:

  ```yaml
  sandbox:
    network: none   # empty: the runtime's default network
    cpus: 2         # whole CPUs per command; 0: the runtime's default
    memory: 1g      # at least 64m; empty: the runtime's default
  ```

  `MOB_SANDBOX_NETWORK`, `MOB_SANDBOX_CPUS` and `MOB_SANDBOX_MEMORY` override
  them. Defaults keep ADR 0055's behaviour.
- **One flag set for every runtime.** `container.Limits` becomes
  `--network none`, `--cpus N` and `--memory <MiB>m`, spelled so all three CLIs
  read them alike: CPUs are whole because Apple's CLI takes an integer, and
  Mob parses memory itself (a unit is required, since the CLIs disagree on a
  bare number) and passes MiB. Network accepts only `none`; named networks
  differ per runtime and would need creating first.
- **The model is told.** With `network: none` the sandbox tool's description
  says there is no network and to use what the image provides.
- `mob container run` takes `--network`, `--cpus` and `--memory`, and the
  verification scripts check from inside a container that each limit took
  effect, through both the CLI and the tool.

## Consequences

- What a limit bounds follows the runtime: a cgroup on containerd and `wslc`,
  the container's VM on Apple's runtime, where `memory` also covers its kernel
  and an unset value means its configured default (1 GiB unless changed).
- On Linux, CPU and memory limits need the cgroup controllers available to
  containerd; rootless containerd needs them delegated. The verification
  script reports a limit that did not apply.
- `network: none` removes DNS and every interface but loopback, so package
  installs fail; an image with the tools already in it is the way to work
  offline. Allowing only some hosts is not offered.
- There is no process-count limit: only nerdctl documents `--pids-limit`.
