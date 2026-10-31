# UI style

The app, landing page, demo, account page and documentation share one look: a
quiet rounded workspace, with pixel art kept for the calves.

- Colours, radii and fonts are tokens in `packages/ui/src/styles/tokens.css`,
  which the documentation's `apps/docs/src/theme.css` imports too. Other stylesheets use the
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
  (`packages/ui/src/brand/Icon.tsx`).
- Reuse the shared pieces: `Segmented` and the other controls in `@mob/ui`
  (`packages/ui/src/ui`), `SiteHeader`/`SiteFooter` in `apps/web/src/site`,
  `ThemePicker` in `packages/ui/src/theme`, and the `.btn`,
  `.ui-input`, `.ui-menu` and `.dialog-panel` classes in
  `packages/ui/src/styles/base.css`. Every page supports System, Light and Dark.

`packages/ui/src/theme/style-rules.test.ts` (part of `bun run test:web`) checks
the colour, radius and shadow rules over every stylesheet. The chat styles and
the demo's copy of them still carry older radii, counted in that test; lower
the count when you move one onto the scale.
