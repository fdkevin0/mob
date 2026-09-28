# Settings Mini App

A Telegram Mini App for chat settings, memory, bookmarks, email and
admin-wide service settings. It is a React single-page app served from the
same Worker as its API.

## How it works

### Hosting

- `webapp/` is built with Vite and deployed as **Workers Static Assets** on
  the same origin as the API, under `/miniapp/`.
- `run_worker_first = true` keeps Worker routing, including the Telegram
  webhook path, in charge. Only Mini App static requests are passed to
  `ASSETS`. The static fallback must never answer an API request or swallow a
  webhook.
- A content security policy is set in
  [`webapp/public/_headers`](../../webapp/public/_headers).

### Authorization

The app shell is public. Every data request and change is a `POST` under
`/miniapp/settings/*` and goes through the same checks:

1. Verify Telegram `initData` ([`telegram-auth.ts`](../../src/features/miniapp/telegram-auth.ts)).
2. Require `use_commands`.
3. Require the route's declared capability, if it has one.

Private-chat state is resolved from the verified user ID, never from a chat
ID supplied by the client. Hiding a tab only affects what's shown; the server
enforces every check. The Worker and the SPA share a types-only
[API contract](../../src/features/miniapp/contract.ts).

| Route group | Extra capability |
| --- | --- |
| Bootstrap, language, HTML parser, chat settings, memory, bookmarks | none |
| Debug mode | `view_debug` |
| Schedule cancellation | `schedule_turns` |
| Email list and detail | `manage_email` |
| Command sync, global service settings | `admin_ops` |

### Screens

| Tab | Contents |
| --- | --- |
| **Settings** | Language (free text), HTML parser, debug mode, schedules (list and cancel), chat settings (reasoning effort, compaction threshold, memory top-k), global service (email HTML parser) |
| **Memory** | Facts grouped by layer, *Forget all* ([Memory](memory.md)) |
| **Email** | Recent email list and detail |
| **Bookmarks** | Saved bookmarks (the backend is unpublished) |

Navigation is a small pure reducer over a per-tab screen stack, and it drives
Telegram's BackButton. The deep link `?screen=email&id=<id>` is read once at
startup.

### Email preview

- Email metadata is loaded from D1 when the Email tab opens or refreshes, not
  in the settings bootstrap.
- The raw message comes from R2. Untrusted HTML is rendered in an empty
  sandboxed `srcdoc` iframe: no scripts, forms or same-origin access. Inline
  `cid:` images become data URIs; remote images are allowed. Plain text is
  escaped inside `<pre>`.
- Attachments are shown as metadata only. There's no pagination, folders,
  filters or read state.
- SPF, DKIM and DMARC results drive a SPAM badge
  ([`auth.ts`](../../src/features/email/auth.ts)).

### UI conventions

- Tailwind's default typography and spacing. Telegram supplies colors and the
  light or dark scheme through `styles.css`, with fallbacks for browsers.
- Native form validation and modal dialogs. Destructive confirmations focus
  *Cancel* first.
- System and Telegram safe-area insets are combined. The sticky tab bar takes
  up its real height, and notifications sit above it.
- Refreshing keeps the existing data on screen. Notifications don't move page
  content.

## Build and test

```bash
pnpm build          # → webapp/dist
pnpm test:webapp    # tsc + Vitest (happy-dom)
```

## Design decisions

- **React + Vite instead of HTML in a Worker string.** Navigation and
  interactions can be tested
  ([ADR-0036](../adr/0036-settings-mini-app-frontend-spa.md)).
- **Same origin and deployment as the API.** Ship the frontend and Worker
  together.
- **`initData` instead of bearer preview links.** One authentication scheme,
  and no non-expiring, shareable links to email
  ([ADR-0035](../adr/0035-email-listing-and-miniapp-preview.md)).

## Known limitations

- Browser emulation can't test the iOS Telegram system copy menu.

## Source

- [`webapp/src/miniapp/`](../../webapp/src/miniapp/): the SPA, its screens
  and tests
- [`src/features/miniapp/`](../../src/features/miniapp/): routes, contract
  and `initData` auth
- [`src/features/email/preview.ts`](../../src/features/email/preview.ts):
  email preview rendering
