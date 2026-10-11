# 35. Email listing and preview inside the Mini App

Date: 2026-07-04
Status: Superseded — records the retired Cloudflare Worker, kept at the `legacy-worker` tag; the Go runtime does not follow it.

Email uses the same Telegram `initData` authentication and Principal capability
checks as Settings. Removing bearer preview links avoids a second authentication
scheme and non-expiring, shareable access to email. Viewing requires a Telegram
session with `manage_email`.

- Load recent email metadata when the Email tab opens or refreshes. Keep it out
  of Settings bootstrap; it changes independently and is fetched on demand.
- Both the triage View button (`?screen=email&id=<id>`) and a list-row tap open
  the same detail screen. Telegram BackButton returns to the list.
- D1 supplies metadata; R2 raw mail is the content source. Render untrusted HTML
  in an empty-sandbox `srcdoc` iframe: no scripts, forms, or same-origin access.
  Inline `cid:` images become data URIs; remote images are allowed. Escape plain
  text before wrapping it in `pre`.
- Attachments are metadata only. The list has no pagination, folders, filters,
  or read/unread state.

The [React shell](0036-settings-mini-app-frontend-spa.md) hosts both settings and
email on the same Worker. `EMAIL_PREVIEW_SECRET` and the old bearer routes are
unused; no compatibility endpoint is retained.
