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

Understand how Mob is built and how its features behave:

* **[Product & Architecture Specification](./product-specification.md)**  
  Covers multi-runtime architecture (Desktop, Cloud Gateway, Edge Node), P2P and Gateway relay mesh topology, Telegram & WeChat iLink channel integration, and human-in-the-loop tool approvals.
* **[Features](./features/README.md)**  
  How each part of Mob behaves today: providers, turns and context, tools and approvals, the sandbox, commands, channels, MCP, extensions, releases and remote access. Design discussion happens in issues and pull requests; Mob does not keep architecture decision records.

---

## 2. Tutorials & Getting Started

Quickly bootstrap and explore Mob across different runtimes:

* **[Project Root README](../README.md)**: Environment prerequisites (Go 1.26+, Bun 1.4.3+, Wails v2), installation, and one-command local startup.
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
