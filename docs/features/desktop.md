# Desktop app

The desktop app is an Electron window around the local service, in
`apps/desktop`. It holds no Mob logic of its own: the window shows the same web
UI the service serves to a browser.

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
- `bun run build:desktop` stages `build/mob` and the icon, then runs
  electron-builder: a DMG and zip on macOS, an NSIS installer on Windows,
  AppImage and deb on Linux, in `apps/desktop/release/`.
- The `desktop` job of the release workflow builds these for each nightly and
  attaches them to the release. Packages are not signed or notarized yet.
