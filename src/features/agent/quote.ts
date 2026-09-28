/**
 * **Quoted reply** (PRD #72, docs/adr/0015). When a Telegram message is a reply,
 * the Conversation Agent prepends the quoted message to the turn's user text so
 * the model knows what is being replied to. Pure and structural — the test seam
 * lives here; `onTelegramMessage` is the thin caller.
 */

import type { RichMessage } from 'telegram-bot-api-types';
import { richMessageToMarkdown } from '../rich-message/reader';

/** The minimal shape `buildQuotedText` reads — kept local so it doesn't depend on
 * the telegram type lib carrying the (newer) `quote` / `rich_message` fields. */
export interface QuotableMessage {
	/** The span the user highlighted when replying (Bot API 6.7+). */
	quote?: { text?: string } | null;
	reply_to_message?: {
		text?: string;
		caption?: string;
		/** Present when replying to a bot's **Inbound Rich Message** (Bot API 10.1, docs/adr/0010). */
		rich_message?: RichMessage | null;
	} | null;
}

/**
 * The quoted text for a reply, by precedence: the user's highlighted `quote.text`,
 * else the replied message's `text`, else its `caption`, else — when replying to a
 * bot's answer — the **Inbound Rich Message** flattened to Markdown by the **Rich
 * Message reader**. Returns `null` when none exists (e.g. a reply to pure media) so
 * the caller treats it as a normal message.
 */
export function buildQuotedText(message: QuotableMessage): string | null {
	const reply = message.reply_to_message;
	return message.quote?.text || reply?.text || reply?.caption || (reply?.rich_message ? richMessageToMarkdown(reply.rich_message) : '') || null;
}

/** Compose the turn's user text: the quoted block (`>`-prefixed) then the message. */
export function prependQuote(quoted: string, userText: string): string {
	const block = '> ' + quoted.replaceAll('\n', '\n> ');
	return `${block}\n\n${userText}`;
}
