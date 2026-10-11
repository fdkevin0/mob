# Verifying the sandbox on macOS and Windows

The sandbox (ADR 0055) is unit-tested on every platform, and these scripts check
a real machine end to end. Results so far:

| Platform | Runtime | Result |
| --- | --- | --- |
| Linux | containerd 2.3.6, nerdctl 2.1.6 | all checks pass |
| macOS 27.0.1, Apple silicon | Apple container 1.5.0 | all checks pass |
| Windows | wslc | not yet run on a real machine |

Each script builds `mob` from the
checkout, then checks the following and prints `PASS`/`FAIL` per check:

| Check | What it proves |
| --- | --- |
| `container status` | the runtime CLI is found and its service answers |
| `container pull` | `image pull` works; a FAIL with `429` is the registry rate limit, not Mob |
| env, bind mount, workdir | `-e`, `-v SRC:DST`, `-w` are accepted, from a path containing a space |
| writes reach the host | the bind mount is read-write |
| exit status | a container's exit code comes back |
| stdin with `-i` | piped input reaches the container |
| tool runs without approval | `mob serve --demo` offers the `sandbox` tool and runs it in `/workspace` |
| workspace persists, the rest is discarded | only `/workspace` survives between calls |
| workspace on the host | it is `data_dir/sandbox/<conversation>` |
| nonzero exit, output capped | the tool reports `exitCode` and `truncated` |
| stop removes the container | `--name` plus the runtime's force-remove work |

A failed run keeps its work directory (config, `serve.log`, workspaces) and
prints its path.

## macOS

Requirements: Apple silicon, macOS 26, Go 1.26+, Git.

1. Install Apple's runtime from the signed `.pkg` on the
   [releases page](https://github.com/apple/container/releases), then start it:

   ```bash
   container system start          # accept the default kernel when asked
   container system status
   container run --rm alpine:3.20 echo ok
   ```

2. Run the check from the checkout:

   ```bash
   git clone https://github.com/fdkevin0/mob && cd mob
   git checkout claude/gallant-rubin-v1m99y
   scripts/verify-sandbox.sh
   ```

3. Also try the real data directory, whose path contains a space
   (`~/Library/Application Support/mob`): add the `sandbox:` section from
   `config.example.yaml` with `enabled: true`, run `build/mob serve --demo`
   (`go build -o build/mob ./cmd/mob` first), and in the web UI send
   `/sandbox uname -a; pwd; ls /Users`.

## Windows

Requirements: Windows 11 with virtualization enabled, a WSL release that
includes WSL containers, Go 1.26+, Git.

1. Install or update WSL with containers, then check `wslc`:

   ```powershell
   wsl --update --pre-release      # if wslc is not yet in the stable release
   wsl --version
   wslc run --rm alpine:3.20 echo ok
   ```

2. Run the check from the checkout (PowerShell; Windows PowerShell 5.1 or 7):

   ```powershell
   git clone https://github.com/fdkevin0/mob; cd mob
   git checkout claude/gallant-rubin-v1m99y
   powershell -ExecutionPolicy Bypass -File scripts\verify-sandbox.ps1
   ```

3. Repeat with your normal user profile path (`%LOCALAPPDATA%\mob` by default),
   as in step 3 for macOS, and send `/sandbox ls /mnt/c` — it must fail.

## What to send back

The script's full output, plus for any FAIL:

- the runtime's version (`container --version` or `wsl --version`);
- `serve.log` from the kept work directory;
- the output of the failing step run by hand, with `--help` for that
  subcommand (`container run --help`, `wslc run --help`, `wslc rm --help`),
  since the flags Mob uses are taken from documentation that may lag the CLI.
