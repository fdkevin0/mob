# Shared UI

Source-owned components adapted from the composition patterns in
[shadcn/ui](https://ui.shadcn.com/docs), under the accompanying MIT license:
[Dialog](https://ui.shadcn.com/r/styles/new-york/dialog.json),
[Tabs](https://ui.shadcn.com/r/styles/new-york/tabs.json) and
[Button](https://ui.shadcn.com/r/styles/new-york/button.json).

Mob keeps only the controls and variants it uses. Shared CSS applies the site's
theme; Radix owns dialog, sheet, menu and tab interaction. Sheet reuses Dialog.
Native inputs, textareas and labels keep their platform semantics. React 19
passes refs through props. The existing `tailwind-merge` helper is shared with
AI Elements. `webapp/components.json` configures future shadcn additions.

Account and pairing code stays in its page; these controls do not import auth,
Turnstile, storage or client code.
