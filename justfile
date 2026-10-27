# List available tasks.
default:
    @just --list

install:
    bun install --frozen-lockfile

# Build the CLI with embedded frontend assets.
build:
    bun run build:cli

# Build the web UI that mob embeds (packages/app).
build-app:
    bun run build

# Build the public site (apps/web) with /app and /docs.
build-web:
    bun run build:web

build-desktop:
    bun run build:desktop

# Frontend development; run the local service separately.
dev:
    bun run dev

# The public site: landing, demo, account and /app.
dev-web:
    bun run dev:web

desktop:
    bun run desktop

# Run the built CLI, e.g. just mob serve --demo.
[positional-arguments]
mob *args:
    ./build/mob "$@"

test: test-core test-web test-integration test-dsh

test-core:
    bun run test:core

test-web:
    bun run test:web
    bun run test:docs

test-integration:
    bun run test:integration

test-dsh:
    bun run test:dsh

generate:
    bun run generate:configdocs
