# List available tasks.
default:
    @just --list

install:
    bun install --frozen-lockfile

# Build the CLI with embedded frontend assets.
build:
    bun run build:cli

build-web:
    bun run build

build-desktop:
    bun run build:desktop

# Frontend development; run the local service separately.
dev:
    bun run dev

desktop:
    bun run desktop

# Run the built CLI, e.g. just mob serve --demo.
[positional-arguments]
mob *args:
    ./build/mob "$@"

# Capture a page in each size and theme, e.g. just screenshot http://127.0.0.1:5173/ --name workspace.
[positional-arguments]
screenshot *args:
    bun scripts/screenshot.ts "$@"

test: test-core test-web test-integration test-dsh

test-core:
    bun run test:core

test-web:
    bun run test:webapp
    bun run test:docs

test-integration:
    bun run test:integration

test-dsh:
    bun run test:dsh

generate:
    bun run generate:configdocs
