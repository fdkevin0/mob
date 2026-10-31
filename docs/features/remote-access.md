# Remote access (experimental)

Mob runs on your computer and listens only on loopback. To use it from
somewhere else, pick the way that fits:

| You want | Use | See |
| --- | --- | --- |
| Mob's web UI in a browser on this computer | `mob open` | [Configuration](configuration.md) |
| https://usemob.app connected to Mob on this computer | `mob open --web` | [Open usemob.app with local Mob](#open-usemobapp-with-local-mob) |
| Mob on another computer, from any browser or phone | `mob runner pair`, then `mob runner` | [Encrypted remote runners](#encrypted-remote-runners) |
| Mob without installing anything | sign in at usemob.app | [Mob in the browser](browser-runner.md) |
| Mob that stays on without your computer | **Deploy to the cloud** | [Runners in the cloud](cloud-runners.md) |

Everything but the first needs a GitHub (or Cloudflare) sign-in at
usemob.app. Conversation content stays on the Mob that holds it: the site
stores accounts and runner registrations, and relays only encrypted traffic.
How the site itself is built and deployed is in [Public site](../website.md).

## The web app at usemob.app

- Sign-in is GitHub or Cloudflare OAuth through Better Auth, with no
  passwords. Cloudflare is offered once `CLOUDFLARE_CLIENT_SECRET` is set. A
  Cloudflare Turnstile check has to pass before either flow starts. Accounts
  are never linked by matching emails: signing in with Cloudflare under the
  email of an account GitHub made is refused with a hint to sign in with
  GitHub and connect Cloudflare on the account page. Provider tokens are
  stored encrypted with `BETTER_AUTH_SECRET`. Accounts and
  sessions live in the D1 database `mob-auth`, alongside runner ownership and hashed pairing credentials. Conversation content stays on the runner.
- Passkeys are an extra way into an account that GitHub created; they never
  create an account. **Sign in with a passkey** in the sign-in dialog skips
  Turnstile (a passkey cannot be guessed or used to sign up) and opens `/app`.
  A passkey that is not bound to any account is refused with a hint to sign in
  with GitHub first. The relying party ID is the site's hostname, so passkeys
  made on `usemob.app` do not work on preview hostnames or the previous domain.
- `/account` shows the signed-in user, the connected GitHub and Cloudflare
  accounts (either can be connected there, and disconnected while the other
  still signs in) and the account's passkeys, which can be added, renamed and removed. The GitHub row
  shows the current username: the page asks GitHub once per visit with the
  stored OAuth token (Better Auth `account-info`), so a renamed account shows
  its new name, and it only says Connected when GitHub does not answer.
  Browsers do not reveal device names, so a new passkey is named after its
  provider from the authenticator's AAGUID (such as iCloud Keychain, Google
  Password Manager or Windows Hello) and is otherwise called Passkey; Apple
  often reports an anonymous AAGUID. It can be renamed. Visitors without a session go to `/?signin=account` and come back
  to `/account` after signing in. Adding a passkey needs a session less than a
  day old; with an older session the page asks the user to sign in with
  GitHub again. The landing page's account menu and the `/app` runner menu link
  to it. The page has its own entry and a content security policy that allows
  only the site itself.
- `/app` is the web UI. The Worker sends visitors without a session back to
  `/?signin=app`. With no local Mob or runner saved, `/app` runs Mob in the
  browser (see [Mob in the browser](browser-runner.md)), so a signed-in
  visitor can start talking at once. **Connect a runner** in the runner menu
  opens a dialog over the current workspace. The sidebar, selected conversation
  and draft stay in place when it is closed or a connection fails. The browser
  runner remains selected until another runner connects successfully. Choosing
  **This browser** again closes the dialog without reopening the conversation.
  Closing the dialog discards any pending connection result.
  After disconnecting a local or remote runner, the connection screen offers
  the same dialog. Choose **This browser** to reopen the browser workspace. The dialog offers **This browser**, **Your own runner** (paired runners, or the Mob address and access token of
  Mob on this computer), **Deploy to the cloud**, a free runner in the user's
  account at Render or another host (see
  [Runners in the cloud](cloud-runners.md)), and **Cloud runner**, which is
  disabled and marked coming soon. A `mob open --web` link opens the dialog to show its
  progress, and a replaced token reopens it with the reason.
- The browser keeps what each Mob showed last in IndexedDB, separately for
  each runner and local address, so a Mob it has shown before opens at once
  and then catches up; the public web also reopens the runner it last opened.
  Only the conversation list (titles) is kept by default. Messages of the 20
  most recently opened conversations are kept only after **Keep messages on
  this device** is turned on in the runner menu; turning it off forgets them.
  **Disconnect** or a rejected token forgets everything kept for that Mob.
  While Mob is unreachable, the workspace shows what was kept and says so.

## Open usemob.app with local Mob

Run `mob open --web` while Mob runs, and sign in. The site then talks to Mob
on `127.0.0.1` straight from your browser, with nothing in between.

- `mob open --web` asks the running service for a one-time pairing code and
  opens `web_url` with `#offer=` and the base64url JSON
  `{"v":1,"url":"http://127.0.0.1:8787","code":"…"}`. The fragment never reaches
  the site. The landing page holds it in session storage while you sign in;
  GitHub returns to the fixed `/?signin=done`, so the code never reaches
  Better Auth or GitHub. The landing page then removes the code from storage
  and hands it to `/app` once, which exchanges the code at `url` for the access token and keeps the
  address and token in local storage. The code, not the token, travels in the
  link because it expires after 5 minutes and works once.
- Local pairing links accept only `http://127.0.0.1` and `http://localhost`
  addresses. The `/app` content security policy permits those loopback hosts
  and the site itself for encrypted runner access; crafted local links cannot
  point at another server. The landing page may call its own site (sign-in) and
  Turnstile. It shares an origin and the sign-in with `/app`, so the
  Turnstile script, loaded only when the sign-in dialog opens, runs where the
  token is stored.
- `web_url` (`MOB_WEB_URL`) must be https, or http on a loopback host for
  development. Use `--web-url=` or `web_url: ""` to turn this off; an empty
  environment variable is ignored. The service lets that origin call the API
  and answers Chrome's Private Network Access preflight. Whoever controls the
  site's code can read the token of a browser signed in there, so only `main`
  deploys.
- Chrome and Firefox let an https page reach `http://127.0.0.1`; newer Chrome
  asks first. Safari refuses, so use `mob open` there.


## Encrypted remote runners

A runner lets a signed-in GitHub account control Mob on another computer,
without opening an inbound port on that computer. The web app lists only the
account's runners. Conversations, tools and approvals use the existing local
Mob API; the relay cannot call it without an authenticated encrypted request.

1. Sign in at `/app` and choose **Pair a runner**.
2. On the computer running Mob, run `mob runner pair`. Paste the private JSON
   shown in the browser into stdin and press Enter. Do not put it in shell
   arguments, tickets or messages: it contains the encryption key.
3. Run `mob start` (or keep `mob serve` running), then `mob runner`. Keep the
   runner process running. It actively connects to the site over WebSocket
   and reconnects after a disconnect.
4. When the runner appears online, choose **Open runner** in that browser.
   Use **Revoke access** to invalidate its cloud credential and disconnect it.
   Stopping `mob runner` also stops remote access, without stopping local Mob.

### How it is protected

The pairing code expires after five minutes and can be claimed once. The
browser generates a random 256-bit encryption key and retains it locally;
only the one-time pairing code is sent to the cloud. The CLI receives the key
through the pasted JSON, and stores it with the separate runner credential in
`runner.json` in Mob's data directory, with mode `0600`. Its local API token
never leaves the computer. A local token rotation requires restarting
`mob runner` to read the new token. Remote clients cannot mint local pairing
codes, rotate the local token or stop the local service.

Each runner has a Durable Object that forwards opaque envelopes. API methods,
paths, headers, bodies, HTTP statuses and response chunks are encrypted with
AES-256-GCM using random 96-bit nonces. Authenticated associated data binds
protocol version, runner ID, connection session, request ID, direction, chunk
sequence and final-frame status. The runner creates a fresh random session on
every connection, ignores repeated requests, and caps concurrent requests.
A request it refuses (expired, or the runner is busy) gets an encrypted error
saying it did not run; the connection and other requests carry on. Browser
clocks should be synchronized: requests expire after 45 seconds and the runner
rejects expiry times more than a minute in its future. When a browser stops
reading a response, the relay tells the runner to cancel that local request.
A local response that breaks off ends with an authenticated failure, so the
browser rejects it like a reordered, modified or incomplete response. Never
blindly retry a failed action: check saved conversation history first.

The cloud stores account and runner identifiers, hashes of pairing codes and
runner credentials, and timestamps. It can observe connection/IP metadata,
request timing and ciphertext sizes, but has no decryption keys or plaintext
conversation/tool data. HTTP request bodies are limited to 1 MiB before
encryption. A request that produces no output for six minutes fails, at the
relay and at the runner; a longer turn keeps streaming while it produces output. Disconnecting does not undo a completed tool
operation or stop an independently running conversation turn.

Keys belong to the pairing browser. Clearing its site data loses its key;
other browsers must create a new pairing. There is no cloud key recovery,
key synchronization, or forward secrecy after an endpoint key is compromised.
Revoke obsolete runner registrations; an account may have up to 20 pending
or paired runners.

**Trust boundary:** this protects content from the relay and database under
the shipped protocol. The browser still trusts JavaScript served by the site,
including future deployments and same-origin scripts. A malicious deployment
could steal its key before encryption. Protecting against a developer who
changes that JavaScript requires an independently distributed and verified
client; this web version cannot promise that protection. The local model
provider and locally configured tools still receive the data required to do
their work.

