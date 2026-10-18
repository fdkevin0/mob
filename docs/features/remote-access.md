# Remote access (experimental)

Mob runs on the user's machine and serves its clients over loopback.

## Public web UI

The web UI is also deployed to Cloudflare Workers at https://mob.fdkevin.cloud,
so web changes reach users when they merge, without a release.

- `mob open --web` asks the running service for a one-time pairing code and
  opens `web_url` with `#offer=` and the base64url JSON
  `{"v":1,"url":"http://127.0.0.1:8787","code":"…"}`. The fragment never reaches
  the site. The page exchanges the code at `url` for the access token and keeps
  the address and token in local storage. The code, not the token, travels in
  the link because it expires after 5 minutes and works once.
- The page accepts only `http://127.0.0.1` and `http://localhost` addresses, and
  its content security policy lets it connect nowhere else, so a crafted link
  cannot point it at another server. The site holds no data and runs no Worker
  code.
- `web_url` (`MOB_WEB_URL`) must be https, or http on a loopback host for
  development. Use `--web-url=` or `web_url: ""` to turn this off; an empty
  environment variable is ignored. The service lets that origin call the API
  and answers Chrome's Private Network Access preflight. Whoever controls the
  site's code can read the token of a browser signed in there, so only `main`
  deploys.
- Chrome and Firefox let an https page reach `http://127.0.0.1`; newer Chrome
  asks first. Safari refuses, so use `mob open` there.
- `bun run build:web` builds `webapp/dist-public` (Vite `--mode public`).
  Cloudflare Workers Builds deploys it from `wrangler.jsonc` with build command
  `bun install --frozen-lockfile && bun run build:web` and deploy command
  `npx wrangler deploy`.

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
