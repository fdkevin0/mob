# Security policy

Mob holds model provider keys, reads your mailbox, runs commands in a sandbox
and can be reached remotely, so we take reports about it seriously.

## Reporting a vulnerability

Report privately through
[GitHub's private vulnerability reporting](https://github.com/fdkevin0/mob/security/advisories/new).
Please do not open a public issue, pull request or discussion for a
vulnerability.

Include what you can of:

- the affected part (see Scope) and version (`mob --version`, or the date you
  used usemob.app);
- steps to reproduce, or a proof of concept;
- what an attacker gains and what they need first (for example, a local
  account, a malicious MCP server, or a crafted email).

Mob is maintained by one person. You should get an answer within 7 days; we
agree on a fix and a disclosure date with you, and credit you in the advisory
unless you would rather not be named.

## Supported versions

| Version | Supported |
| --- | --- |
| The latest stable release (`npm install -g usemob@latest`) | Yes |
| The latest nightly (`usemob@nightly`) | Yes |
| Older releases | No; upgrade first |

## Scope

In scope:

- the `mob` program and its npm packages (`usemob`, `@usemob/*`), the release
  archives and the desktop app;
- the local service: its HTTP API, access tokens, pairing, approvals and
  remembered grants, the sandbox, and the plugins and channels in this
  repository;
- usemob.app: the web app, sign-in, the account page, the encrypted runner
  relay and the Workers AI route.

Out of scope:

- model providers, MCP servers, skills and coding agents that you add
  yourself, except where Mob fails to enforce an approval, a sandbox limit or
  another protection it documents;
- what a model chooses to say or do within the tools you approved;
- attacks that need an account on your machine with access to Mob's data
  directory.

How approvals, the sandbox and remote access are meant to behave is described in
[tools and approvals](docs/features/tools-and-approvals.md),
[sandbox](docs/features/sandbox.md) and
[remote access](docs/features/remote-access.md).
