# Mob Documentation Portal

Welcome to the **Mob** documentation center. This documentation structure follows the industry-standard [Diátaxis](https://diataxis.fr/) framework, organized across four complementary modes:

```
                    Learning-oriented
                            ▲
                            │
         Tutorials          │         How-To Guides
     (Getting Started)      │       (Practical Tasks)
                            │
Practical ──────────────────┼────────────────── Theoretical
(Execution)                 │                   (Understanding)
         Reference          │          Explanation /
    (Contracts & Specs)     │          Architecture
                            │      (Design & Principles)
                            ▼
                    Information-oriented
```

---

## 1. Explanation & Architecture

Understand the architectural concepts, network mesh models, and design decisions:

* **[Product & Architecture Specification](./product-specification.md)**  
  Covers multi-runtime architecture (Desktop, Cloud Gateway, Edge Node), P2P and Gateway relay mesh topology, Telegram & WeChat iLink channel integration, and human-in-the-loop tool approvals.
* **[Architecture Decision Records (ADRs)](./adr/)**  
  Captures key architectural decisions, including:
  - [ADR 0054: Release Versions and Database Migration Windows](./adr/0054-release-versions-and-migration-windows.md)
  - [ADR 0053: One Command Registry Drives Help and Completion in Every Client](./adr/0053-command-registry-and-completion.md)
  - [ADR 0052: Providers in providers.json, Models Chosen per Conversation](./adr/0052-providers-json-and-per-conversation-models.md)
  - [ADR 0051: Multi-runtime Mesh, P2P/Relay Connectivity, and WeChat iLink Channel Gateway](./adr/0051-multi-runtime-mesh-and-channel-gateway.md)

  ADRs 0006–0050 record the retired Cloudflare Worker and are superseded.

---

## 2. Tutorials & Getting Started

Quickly bootstrap and explore Mob across different runtimes:

* **[Project Root README](../README.md)**: Environment prerequisites (Go 1.26+, Bun 1.3.10+, Wails v2), installation, and one-command local startup.
* **Launch Desktop App**: `bun run desktop`
* **Launch Terminal TUI**: `./build/mob tui`
* **Launch Cloud Gateway**: `./build/mob gateway --addr :8788 --token <secret-token>`
* **Launch Background Daemon**: `MOB_DEMO=1 ./build/mob start`

---

## 3. How-To Guides

Step-by-step guides for everyday development and operational tasks:

* **Task Automation**: Use [`justfile`](../justfile) to execute common recipes (`just build`, `just test`, `just desktop`).
* **Contract Generation**: Synchronize Go types with frontend TypeScript contracts via `bun run generate:contracts`.
* **Verification & Testing**:
  - Go Backend Tests: `bun run test:go` (or `go test ./...`)
  - Web Frontend Tests: `bun run test:webapp`
  - Integration Tests: `bun run test:integration`

---

## 4. Reference

Contracts, data schemas, and API definitions:

* **Data Contracts**: [`webapp/src/chat/contracts.ts`](../webapp/src/chat/contracts.ts) (generated from Go structs).
* **Configuration Reference**: [`config.example.yaml`](../config.example.yaml).
* **Channel Ingress Specifications**:
  - Telegram Bot API: [`internal/plugins/telegram`](../internal/plugins/telegram)
  - WeChat iLink HTTP API: See [Product Specification Section 5.2](./product-specification.md#52-wechat-ilink-channel) and Tencent's official protocol docs.
