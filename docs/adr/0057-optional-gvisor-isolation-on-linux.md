# 57. Optional gVisor isolation on Linux

Date: 2026-10-11
Status: Accepted

ADR 0055 leaves Linux the weakest of the three platforms: a sandbox container
shares the host kernel, so a kernel bug the model's command can reach is a way
out, and with rootful containerd that way out is root. Apple's runtime and
`wslc` already put each container behind a VM. [gVisor](https://gvisor.dev)
answers this on Linux without a VM or nested virtualization: its `runsc`
runtime puts a user-space kernel between the container and the host's, and
containerd can run it in place of runc. Google has donated it to the CNCF
(2026-10-02), which lowers the risk of depending on it.

## Decision

- **One optional setting**, reloaded live like the rest of the section:

  ```yaml
  sandbox:
    isolation: gvisor   # empty: the runtime's own isolation
  ```

  `MOB_SANDBOX_ISOLATION` overrides it. It requires the `containerd` runtime;
  on macOS and Windows, or with another runtime, the configuration is refused
  rather than failing on the first command.
- **nerdctl runs it as `--runtime runsc`.** A bare binary name runs runsc under
  containerd's runc shim, as Docker's `--runtime=runsc` does, so only `runsc`
  has to be on containerd's `PATH`. gVisor's own shim
  (`io.containerd.runsc.v1`) also works on ordinary hosts, but needs a second
  binary and sets a negative OOM score, which some hosts refuse.
- **Removal stops first on containerd.** Under runsc, `nerdctl rm -f` on a
  running container whose `run` client was killed stops the sandbox and then
  fails to delete the container, leaving it `Exited`. Mob now runs
  `stop -t 0` before `rm -f` on containerd; under runc this changes nothing.
- `mob container run --isolation gvisor` does the same from the CLI, and
  `MOB_SANDBOX_ISOLATION=gvisor scripts/verify-sandbox.sh` runs every check
  under gVisor plus one that `dmesg` reports gVisor, both through the CLI and
  through the tool. The script's network check reads `/proc/net/dev`, since
  gVisor has no `/sys/class/net` and, with `network: none`, not even `lo`.

## Consequences

- Off by default: it needs `runsc` installed
  ([gVisor's install guide](https://gvisor.dev/docs/user_guide/install/)),
  next to the nerdctl and CNI plugins Linux already needs.
- Network, CPU and memory limits (ADR 0056) and the workspace mount behave as
  under runc; verified with containerd 2.3.6, nerdctl 2.1.6 and runsc
  release-20261005.0.
- System-call-heavy work is slower. On the verification machine (a VM without
  KVM, so gVisor's systrap platform) container start-up was unchanged, while a
  loop of 2,000 file writes and `cat`s took 13 s against 1.6 s under runc.
  Package installs and builds feel this most.
- Rootless containerd with runsc is untested.
