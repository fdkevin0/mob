# Plugins: email and Cloudflare

Plugins are optional connections configured in **Plugins & cloud services** in
the GUI (also available before model setup), or with **Ctrl+P** / `/plugins` in
the TUI. Telegram, WeChat iLink and answering mail are covered in
[Messaging channels](channels.md); the MCP and Skills market tabs in
[MCP servers](mcp.md#web-management) and [Skills](skills.md#web-management-and-installation). How a
plugin is built is in [Extensions](extensions.md).

## Settings and secrets

- Plugin settings are stored in the local SQLite database. Saving applies
  immediately; no restart is needed. Disable a plugin before removing a required
  credential.
- A blank password keeps the saved value for the same account or host. Changing
  a mail host or username, or the Cloudflare account, requires credentials again.
- API clients update secrets explicitly with
  `secrets: {"token": {"mode": "keep|replace|clear", "value": "..."}}`. Mail uses
  `imap.password`/`smtp.password`; Cloudflare also accepts `secretKey`. Keeping a
  secret after changing its owner is rejected. The TUI has
  `/clear-secret PLUGIN FIELD`.
- Clients only ever see masked presence flags. The database is unencrypted, with
  0600 permissions and credentials inside; protect its backups accordingly.
- `/test PLUGIN` tests a saved connection.

## Email (SMTP / IMAP)

Enable Email, set the From address and separate IMAP and SMTP hosts, ports,
usernames and app passwords, then **Test saved configuration**. Implicit TLS and
STARTTLS both verify certificates; plaintext authentication is not offered.
Typical ports: IMAP 993 (TLS) or 143 (STARTTLS); SMTP 465 (TLS) or 587
(STARTTLS).

- **Inbox** shows the newest 50 messages. Messages are read by UID and
  UIDVALIDITY with `BODY.PEEK`, so they stay unread, and previews are limited to
  2 MiB per message. MIME text is decoded; HTML-only mail becomes plain text
  without loading remote images or scripts. Attachment names are shown, not
  downloaded.
- **Analyze with AI** sends one message's text to the model for importance,
  category and summary. It never runs tool calls.
- **Compose / reply** opens a draft; **Review email → Send email** sends it. The
  same attempt cannot send twice, and an uncertain SMTP outcome is not retried;
  check delivery logs before a new attempt. No copy is appended to an IMAP Sent
  folder.
- The model can use the mailbox through the `email_inbox`, `email_read` and
  `email_send` tools; sending waits for [approval](tools-and-approvals.md).
- TUI: `/email` lists messages, `/email UID VALIDITY` reads one,
  `/email analyze UID VALIDITY` analyzes it, and `/mail` opens the send wizard
  (one paragraph; use the GUI for multi-line mail).

## Cloudflare

Configure an **API Token** scoped to the account and the operations you need,
the **Account ID**, and the resource IDs for the services you use.

| Service | What Mob does |
| --- | --- |
| Workers AI | list models, run a prompt |
| Vectorize | list indexes, query one with Workers AI embeddings (use the model and dimensions the index was built with) |
| D1 | list databases, run the SQL given, with optional parameters |
| KV | list namespaces, read a key |
| R2 | list buckets with the API token; list objects and preview up to 1 MiB with R2 S3 credentials |

- R2 object access needs an **R2 S3 Access Key ID and Secret Access Key**; an API
  token alone does not authorize S3 requests. Object lists return up to 100
  entries with a cursor; other lists show the provider's first page.
- D1 runs exactly the SQL entered, writes included, and AI operations can incur
  charges. When the model calls the `cloudflare` tool, anything but a single D1
  `SELECT` waits for approval.
- Workers AI is used for chat by adding it as a custom
  [provider](providers.md), not through this plugin.
- TUI and web: `/cloud ai.models`, `/cloud ai.run TEXT`, `/cloud vectorize.indexes`,
  `/cloud vectorize.query TEXT`, `/cloud d1.databases`, `/cloud d1.query SQL`,
  `/cloud kv.namespaces`, `/cloud kv.get KEY`, `/cloud r2.buckets`,
  `/cloud r2.list`, `/cloud r2.get KEY`.

References: [Workers AI](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/),
[Vectorize](https://developers.cloudflare.com/api/resources/vectorize/),
[R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).
