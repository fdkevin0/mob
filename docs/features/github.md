# GitHub App (experimental)

The Mob GitHub App lets Mob watch a repository. Label an issue `mob` and Mob
proposes a plan for it in the issue's own conversation. Nothing runs until you
approve the plan. After that, the task follows its blueprint as any other task
does: the agent builds the change, Mob checks it, and you hear when it is
ready.

Your runner does the work, on your machine and with your coding agents'
subscriptions. usemob.app only receives GitHub's webhooks and hands out
short-lived tokens.

## Setup

1. Pair a runner in Mob on the web (see [Remote access](remote-access.md)), and
   keep `mob runner` running.
2. Add a clone of the repository as a project (`/projects add PATH`). Mob finds
   the project by the clone's `origin` remote.
3. On the account page at https://usemob.app/account, under **GitHub**, choose
   **Install on GitHub** and pick the repositories. Back on the account page,
   choose the runner that should watch the installation.

## Labels

| Label | What Mob does |
|---|---|
| `mob` | proposes a plan with the project's blueprint |
| `mob:BLUEPRINT`, such as `mob:quick` | proposes a plan with that blueprint |

Mob acts only when the person who added the label has write, maintain or admin
access to the repository. It checks that access with GitHub each time. It
ignores labels added by bots, including its own. Pull requests, comments that
mention the app, and checks are passed to the runner too, but Mob does not act
on them yet.

When something stops Mob, such as missing access, an unknown blueprint, no
matching project or a closed issue, the issue's conversation says why, and you
get a notice.

Mob saves each event in its own database before it acknowledges the event to
usemob.app. It then works through the saved events one at a time, including
after a restart. GitHub or usemob.app can fail in a way that may pass, such as
no answer, a timeout or a 5xx. In that case Mob tries the event again after 30
seconds, 2 minutes, 10 minutes and 30 minutes. A rate limit, which GitHub
answers with a 429 or a 403 marked as one, does not count as a try. Mob waits
until the time GitHub gives, taken from `Retry-After` or the reset time, for up
to a week after the event. Any other
failure, or the last retry failing, is reported in the issue's conversation
with a notice. Label the issue again to start over.

## What usemob.app sees

The Worker (`apps/web/worker/github.ts`) checks each webhook's
`X-Hub-Signature-256` signature and records its `X-GitHub-Delivery` ID, so a
redelivery runs only once. It keeps routing metadata only: the event and
action, the repository, the issue or pull request number, who acted and their
`author_association`, the label, the comment ID, and whether the comment names
the app. The `GitHubEvent` type is in `packages/core/src/github.ts`. Titles,
bodies and comments are never forwarded or stored.

The installation's runner gets the event over its relay connection. Events
wait in the runner's Durable Object while the runner is offline, at most 500 of
them for up to a week. They are sent again until the runner acknowledges them.
Mob records each delivery it saves, so an event sent twice runs once.

## Tokens

The app's private key never leaves the Worker. When Mob needs to call GitHub,
the runner asks `POST /api/github/token` for an installation token, using its
runner credential. The token is for one repository of an installation bound to
that runner, with only the permissions the call needs, for example
`metadata: read` to check access and `issues: read` to read the issue. The most
a runner can get is write access to contents, issues and pull requests, and
read access to checks, actions and statuses. Workflows is never granted, so no
token can change `.github/workflows`.

Tokens stay in the Mob process (`apps/mob/src/github/client.ts`). They are never
passed to coding agents or written into a worktree.

## Prompt injection

Anyone who can open an issue writes text that Mob's model reads. Mob therefore
acts only on labels from people with write access, quotes the issue as data
that must not be followed, and does nothing until you approve the plan. Coding
agents do not run in the sandbox yet. Until they do, keep the app on
repositories where you trust everyone with write access.

## Hosting the app

The app is configured with four Worker settings. `GITHUB_APP_ID` and
`GITHUB_APP_SLUG` are vars. `GITHUB_APP_PRIVATE_KEY`, the PEM that GitHub
generates (pasted with `\n` for newlines is fine), and `GITHUB_WEBHOOK_SECRET`
are secrets. Until all four are set, the GitHub section of the account page is
hidden and the endpoints answer 503.

Register the app with these settings:

- Webhook URL `https://usemob.app/api/github/webhook`, with the webhook secret
- Setup URL `https://usemob.app/api/github/setup`, which goes back to the
  account page
- Repository permissions: Contents read and write, Issues read and write, Pull
  requests read and write, Checks read, Actions read, Commit statuses read,
  Metadata read
- Events: Issues, Issue comment, Pull request, Pull request review, Pull
  request review comment, Check suite

Migration `0004_github.sql` adds the installation and delivery tables.
