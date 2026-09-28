# Email triage

Inbound email is classified by the model and posted to the admin's Telegram
chat as a summary with action buttons. The mail pipeline itself (receiving,
storage and the reply flow) is unpublished; this repository contains the AI
step and the Mini App preview.

## How it works

1. The body is prepared for the prompt:
   - Plain text is used as-is.
   - HTML has `script`, `style` and `noscript` removed and is converted to
     Markdown with the **global** HTML parser setting. Tables are kept.
2. [`generateUtility`](../../src/features/ai/utility-model.ts) calls the model
   with `Output.object` and this schema:

   | Field | Values |
   | --- | --- |
   | `level` | `low` (newsletters, marketing), `medium` (regular updates), `high` (urgent or security) |
   | `category` | `normal`, `spam`, `captcha`, `trade`, `other` |
   | `summary` | Short summary in the chat's language, or the email's language if none is set |

3. The notification includes these buttons:
   - **✉️ Reply**: starts a threaded reply
   - **💬 Ask**: saves the body as a document and starts a turn about it
   - **🔍 View**: opens the [Mini App](mini-app.md) email detail screen. Shown
     only when `MINIAPP_BASE_URL` is set.
4. Token usage is recorded as `email_triage` in the admin chat's
   [usage ledger](debugging-and-usage.md) through an RPC to its agent. A
   failure to record usage never fails triage.

### HTML parser

| Parser | Behavior |
| --- | --- |
| `turndown` (default) | Deterministic, free, fast; table cells are flattened |
| `ai` | Workers AI `toMarkdown`; keeps tables as Markdown. Each image may trigger paid captioning. Falls back to turndown on any error |

An admin sets this in Mini App → Settings → Global service.

## Limits

| Limit | Value |
| --- | --- |
| Body text sent to the model | 24,000 characters |
| Summary length | 200 characters (instructed) |
| Telegram notification | 4,096 characters |

## Design decisions

- **The shared AI SDK with a schema.** Triage uses `Output.object` instead of
  the earlier forced-tool-call workaround, and failures are passed to the
  caller ([ADR-0041](../adr/0041-unify-ai-frameworks-on-ai-sdk.md)).
- **The ledger lives in the chat's agent.** This avoids a second, global
  accounting store. The actual resolved model ID is recorded.
- **Converters are switchable.** This choice is recorded in ADR-0045, which
  isn't published.

## Source

- [`src/ai/email.ts`](../../src/ai/email.ts): content preparation, the prompt
  and the notification
- [`html-to-markdown.ts`](../../src/utils/html-to-markdown.ts),
  [`global-config.ts`](../../src/features/ai/global-config.ts)
- Tests: `email-triage`, `global-config` in [`src/tests/`](../../src/tests/)
