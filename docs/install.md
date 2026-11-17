# Install

```bash
npm install -g usemob
mob start
```

That is all most people need. With Bun, install the same package with
`bun add -g --trust usemob`. Then see [Use](../README.md#use) in the README.

## Nightly builds

Every change to `main` is published under the `nightly` tag:

```bash
npm install -g usemob@nightly   # or: bun add -g --trust usemob@nightly
```

## Upgrade and uninstall

```bash
mob stop                        # a running service keeps the old version
npm install -g usemob@latest    # or: bun add -g --trust usemob@latest
npm uninstall -g usemob         # or: bun remove -g usemob
```

Uninstalling removes only the program; your conversations and settings stay
where they are.

## Platforms

Mob is published for Linux (x64 and arm64, glibc and musl), macOS (x64 and
arm64) and Windows (x64). The package installs one compiled binary for your
machine. On Alpine and other musl systems the binary needs `libstdc++` and
`libgcc` (`apk add libstdc++ libgcc`).

- **Linux and macOS**: the package's install script puts that binary in place
  of the `mob` command, so Mob runs without Node.js or Bun. Bun runs install
  scripts only for packages you trust, which is what `--trust` does. Without
  it, or with `--ignore-scripts`, the script is skipped and `mob` stays a small
  launcher that needs Node.js on your `PATH`. If the script runs but cannot
  replace the launcher, it prints a warning.
- **Windows**: `mob` is always that launcher, so it needs Node.js on your
  `PATH`. Use an archive below to run Mob without it.

## Desktop app

Installers for macOS (`arm64`, `x64`), Windows (`x64`) and Linux (`x64`,
`arm64`) are on the [releases page](https://github.com/fdkevin0/mob/releases).
Each bundles `mob` inside the Electron app so no separate CLI or Node.js
installation is needed. See [Desktop app](features/desktop.md#install) for
installation, upgrading and first-launch steps on macOS and Windows while builds
are unsigned.

## Without npm

Archives with the same binary and desktop installers are on the
[releases page](https://github.com/fdkevin0/mob/releases): unpack an archive and
put `mob` on your `PATH`, or install the desktop package for your OS. Each
release lists `SHA256SUMS`, and
`gh attestation verify FILE --repo fdkevin0/mob` checks where either was built.
To build from source, see [Contributing](../CONTRIBUTING.md).

## Troubleshooting

- **`@usemob/OS-ARCH is not installed`**: the package for your platform was
  skipped, usually by `--no-optional` or `--omit=optional`. Install again
  without it, or use an archive.
- **`env: 'node': No such file or directory`**: the install script did not
  run. Install again with `bun add -g --trust usemob`, or without
  `--ignore-scripts`.
- **`mob: command not found` after `bun add -g`**: add Bun's global bin folder
  (`~/.bun/bin`) to your `PATH`.

How releases are built and published is in
[Releases and upgrades](features/releases.md).
