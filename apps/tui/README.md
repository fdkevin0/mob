# Terminal UI

`mob tui` opens this OpenTUI React terminal UI. Web and the terminal import the
same `@mob/client` conversation orchestration.

## Runtime

OpenTUI uses a native library via FFI; the `mob` build embeds the one for its
platform, so a release binary needs nothing else installed. From source, use
Bun (version in the root `package.json`) and an interactive terminal:

```sh
bun install --frozen-lockfile
bun run build:cli
./build/mob tui --demo
```

`mob tui` connects to an existing authenticated service or starts one in the
background; `mob start` first keeps the service alive. URL and token are passed
to the UI in memory, never as arguments.

Alternatively, start a service separately and run the connect-only entry from
source:

```sh
./build/mob serve --demo
bun run tui:pilot --url http://127.0.0.1:8787 --token-file /path/to/data/token
```

Alternatively set `MOB_URL` and `MOB_TOKEN`. Do not put a real token in command
arguments, screenshots, issue reports or committed files.

Closing the terminal detaches its local streams, not the service-owned turn.
Ctrl+S explicitly requests stop.

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
| Ctrl+Q | Exit the terminal |

Bracketed paste inserts complete multiline text without treating its newlines as
send keys. Drafts survive switching conversations **in memory only**; quitting
loses unsent drafts. Input remains editable during a turn, but Enter does not
queue another message. The terminal states when a draft is kept instead of sent.

Switching conversations retains the same shared client instance and detaches
its local stream. On reopening, the shared client checks an unconfirmed send
against service history by its exact request ID, never by matching prompt text.
An absent request restores the original text only if the editor is empty and
has not been edited since that send. Newer drafts remain untouched, and the
original is shown separately for review.
Navigation never resends a prompt: Enter explicitly sends the editor contents.
Unknown delivery remains busy while the shared client checks it. If the service
cannot be reached to check, the original returns to an empty, unedited editor
while it stays busy; once history is readable an accepted send clears it and an
absent one becomes a normal recovery. Recovery is
in-memory only, not a durable outbox or a guarantee across process/service exit.

Tool results render as JSON with a 240-character preview, separate error lines
and full details through F3; they are not converted into assistant prose or
discarded. Long values wrap. Model/tool escape controls are stripped before
display. This is plain terminal text, not Web Markdown, file/image presentation
or an embedded browser. Approval scope is determined by the service, not
the renderer. Inspect `/grants` and use `/revoke`; approval is not isolation.

Opening an active conversation follows the existing service turn. The shared
client polls, reconnects/replays and reconciles stored history; switching or
exiting detaches only this client. This is **not** a guarantee that backend work
survives a service restart. Errors remain explicit rather than silently claiming
successful delivery. Plugin management and other custom forms are not implemented;
commands requiring those forms direct the user to Web.
There is no autocomplete UI yet.

## Validation and limits

Run `bun run test:tui` from the root. The native OpenTUI renderer tests use the
real shared client against local HTTP/SSE fixtures, covering immediate
paste+send, consecutive sends, Chinese 130-line paste, per-session drafts,
full tool output/error expansion, 48×16 layout, approval scope/denial payloads,
and send/switch/failure/reopen recovery, newer drafts and accepted requests
without duplicate sends. The navigation regressions exercise the renderer's
real key events and shared HTTP/SSE client, not a mock conversation controller.

The terminal was also exercised against an isolated `serve --demo`
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
[#48](https://github.com/fdkevin0/mob/issues/48) roadmap.
