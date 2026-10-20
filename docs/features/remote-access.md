# Remote access (experimental)

Mob runs on the user's machine and serves its clients over loopback.

## Public web UI

The site at https://mob.fdkevin.cloud is deployed to Cloudflare Workers, so web
changes reach users when they merge, without a release. It has three parts,
served by the Worker in `worker/`:

- `/` is the landing page, scrolled through in pages over one pinned isometric
  voxel office. Each load lays out a new square open-plan floor of shared
  desks and seats calves on about 70% of them; every calf comes from one
  template with a generated skin. Most sit working at their desks; a few at a
  time walk the lanes to high-five, hand
  each other blocks of work, fetch milk tea or coffee, pin notes on the
  whiteboard, try things in the glass booth, put a hand up for the gold
  leader's nod and nap on the sofa, until the leader comes over and cracks its
  whip. `?office=<seed>` pins a layout. The first page is the title over the
  office; the second plays one task step by step in a chat window while the
  calves involved are lit up; the third moves the office left and lists the
  features, and clicking a calf jumps to the feature its activity stands for.
  With reduced motion the pages stack without animation. It is drawn with
  WebGPU (Canvas 2D where WebGPU is missing). The office and the conversation
  are idealised, not a picture of what Mob does today.
- Sign-in is GitHub OAuth through Better Auth, with no passwords. A Cloudflare
  Turnstile check has to pass before the GitHub flow starts. Accounts and
  sessions live in the D1 database `mob-auth`, alongside runner ownership and hashed pairing credentials. Conversation content stays on the runner.
- `/app` is the web UI. The Worker sends visitors without a session back to
  `/?signin=app`. Signed-in visitors enter the workspace even when no runner or
  local Mob is connected yet: they can look around and type a message, and the
  **Connect a runner** dialog opens only when they do something that needs
  Mob, such as sending, starting a conversation or opening plugins. It offers
  **Your own runner** (paired runners, or the Mob address and access token of
  Mob on this computer) and **Cloud runner**, which is disabled and marked
  coming soon. A typed message is kept and placed in the
  composer of the first conversation that opens after connecting; it is not
  sent automatically. A `mob open --web` link opens the dialog to show its
  progress, and a replaced token reopens it with the reason.

The landing page and workspace share the dark theme, Geist fonts and pixel
logo. The workspace uses calmer, rounded controls in the local browser, Wails
desktop app and `/app`: one rounded message box holds the text, the model
picker and a round send (or stop) button; replies have no role labels; each
tool call is one line with its status that opens to show input and output,
and a pending approval opens as a card with Approve, Allow in this
conversation, Always allow and Deny (which then asks for an optional reason). On narrow screens, Conversations opens a side panel; choosing
a conversation closes it. Model selection and sign-in dialogs contain keyboard
focus and return it when closed. Plugin tabs support arrow-key navigation and
keep unsaved configuration edits when switching tabs.

The two pages have separate entries and network policies. Sharing presentation
does not load the landing page's authentication client, Turnstile or voxel scenes
into the workspace.

Pairing with Mob on your computer works as before:

- `mob open --web` asks the running service for a one-time pairing code and
  opens `web_url` with `#offer=` and the base64url JSON
  `{"v":1,"url":"http://127.0.0.1:8787","code":"…"}`. The fragment never reaches
  the site. The landing page holds it in session storage while you sign in;
  GitHub returns to the fixed `/?signin=done`, so the code never reaches
  Better Auth or GitHub. The landing page then removes the code from storage
  and hands it to `/app` once, which exchanges the code at `url` for the access token and keeps the
  address and token in local storage. The code, not the token, travels in the
  link because it expires after 5 minutes and works once.
- Local pairing links accept only `http://127.0.0.1` and `http://localhost`
  addresses. The `/app` content security policy permits those loopback hosts
  and the site itself for encrypted runner access; crafted local links cannot
  point at another server. The landing page may call its own site (sign-in) and
  Turnstile. It shares an origin and the sign-in with `/app`, so the
  Turnstile script, loaded only when the sign-in dialog opens, runs where the
  token is stored.
- `web_url` (`MOB_WEB_URL`) must be https, or http on a loopback host for
  development. Use `--web-url=` or `web_url: ""` to turn this off; an empty
  environment variable is ignored. The service lets that origin call the API
  and answers Chrome's Private Network Access preflight. Whoever controls the
  site's code can read the token of a browser signed in there, so only `main`
  deploys.
- Chrome and Firefox let an https page reach `http://127.0.0.1`; newer Chrome
  asks first. Safari refuses, so use `mob open` there.

Deployment:

- `bun run build:web` builds `webapp/dist-public` (Vite `--mode public`):
  `landing.html` and the web UI's `index.html`. Cloudflare Workers Builds
  deploys `wrangler.jsonc` with build command
  `bun install --frozen-lockfile && bun run build:web` and deploy command
  `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`.
- PR builds use deploy command
  `npx wrangler d1 migrations apply DB --remote --config wrangler.preview-migrations.jsonc && npx wrangler preview`.
  This automatically applies pending preview database migrations before deployment;
  a migration failure stops deployment, and applied migrations are skipped.
  Wrangler requires the explicit
  `previews` block in `wrangler.jsonc`: public variables and the `DB` binding
  do not inherit their production values. Previews share the separate
  `mob-auth-preview` database.
  Keep that file's database ID aligned with `previews.d1_databases`.
  Set the three auth secrets in Cloudflare's Previews Base configuration;
  production secrets are not inherited. Preview URLs are public unless access
  controls are configured. GitHub OAuth callbacks and Turnstile hostnames must
  also allow the preview hostname to exercise sign-in there.
- Secrets: `BETTER_AUTH_SECRET`, `TURNSTILE_SECRET_KEY` and
  `GITHUB_CLIENT_SECRET`. The public `TURNSTILE_SITE_KEY` and
  `GITHUB_CLIENT_ID` are vars in `wrangler.jsonc`. The GitHub OAuth app's
  callback URL is `https://mob.fdkevin.cloud/api/auth/callback/github`.
- Locally, put the secrets in `.dev.vars`, which overrides the vars too
  (Turnstile's test keys work), run
  `npx wrangler d1 migrations apply DB --local`, `bun run build:web` and
  `npx wrangler dev --port 8799 --local-upstream 127.0.0.1:8799` (the flag
  keeps the request host local instead of the production domain; port 8787 is
  Mob's own). The GitHub OAuth app then needs the local callback URL.

## Encrypted remote runners

A runner lets a signed-in GitHub account control Mob on another computer,
without opening an inbound port on that computer. The web app lists only the
account's runners. Conversations, tools and approvals use the existing local
Mob API; the relay cannot call it without an authenticated encrypted request.

1. Sign in at `/app` and choose **Pair a runner**.
2. On the computer running Mob, run `mob runner pair`. Paste the private JSON
   shown in the browser into stdin and press Enter. Do not put it in shell
   arguments, tickets or messages: it contains the encryption key.
3. Run `mob start` (or keep `mob serve` running), then `mob runner`. Keep the
   runner process running. It actively connects to the site over WebSocket
   and reconnects after a disconnect. No gateway flags are needed.
4. When the runner appears online, choose **Open runner** in that browser.
   Use **Revoke access** to invalidate its cloud credential and disconnect it.
   Stopping `mob runner` also stops remote access, without stopping local Mob.

The pairing code expires after five minutes and can be claimed once. The
browser generates a random 256-bit encryption key and retains it locally;
only the one-time pairing code is sent to the cloud. The CLI receives the key
through the pasted JSON, and stores it with the separate runner credential in
`runner.json` in Mob's data directory, with mode `0600`. Its local API token
never leaves the computer. A local token rotation requires restarting
`mob runner` to read the new token. Remote clients cannot mint local pairing
codes, rotate the local token or stop the local service.

Each runner has a Durable Object that forwards opaque envelopes. API methods,
paths, headers, bodies, HTTP statuses and response chunks are encrypted with
AES-256-GCM using random 96-bit nonces. Authenticated associated data binds
protocol version, runner ID, connection session, request ID, direction, chunk
sequence and final-frame status. The runner creates a fresh random session on
every connection, ignores repeated requests, and caps concurrent requests.
A request it refuses (expired, or the runner is busy) gets an encrypted error
saying it did not run; the connection and other requests carry on. Browser
clocks should be synchronized: requests expire after 45 seconds and the runner
rejects expiry times more than a minute in its future. When a browser stops
reading a response, the relay tells the runner to cancel that local request.
A local response that breaks off ends with an authenticated failure, so the
browser rejects it like a reordered, modified or incomplete response. Never
blindly retry a failed action: check saved conversation history first.

The cloud stores account and runner identifiers, hashes of pairing codes and
runner credentials, and timestamps. It can observe connection/IP metadata,
request timing and ciphertext sizes, but has no decryption keys or plaintext
conversation/tool data. HTTP request bodies are limited to 1 MiB before
encryption. A request that produces no output for six minutes fails, at the
relay and at the runner; a longer turn keeps streaming while it produces output. Disconnecting does not undo a completed tool
operation or stop an independently running conversation turn.

Keys belong to the pairing browser. Clearing its site data loses its key;
other browsers must create a new pairing. There is no cloud key recovery,
key synchronization, or forward secrecy after an endpoint key is compromised.
Revoke obsolete runner registrations; an account may have up to 20 pending
or paired runners.

**Trust boundary:** this protects content from the relay and database under
the shipped protocol. The browser still trusts JavaScript served by the site,
including future deployments and same-origin scripts. A malicious deployment
could steal its key before encryption. Protecting against a developer who
changes that JavaScript requires an independently distributed and verified
client; this web version cannot promise that protection. The local model
provider and locally configured tools still receive the data required to do
their work.

The Worker deployment adds the `RUNNERS` Durable Object binding and its SQLite
class migration, plus D1 migration `0002_runners.sql`. Apply the D1 migration
before deploying this Worker; the existing Workers Builds command does so.
No additional cloud secrets are needed. `bun run test:runner` runs the real
Worker/D1/Durable Object, Go service, runner and browser encryption code
locally with fake account sessions and an offline demo model.

## Gateway

Two experimental pieces let a client reach Mob through a gateway.

- `mob gateway` runs a relay and signaling hub (`--gateway-addr`, default `:8788`;
  `--gateway-token` or `MOB_GATEWAY_TOKEN`). It serves the web UI, accepts edge nodes
  and clients over WebSocket, relays frames between them, and forwards WebRTC
  signaling messages. It warns when started without a token.
- `mob serve --gateway-url URL [--gateway-node-id ID]` registers the local service
  with a gateway as an edge node.
- HTTP relay streams preserve the node's response status, headers and SSE text,
  including event IDs and the final `[DONE]` marker. Stream frames carry a JSON
  response envelope, with status and headers on the first chunk; update the
  gateway and node together when upgrading from the older stream format.
- A replacement connection with the same node ID stays registered when its old
  connection disconnects.
- WebSocket requests receive their stream events and final response on the
  originating connection, with the caller's original request ID. Different
  clients can use the same request ID safely.
- Relays allow six minutes without a response frame, covering a five-minute
  sandbox command plus cleanup and transit. A disconnected node fails pending
  requests.
- If a reader falls behind the 64-frame response buffer, its request fails
  explicitly. An HTTP stream already in progress is aborted, so clients see
  an incomplete response; WebSocket clients receive a `slow_consumer` error.
  Check saved history before repeating any action.

The frame protocol is in `internal/protocol/mesh.go`; the gateway and node are
in `internal/gateway` and `internal/node`. There is no WebRTC data channel yet:
the gateway only forwards signaling, and traffic goes through the WebSocket
relay.

The gateway is not meant to be hosted as a public service. The planned
direction is a content-blind, end-to-end encrypted relay.
