# 60. Each plugin describes its own configuration

Date: 2026-10-11
Status: Accepted

Adding a plugin meant editing a `switch` in `configuration.UpdatePlugin`
(decoding, which credentials an update may keep and when a blank one is kept),
another in the server's connection test, the secret list behind
`/clear-secret` and `/test` completion, and the TUI's hand-written form, which
a test then checked against the Go types. This is step three of the extension
architecture after ADR 0058 and 0059.

## Decision

- A `configuration.Section` describes one plugin's part of the saved
  configuration: its name, a title for menus and a label for messages, the
  `Fields` a generic form asks for (JSON path, label and kind: `bool`, `int`,
  `text` or `secret`), its `Secrets`, whether it is enabled, how its
  connection is tested, and how a submitted configuration is merged with the
  saved one. Sections are built with `section`, typed by the plugin's
  configuration, and listed once in `sections.go`.
- A `Secret` names a credential, where it lives in the configuration, and its
  owner: a blank submission keeps the saved credential only while the owner
  (such as an IMAP host and username) is unchanged, as before.
- `UpdatePlugin`, the connection test, `/test` and `/clear-secret` look the
  plugin up instead of naming each one. `GET /api/plugins` adds `sections`;
  the TUI builds its connection menu and forms from them, listing plugins that
  have fields. WeChat iLink signs in by QR code in the web UI, so it has none.
- A test checks every field against the configuration's JSON paths and kinds,
  and that the secret fields are the section's secrets.

## Consequences

Saving, testing and clearing behave as before, and the web UI is unchanged.
Adding a plugin's configuration is one `section` beside the others, and the
TUI offers it without changes. The web UI still has a hand-written form per
plugin; replacing the simple ones with a form built from `Fields` is left for
later, since email and Cloudflare also carry their mailbox and service panels.
