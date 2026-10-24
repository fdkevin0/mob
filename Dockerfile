# Mob as an always-on runner, for hosts such as Render (render.yaml).
# It serves only loopback inside the container and reaches the web app through
# the encrypted runner connection, so the container exposes no port.

FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build && bun apps/mob/scripts/build.ts --outfile /mob

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /mob /usr/local/bin/mob
# Configuration, providers.json and the database follow HOME. Mount a disk at
# /data to keep them; Render mounts disks owned by root, so Mob runs as root
# inside its own container.
ENV HOME=/data
WORKDIR /data
# Render gives web services PORT and their public RENDER_EXTERNAL_URL. Requesting
# that URL from inside keeps a free instance from sleeping: the runner's relay
# connection is outbound, which Render does not count as traffic.
CMD ["sh", "-c", "exec mob runner --serve --health-addr=:${PORT:-10000} ${RENDER_EXTERNAL_URL:+--keep-awake=$RENDER_EXTERNAL_URL}"]
