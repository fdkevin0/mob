# Desktop app

The desktop app is an Electron window around the local service, in
`apps/desktop`. It holds no Mob logic of its own: the window shows the same web
UI the service serves to a browser.

## Install

Download an installer from the
[releases page](https://github.com/fdkevin0/mob/releases) (`mob` is bundled
inside, so no separate CLI or Node.js installation is needed):

- **macOS** (`arm64` and `x64`): open `mob-desktop-VERSION-mac-ARCH.dmg` (or
  extract the `.zip`) and drag **Mob** into `/Applications`.
- **Windows** (`x64`): run `mob-desktop-VERSION-win-x64.exe`.
- **Linux** (`x64` and `arm64`): install
  `mob-desktop-VERSION-linux-amd64.deb` or `-arm64.deb`
  (`sudo apt install ./mob-desktop-VERSION-linux-amd64.deb`), or mark
  `mob-desktop-VERSION-linux-x86_64.AppImage` or `-arm64.AppImage` executable
  (`chmod +x`) and run it.

Packages are not signed or notarized yet, so macOS and Windows block the first
launch:

- **macOS**: try opening **Mob** once and click **Done**, then open
  **System Settings → Privacy & Security** and click **Open Anyway** next to
  Mob (or clear the quarantine attribute with
  `xattr -cr /Applications/Mob.app`).
- **Windows**: in the SmartScreen prompt, click **More info**, then
  **Run anyway**.

Installers are listed in `SHA256SUMS` and attested for `gh attestation verify`
(see [Install](../install.md#without-npm)).

To upgrade, run `mob stop` (or stop the running service) before launching the
new version so the background service restarts with the updated bundled `mob`
binary.

## How it connects

- On launch the app runs `mob connection`. That command starts the background
  service when it is not running (the same as `mob start`) and prints its
  loopback URL and access token as JSON. The window then loads that URL.
- The service outlives the window, so closing Mob leaves channels, schedules and
  coding agent tasks running. `mob stop` stops it.
- The page reaches Node only through `window.mobDesktop.connection()`, which
  runs `mob connection` again; a reloaded window follows `mob token rotate`.
  The renderer runs with context isolation and the Chromium sandbox, without
  Node integration.
- When the service cannot start, the window shows the reason instead of the
  workspace.
- Links to other sites open in the system browser; the window only shows Mob.

## Window and tray

- One instance runs at a time; opening Mob again focuses the window.
- The tray (menu bar on macOS) icon reopens the window. Closing the window hides
  it while the tray is present; **Quit** exits the app and leaves the service
  running.

## Which mob it runs

`MOB_BINARY` names the binary; otherwise the app uses the one packaged in its
resources (`bin/mob`), then `mob` on `PATH`.

## Building

- `bun run desktop` builds the CLI and opens the window against it.
- `bun run build:desktop` compiles `mob` into `apps/desktop/bin/<arch>/` (or
  stages `MOB_BINARY`, or `--x64`/`--arm64` in `scripts/stage.ts`) and writes
  the icon, then runs electron-builder: a DMG and zip on macOS, an NSIS
  installer on Windows, AppImage and deb on Linux, in `apps/desktop/release/`.
- The `desktop` job of the release workflow packages the release's `mob`
  binaries for macOS (`x64`, `arm64`), Linux (`x64`, `arm64`) and Windows
  (`x64`) using the release's SemVer, attests provenance and attaches them to
  the GitHub release, and `checksums` adds them to `SHA256SUMS`. Packages are
  not signed or notarized yet.
