# Mob as an always-on runner, for hosts such as Render (render.yaml).
# It serves only loopback inside the container and reaches the web app through
# the encrypted runner connection, so the container exposes no port.

FROM oven/bun:1.4.3 AS web
WORKDIR /src
COPY package.json bun.lock ./
COPY packages/client/package.json packages/client/
COPY apps/tui/package.json apps/tui/
COPY apps/dsh/package.json apps/dsh/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM golang:1.26 AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/webapp/dist webapp/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mob ./cmd/mob

FROM debian:trixie-slim
COPY --from=go /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=go /mob /usr/local/bin/mob
# Configuration, providers.json, the database and runner.json all follow HOME,
# which is the persistent disk. Render mounts disks owned by root, so Mob runs
# as root inside its own container.
ENV HOME=/data
WORKDIR /data
CMD ["mob", "runner", "--serve"]
