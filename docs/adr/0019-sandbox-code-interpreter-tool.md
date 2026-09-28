# 19. Sandbox-backed code execution

Date: 2026-06-21
Status: Accepted

Use a Cloudflare Sandbox for model-authored Python, JavaScript, and TypeScript
rather than executing snippets inside the Worker. A sandbox keyed by chat lets
multi-step work reuse interpreter state, files, and installed packages while the
container remains alive. Idle shutdown means this is not durable file storage.

Use the published `-python` image, version-matched to the Sandbox package in the
Worker's `wrangler.toml` (not published). Referencing it directly avoids maintaining a
custom image or a local Dockerfile build. Runtime package installation is slower
and network-dependent. Tools return text; generated files and plots are not
uploaded to Telegram.

`run_code` uses the interpreter; `run_shell` uses shell execution. Narrow injected
runner interfaces let both tools test without containers. Members can use code
execution; shell calls require [tool approval](0039-tool-approval-as-turn-boundary.md)
and are excluded from deep tasks.

Both tools share a wall-clock budget per user, per chat, per UTC day. Group members
have independent buckets. Calls are refused once the budget is exhausted and
execution time is charged even on failure. This is an admission check, not a
hard timeout on an already-running call. `SANDBOX_DAILY_LIMIT_SECONDS` controls
the cap (`0` disables it); `/usage` reports the bucket. See
[SandboxUsage](../../src/features/agent/sandbox-usage.ts) for defaults and accounting.

This adds billable container infrastructure. Code and results can appear in
admin debug traces, subject to the same handling as other tool payloads.
