# Remote access (experimental)

Mob runs on the user's machine and serves its clients over loopback. Two
experimental pieces let a client reach it from elsewhere.

- `mob gateway` runs a relay and signaling hub (`--addr`, default `:8788`;
  `--token` or `MOB_GATEWAY_TOKEN`). It serves the web UI, accepts edge nodes
  and clients over WebSocket, relays frames between them, and forwards WebRTC
  signaling messages. It warns when started without a token.
- `mob serve --connect-gateway URL [--node-id ID]` registers the local service
  with a gateway as an edge node.

The frame protocol is in `internal/protocol/mesh.go`; the gateway and node are
in `internal/gateway` and `internal/node`. There is no WebRTC data channel yet:
the gateway only forwards signaling, and traffic goes through the WebSocket
relay.

The gateway is not meant to be hosted as a public service. The planned
direction is a content-blind, end-to-end encrypted relay.
