# Taking screenshots

Screenshots of the web app show a change to reviewers and illustrate the docs.
Take them the same way each time, so a before and an after compare directly.

## The standard capture

Start the app, then capture it:

```sh
bun run dev -- --mode public           # the public web, running Mob in the browser
bun scripts/screenshot.ts http://127.0.0.1:5173/ --name workspace --wait textarea
```

`scripts/screenshot.ts` writes `<name>-<size>-<theme>.png` for every size in
both themes, into `$TMPDIR/mob-screenshots` unless `--out` names a folder:

| Setting | Value |
| --- | --- |
| Sizes | `desktop` 1280×800, `mobile` 390×844 (`--sizes`) |
| Themes | `light` and `dark`, set through `localStorage['starlight-theme']` before the page loads (`--themes`) |
| Density | `deviceScaleFactor: 2` |
| Motion | `reducedMotion: 'reduce'`, so the calves and transitions hold still |
| Ready | `--wait <selector>` waits for an element; otherwise the page settles for `--delay` ms (1500) |
| State | `--storage key=value` sets `localStorage` first, such as `mob-browser-limits-seen=1` to skip the first-use notice |
| Page | the viewport; `--full` captures the whole scrolling page |

It uses Playwright with Chromium, which is not a dependency of the repository:
cloud sessions have both installed; elsewhere run `bun add -g playwright` and
`bunx playwright install chromium`.

## Which app to capture

- **The public web** (`bun run dev -- --mode public`) runs Mob in the browser
  on the demo model, with no service to start. Use it for `/app`, the landing
  page (`/landing.html`), `/demo.html` and `/account.html`.
- **A local Mob** shows what needs a runner (agents, plugins, the sandbox):
  run `./build/mob serve --demo` and `bun run dev`, and sign in with the token
  it prints. Seed rich conversations with `POST /api/conversations/import`
  rather than typing them.

## States the script cannot reach

Dialogs, menus, approvals, errors and several tabs need a few steps first.
Write a short Playwright script for them outside the repository, with the
settings above, and:

- Click and type through roles and labels (`getByRole`, `getByLabel`), as a user would.
- Open several tabs as pages of one browser context: they share storage, Web
  Locks and the browser runner, like tabs of one browser.
- Make a slow reply with a local OpenAI-compatible server that streams slowly
  and allows CORS, saved as a custom provider.
- Crop to the part that changed with `clip` when the whole window says less.

## Sharing them

- Put screenshots in the pull request, before and after, in both themes, and
  on mobile when the layout changes.
- Commit only images the docs use, under `docs/screenshots/`.
