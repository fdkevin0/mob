# Install

```bash
npm install -g usemob
mob start
```

That is all most people need. `bun add -g usemob` installs the same package
with Bun. Then see [Use](../README.md#use) in the README.

## Nightly builds

Every change to `main` is published under the `nightly` tag:

```bash
npm install -g usemob@nightly   # or: bun add -g usemob@nightly
```

## Upgrade and uninstall

```bash
mob stop                        # a running service keeps the old version
npm install -g usemob@latest    # or: bun add -g usemob@latest
npm uninstall -g usemob         # or: bun remove -g usemob
```

Uninstalling removes only the program; your conversations and settings stay
where they are.

## Platforms

Mob is published for Linux and macOS (x64 and arm64) and Windows (x64). The
package installs one compiled binary for your machine, so Mob itself needs
neither Node.js nor Bun; the small `mob` launcher in the package runs with
Node.js.

## Without npm

Archives with the same binary are on the
[releases page](https://github.com/fdkevin0/mob/releases): unpack one and put
`mob` on your `PATH`. Each release lists `SHA256SUMS`, and
`gh attestation verify ARCHIVE --repo fdkevin0/mob` checks where it was built.
To build from source, see [Contributing](../CONTRIBUTING.md).

## Troubleshooting

- **`usemob-OS-ARCH is not installed`**: the package for your platform was
  skipped, usually by `--no-optional` or `--omit=optional`. Install again
  without it, or use an archive.
- **`mob: command not found` after `bun add -g`**: add Bun's global bin folder
  (`~/.bun/bin`) to your `PATH`.

How releases are built and published is in
[Releases and upgrades](features/releases.md).
