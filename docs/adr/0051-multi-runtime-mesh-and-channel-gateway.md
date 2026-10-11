# 51. Multi-runtime mesh, P2P/relay connectivity, and WeChat iLink channel gateway

Date: 2026-10-11
Status: Accepted

Mob moves from a single-machine local runtime to a unified codebase supporting desktop (Wails), cloud gateway (headless relay & ingress), and remote web access, with P2P / gateway relay networking and multi-channel ingress for Telegram and WeChat iLink.

- A single Go binary supports distinct runtimes via subcommands (`desktop`, `gateway`, `serve`, `tui`, `node`), sharing the core conversation engine, SQLite storage, and tools.
- Remote connectivity uses a hybrid topology: clients first attempt direct P2P connection via WebRTC DataChannel (with the gateway acting as signaling coordinator); if NAT traversal fails, traffic falls back transparently to WebSocket relay through the gateway.
- Cloud gateway hosts the Web SPA, coordinates incoming WebRTC signaling, terminates public HTTPS/WSS, and handles messaging channel adapters that require public endpoints.
- Messaging channels:
  - Telegram connects via Bot API (webhook on gateway, long-polling for local standalone).
  - WeChat connects natively via the official Tencent WeChat iLink HTTP API protocol (`ilinkai.weixin.qq.com`), handling QR-code authorization, long-polling `getupdates`, context-bound `sendmessage`, and typing indicators in pure Go without external Node/OpenClaw daemon dependencies.
- Tool execution approvals (ADR 0039) are channel-agnostic: approval requests are dispatched to active connected sessions (Web, Desktop, Telegram inline buttons, WeChat natural language approval replies), and authorization from any valid session resumes the turn.
