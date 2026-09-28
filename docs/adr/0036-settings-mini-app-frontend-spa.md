# 36. React Settings Mini App on the Worker

Date: 2026-07-05
Status: Accepted

Use React, TypeScript, and Vite for the Mini App. A separate frontend makes
navigation and interactions testable without embedding a browser program in a
Worker HTML string. Use Tailwind CSS with its Vite plugin for styles, and native HTML controls
and dialogs for interaction in Telegram webviews.

## Hosting and authorization

Build `webapp/` as Workers Static Assets on the same origin and deployment as the
API. `run_worker_first = true` preserves Worker routing, including the dynamic
Telegram webhook path; delegate only Mini App static requests to `ASSETS`.
Static fallback must never answer an API request or swallow a webhook.

The shell is public; data and mutations verify Telegram `initData` and enforce
`use_commands` plus each route's declared capability. Resolve private-chat state
from the verified user ID, never a client-supplied chat ID. Hiding a tab is only
presentation. Worker and frontend share a types-only API contract.

## Navigation and interaction

- Settings, Memory, and Email are capability-gated feature tabs. A small pure
  navigation reducer handles drill-in views and Telegram BackButton. Read email
  deep links once at startup; cold and warm entry share the detail screen.
- Language remains free text. Schedules support listing and cancellation;
  creation stays in chat. Chat settings expose thinking, compaction, and memory
  retrieval controls. Global service config controls email HTML conversion.
- Use Tailwind's default typography, spacing, and sizing. Telegram supplies colors
  and the light/dark scheme through `styles.css`, with browser fallbacks.
- Use native form validation and modal dialogs. Destructive confirmation initially
  focuses Cancel. Preserve document scrolling and text selection outside controls.
- Combine system and Telegram safe-area insets. The sticky tab bar reserves its
  actual height in document flow; notifications anchor above it so neither needs
  a hard-coded height offset.
- Refresh retains existing data. Notifications announce results outside forms
  without moving page content.
- Email HTML remains in the [sandboxed iframe](0035-email-listing-and-miniapp-preview.md).
  Static CSP is maintained in [the asset headers](../../webapp/public/_headers).

Browser emulation cannot validate the iOS Telegram system copy menu.
