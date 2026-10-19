# Remote access (experimental)

Mob runs on the user's machine and serves its clients over loopback.

## Public web UI

The site at https://mob.fdkevin.cloud is deployed to Cloudflare Workers, so web
changes reach users when they merge, without a release. It has three parts,
served by the Worker in `worker/`:

- `/` is the landing page. Behind the title, a faint isometric voxel office
  plays out. Each load lays out a new square open-plan floor of shared desks
  and seats calves on about 70% of them; every calf comes from one template
  with a generated skin. They work, walk the lanes, high-five, hand each other
  blocks of work, fetch milk tea or coffee and nap on the sofa, until the gold
  leader calf comes over and cracks its whip. `?office=<seed>` pins a layout.
  It is drawn with WebGPU (Canvas 2D where WebGPU is missing). Small voxel
  scenes show the features. Both are idealised, not a picture of what Mob
  does today.
- Sign-in is GitHub OAuth through Better Auth, with no passwords. A Cloudflare
  Turnstile check has to pass before the GitHub flow starts. Accounts and
  sessions live in the D1 database `mob-auth`; the site keeps nothing else.
- `/app` is the web UI. The Worker sends visitors without a session back to
  `/?signin=app`.

Pairing with Mob on your computer works as before:

- `mob open --web` asks the running service for a one-time pairing code and
  opens `web_url` with `#offer=` and the base64url JSON
  `{"v":1,"url":"http://127.0.0.1:8787","code":"…"}`. The fragment never reaches
  the site. The landing page holds it while you sign in, then hands it to
  `/app`, which exchanges the code at `url` for the access token and keeps the
  address and token in local storage. The code, not the token, travels in the
  link because it expires after 5 minutes and works once.
- The web UI accepts only `http://127.0.0.1` and `http://localhost` addresses,
  and the content security policy the Worker sets on `/app` lets it connect
  nowhere else, not even to its own site, so a crafted link cannot point it at
  another server. The landing page may call its own site (sign-in) and
  Turnstile, but it never sees the token.
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
- Secrets: `BETTER_AUTH_SECRET`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`,
  `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The GitHub OAuth app's
  callback URL is `https://mob.fdkevin.cloud/api/auth/callback/github`.
- Locally, put the secrets in `.dev.vars` (Turnstile's test keys work), run
  `npx wrangler d1 migrations apply DB --local`, `bun run build:web` and
  `npx wrangler dev --port 8799 --local-upstream 127.0.0.1:8799` (the flag
  keeps the request host local instead of the production domain; port 8787 is
  Mob's own). The GitHub OAuth app then needs the local callback URL.

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
