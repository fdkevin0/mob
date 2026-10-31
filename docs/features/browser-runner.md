# Mob in the browser

Signed in at https://usemob.app/app with no runner connected, Mob runs inside
the browser tab, so you can start talking without installing anything. It has
what needs no process of its own: conversations, approvals, memory, commands,
token usage and the demo model. Coding agents, the sandbox, stdio MCP servers,
messaging channels and schedules need a [runner](remote-access.md), and
Plugins & cloud services is hidden. Mob stops when the tab closes.

The workspace says so: on first use, and whenever **What needs a runner** in
the runner menu is chosen, a notice lists what works and what needs a runner,
with **Connect a runner** beside it. When the browser cannot store files (see
[How it runs](#how-it-runs)) it also warns that conversations end with the
tab. The Agents page says coding agents need a runner instead of listing none.

## Choosing a model

Model calls go straight from the browser to the provider, so they work only
with providers that allow cross-origin requests. OpenCode Zen does not, so the
browser starts on the offline demo model. **Model providers** in the runner
menu saves one provider:

- **A preset or custom provider**: OpenAI, Anthropic, OpenRouter and other
  vendors that take a key, or a custom OpenAI Chat Completions or Anthropic
  Messages base URL, with its API key and optionally a model. Saving lists the
  provider's models and makes the named model, or the first listed, the
  default (`POST /api/plugins/browser/provider`). An Anthropic-only provider is
  sent `anthropic-dangerous-direct-browser-access`.
- **Sign in with OpenRouter** gets a key without copying one: OpenRouter's PKCE
  flow returns to `/app?code=…`, and the worker trades the code, with the
  verifier kept in the tab's session storage, for a key of the user's account
  (`POST /api/plugins/browser/openrouter`), which the user can limit or revoke
  on OpenRouter. OpenRouter is the browser's way to free models, so without a
  named model it starts on a free model that takes tools (OpenRouter limits
  free models per day), and on `openrouter/auto` when none is listed. Mob does
  not proxy OpenCode Zen through usemob.app: OpenCode's docs say its free-tier
  chat models require OpenCode, so other clients must use its paid models.
- **Cloudflare Workers AI (your account)** needs no key: it uses the Cloudflare
  account the visitor signed in with or connected on `/account`, which
  includes a daily free allowance. The provider's base URL is the site's own
  `/api/ai/cloudflare/v1` (`POST /api/plugins/browser/cloudflare`); the Worker
  there checks the session and the request's origin, takes the stored token
  (refreshing it when it has expired), finds the first account it reaches, and
  forwards `GET /models` (Workers AI text generation models, with
  `supported_parameters` marking those that take tools) and
  `POST /chat/completions` to Workers AI's OpenAI-compatible endpoint. The
  token never reaches the page, and without a model named the browser starts
  on the first one that takes tools.
- **Chrome built-in model (experimental, offline)** is offered where the
  browser has Chrome's Prompt API (`LanguageModel`, Chrome 148 or later on a
  desktop). It runs Gemini Nano on the device: free, with no key, and offline
  once Chrome has downloaded the model (about 4 GB, once; Chrome downloads only
  after a click, so the dialog starts the download with a progress bar before
  it saves). Gemini Nano is small and cannot call tools reliably, so the
  provider is saved with `tools: false`: it only replies, and cannot use tools
  or run tasks. Tool calls and results that another model made earlier in the
  conversation reach it as labeled text, so it can still answer from them. It
  reads and writes English, Spanish and Japanese best, and its context is about
  6,000 tokens; a prompt Chrome refuses as too long (`QuotaExceededError`) is
  retried shorter, like any context overflow.

  The Prompt API exists only on pages, not in workers, so the provider's base
  URL is `https://built-in.chrome.invalid/v1`, which never reaches the network:
  the worker answers it like an OpenAI-compatible server (`GET /models` lists
  `gemini-nano`, `POST /chat/completions` streams server-sent events) and posts
  each prompt to the page, which creates a session with the conversation so far
  and streams the reply back (`POST /api/plugins/browser/chrome`).

Keys are stored unencrypted in the browser's database, in the site's origin
private file system, like any key a web app keeps. The browser keeps other
sites out, and the API returns keys only masked, but anyone who can run code
on usemob.app or read the browser profile on disk can read them; the strict
content security policy and having no third-party scripts on the origin are
what guard the first.

## Moving conversations

**Move conversations** in the runner menu of the public web copies
conversations to another Mob this browser can reach: this browser's runner, a
runner it paired, or Mob on this computer (when its token is saved here), and
offers to open it afterwards. It takes each conversation's messages, summary,
model, saved facts and token usage; the originals stay. Pending approvals,
grants, tasks and schedules do not move, and a conversation that is still
replying or waits for an approval is refused until it is done.

The service side is `GET /api/conversations/{id}/export` and
`POST /api/conversations/import` (`Transfer` in
`packages/client/src/contracts.ts`); an import gets a new conversation ID,
replaces message IDs the target already has, marks a reply that was still
streaming as interrupted and does not save an owner's fact twice. Through the
relay a conversation must fit the relay's frame limit of about 2 MB.

## How it runs

The public web runs Mob's core service, `@mob/core`, in a dedicated Web Worker
in the tab (`packages/app/src/browser/`). The page reaches it through a `fetch`
that posts each request to the worker and streams the response back, the same
way the relay is a `fetch` for paired runners; the API, the chat stream and
the change feed are unchanged. The database is the usual SQLite schema on
sqlite-wasm, stored in the origin private file system (OPFS) with the
`opfs-sahpool` VFS, and `providers.json` is a setting in that database. Where
OPFS is unavailable, such as in some private windows, conversations live in
the memory of the leading tab's worker (below): closing or reloading that tab
loses them, even while other Mob tabs stay open, since a follower that takes
over starts an empty database.

Every Mob tab in the browser shares one runner. The pool's file handles are
exclusive, so the worker of one tab leads: it holds the `mob-browser-runner`
Web Lock, owns the database and serves the other tabs over a
`BroadcastChannel`. A follower's worker passes its page's requests to the
leader and streams the answers back, so every tab sees the same conversations
and the change feed reaches them all.

Followers queue for the lock. When the leader's tab closes, one of them opens
the database and leads, retrying while the closed tab's file handles are
released. Once the browser has saved conversations (the pool's files exist in
OPFS), no runner, whether taking over or started anew after a failure, serves
an empty in-memory database in their place: if it still cannot open the saved
one, it fails, its page reports it and starts a new runner on the next
request, and the next follower in line tries. Requests in flight at a
handover fail once, which the client retries (the change stream reconnects by
itself). Each worker also holds a lock named after its tab, so the leader ends
a closed follower's streams. A turn the leader was running stops with its tab,
so while one runs, closing or reloading the leader's tab asks first (the
browser's own leave-page prompt).

The worker is built to `/runner/` (not `/assets/`) so the site's Worker can
give it its own content security policy: it may compile WebAssembly and
connect to any HTTPS provider, while the `/app` page that holds access tokens
keeps its narrow `connect-src`. The local web UI that Mob serves itself is
built without the browser runner.
