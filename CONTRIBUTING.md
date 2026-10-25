# Contributing

## Setup

You need Bun (version in `package.json`). The desktop app is Electron in
`apps/desktop`; it downloads its own runtime.

```bash
bun install --frozen-lockfile
bun run build:cli                 # web UI + build/mob
./build/mob serve --demo          # offline model, no keys needed
bun run dev                       # Vite, alongside a running service
bun run desktop                   # Electron window around the running service
```

`just` lists the same recipes (`just build`, `just test`, `just desktop`,
`just mob serve --demo`).

### Terminal UI

`./build/mob tui --demo` starts the OpenTUI React terminal UI, which shares
`packages/client` with Web; `bun run tui:pilot -- --url http://127.0.0.1:8787 --token-file /path/to/data/token`
runs it from source against an already running service. OpenTUI uses a native
library via FFI, which the build embeds. See [its README](apps/tui/README.md)
for input controls and limitations.

The workspace packages export TypeScript source for Bun/Vite, not a published
library or a separate release artifact. UI components, browser token storage and
terminal rendering are intentionally not shared.

### Amp orbs

`.agents/setup` prepares a Debian orb with the toolchain versions above, `just`
installs locked dependencies and builds the
CLI. Stale snapshots rerun it without reinstalling unchanged tools.
`.agents/resume` only checks that the tools are there. Both scripts must reach
`main` before new orbs use them. The container sandbox runtime is not installed.
To expose the offline app through an orb portal:

```bash
amp orb service start mob --command './build/mob serve --demo' --port 8787 --portal
```

## Tests

`just test` runs the core and host typecheck and tests (`bun run test:core`),
the UI typecheck and Vitest suite (`bun run test:webapp`), and
`scripts/check-chat.ts`, which builds the binary, starts a temporary service and
reads its stream with the real AI SDK UI parser and shared client. It also runs
`bun run test:dsh`, the optional DSH bridge's typecheck and runtime tests; the
host's MCP tests run the bridge when its dependencies are installed. See
[DSH plugin setup](docs/features/deepseek-harness.md).
`bun run test:runner` checks remote access end to end: the Worker, pairing,
and the encrypted relay against the built binary.
Also run `bun run test:client` (headless Node tests/typecheck) and
`bun run test:tui` (pilot typecheck/tests) when changing the shared client or TUI.
The integration script exercises both client types, concurrent readers,
reconnection, detachment, scoped approvals, stale decisions and Stop. The
`scriptc` workflow reports how much of the host scriptc can compile; it runs
after host changes reach `main`, weekly and by hand, never on pull requests.

Tests use temporary data directories, local fixtures and fake providers, so
they need no keys and send nothing to real models, mailboxes or chats.

## Generated references

Edit the source and regenerate the affected artifact. Tests reject stale output.

| Artifact | Source | Regenerate from the repository root |
| --- | --- | --- |
| `docs/environment-variables.md` | `apps/mob/src/config.ts` | `bun run generate:configdocs` |
| `webapp/public/logo.png` | `webapp/public/logo.svg` | `rsvg-convert -o webapp/public/logo.png webapp/public/logo.svg` (librsvg) |

### Documentation site

`apps/docs` builds the site at https://usemob.app/docs with Starlight. It
copies `README.md`, `CONTRIBUTING.md` and `docs/` in at build time, so write the
Markdown as usual; links between those files become site links and links to
other repository files point at GitHub. A new page under `docs/` needs an
entry in `apps/docs/pages.ts`, which sets the sidebar; the build fails without
one, and on broken links.

```bash
bun run --cwd apps/docs dev       # live preview at http://localhost:4321/docs/
bun run build:web                 # landing page, web UI and documentation
bun run test:site                 # offline routing checks
```

For documentation writing or organization, the repository skill
[mob-docs](.agents/skills/mob-docs/SKILL.md) points to the relevant sources.

## UI style

The app, landing page, demo, account page and documentation share one look: a
quiet rounded workspace, with pixel art kept for the calves.

- Colours, radii and fonts are tokens in `webapp/src/styles/theme.css` (the
  docs palette is in `apps/docs/src/theme.css`). Other stylesheets use the
  tokens; a new colour becomes a token or a named custom property first.
- Radii come from one scale: `--radius-code` (4px) for code and keys,
  `--radius` (8px) for buttons, inputs and menu items, `--radius-card` (12px)
  for cards and menus, `--radius-dialog` (16px) for dialogs and the composer,
  and `--radius-pill` or 50% for pills and dots.
- Shadows are soft and only lift what floats (menus, dialogs, the chat card);
  no hard offset shadows.
- Text is Geist Sans. Geist Mono is for code, terminal output, paths and
  machine values, not for labels, kickers or buttons.
- Lime marks a signal (the primary action, the current item, success), not
  decoration. Only the calves are pixel art; other icons are line icons
  (`webapp/src/components/brand/Icon.tsx`).
- Reuse the shared pieces: `SiteHeader`/`SiteFooter` and `Segmented` in
  `webapp/src/components`, `ThemePicker` in `webapp/src/theme`, and the `.btn`,
  `.ui-input`, `.ui-menu` and `.dialog-panel` classes in
  `webapp/src/styles/base.css`. Every page supports System, Light and Dark.

`webapp/src/theme/style-rules.test.ts` (part of `bun run test:webapp`) checks
the colour, radius and shadow rules over every stylesheet. The chat styles and
the demo's copy of them still carry older radii, counted in that test; lower
the count when you move one onto the scale.

## Changes

- `main` changes only through pull requests, squash-merged: each pull request
  becomes one commit whose message is the pull request title. Keep branches
  linear and rebase onto `main` rather than merging it in.
- Pull request titles follow `type(scope): description`, e.g.
  `fix(models): close reload race`; the `PR title` check enforces it.
  release-please builds the changelog and the next version from them (see
  [Releases](docs/features/releases.md)), so a breaking change needs `!` in the
  title. Commits inside a pull request are not checked.
- A pull request merges once `CI passed` and `PR title` are green. The
  repository's rulesets are kept in [.github/rulesets/](.github/rulesets/); GitHub
  does not read them from there, so a change to one is applied by hand under
  Settings → Rules → Rulesets (import the JSON) in the same pull request.
- A pull request describes the behaviour change, links related issues, lists the
  checks run, and includes screenshots for UI changes.
- Design discussion happens in issues and pull requests. Mob does not keep
  architecture decision records; when a change alters how a feature behaves,
  update its page in [docs/features/](docs/features/README.md) in the same pull
  request.
- Schema changes raise `schemaVersion` in `packages/core/src/chat/schema.ts`
  and add the upgrade from the previous version to `upgrades` (see
  [Releases](docs/features/releases.md)).
- Formatting: `.editorconfig` and `.prettierrc`.
- Never commit provider keys, tokens or databases.

AI Elements sources in `webapp/src/components/ai-elements/` keep
[their Apache-2.0 license and provenance](webapp/src/components/ai-elements/SOURCE.md).
