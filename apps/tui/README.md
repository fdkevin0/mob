# TypeScript terminal pilot

An explicit development pilot, not a replacement for `mob tui`. It connects to
an already running Go service; it never starts or owns that service. Web and
this terminal import the same `@mob/client` conversation orchestration.

## Runtime

Use Bun >=1.3.14 and an interactive terminal. OpenTUI React 0.6.1 uses a native
OpenTUI library via FFI. This pilot does not build a standalone executable or
change Go release packaging. Node and other OS/architecture combinations are
not validated by this pilot.

From the repository root, install workspace dependencies with `bun install`.
Start a service separately, then launch with the service URL and token file:

```sh
./build/mob serve --demo
bun run tui:pilot --url http://127.0.0.1:8787 --token-file /path/to/data/token
```

Alternatively set `MOB_URL` and `MOB_TOKEN`. Do not put a real token in command
arguments, screenshots, issue reports or committed files.

The existing `mob tui` command remains the fallback. Closing the pilot detaches
its local streams, not the service-owned turn. Ctrl+S explicitly requests stop.

## Controls and behavior

| Key | Action |
| --- | --- |
| Enter | Send editor contents; slash commands use the service registry |
| Ctrl+J | Insert a newline; Shift+Enter / Alt+Enter also work when the terminal distinguishes them |
| F2 | Search/select conversations; Tab switches search/list focus; arrows + Enter select |
| Ctrl+N in F2 | Create and open a conversation |
| F3 | Toggle complete tool input/output JSON and provider reasoning |
| F4 | Review pending approvals; allow once, for this conversation, always, or deny with optional reason |
| PgUp / PgDn | Scroll transcript or approval input; inspect long inputs before authorizing |
| Esc | Return to chat / dismiss command result / cancel approval selection |
| Ctrl+S | Request backend stop for the selected conversation |
| Ctrl+Q | Exit the pilot, without stopping backend work |

Bracketed paste inserts complete multiline text without treating its newlines as
send keys. Drafts survive switching conversations **in memory only**; quitting
loses unsent drafts. Input remains editable during a turn, but Enter does not
queue another message. The pilot states when a draft is kept instead of sent.

Switching conversations retains the same shared client instance and detaches
its local stream. On reopening, the shared client checks an unconfirmed send
against service history by its exact request ID, never by matching prompt text.
An absent request restores the original text only if the editor is empty and
has not been edited since that send. Newer drafts remain untouched, and the
original is shown separately for review.
Navigation never resends a prompt: Enter explicitly sends the editor contents.
Unknown delivery remains busy while the shared client checks it. Recovery is
in-memory only, not a durable outbox or a guarantee across process/service exit.

Tool results render as JSON with a 240-character preview, separate error lines
and full details through F3; they are not converted into assistant prose or
discarded. Long values wrap. Model/tool escape controls are stripped before
display. This is plain terminal text, not Web Markdown, file/image presentation
or an embedded browser. Approval scope is determined by the Go service, not
the renderer. Inspect `/grants` and use `/revoke`; approval is not isolation.

Opening an active conversation follows the existing service turn. The shared
client polls, reconnects/replays and reconciles stored history; switching or
exiting detaches only this client. This is **not** a guarantee that backend work
survives a service restart. Errors remain explicit rather than silently claiming
successful delivery. Plugin management and other custom forms are not implemented;
commands requiring those forms direct the user to Web or the existing Go TUI.
There is no new command engine or autocomplete UI in this pilot.

## Validation and limits

Run `bun run test:tui` from the root. The native OpenTUI renderer tests use the
real shared client against local HTTP/SSE fixtures, covering immediate
paste+send, consecutive sends, Chinese 130-line paste, per-session drafts,
full tool output/error expansion, 48×16 layout, approval scope/denial payloads,
and send/switch/failure/reopen recovery, newer drafts and accepted requests
without duplicate sends. The navigation regressions exercise the renderer's
real key events and shared HTTP/SSE client, not a mock conversation controller.

The initial pilot was also exercised against an isolated Go `serve --demo`
service: streamed Chinese multiline replies, real approval/deny and persisted
tool failure, conversation grants and duplicate-decision rejection, explicit
stop with a retained draft, and following a remote turn after client detach.
A locally injected SSE interruption verified visible failure and reconciliation
to one persisted reply. Native framebuffer captures and Linux tmux PTY captures
were inspected; they are not claims about every terminal emulator.

Validated: Linux x64, Bun 1.4.2, OpenTUI 0.6.1, 80×24 and 48×16 frames, local tmux.
Not validated: actual Chinese IME composition/candidate windows, SSH transport,
Windows/macOS, terminal-specific Shift+Enter encodings, screen readers, clipboard
copy/export, or very small windows below 48×16. These remain acceptance work in
[#49](https://github.com/fdkevin0/mob/issues/49) and the broader
[#48](https://github.com/fdkevin0/mob/issues/48) roadmap, not a reason to remove
the Go fallback or change default releases.
