import { DEFAULT_CHAT_MODEL } from '../features/ai/model';
import { Env } from '../core/env';
import { ForwardableEmailMessage } from '@cloudflare/workers-types';
import PostalMime, { Email, type Address } from 'postal-mime';
import { z } from 'zod';
import { Bot } from '../core/bot';
import { createDocument } from '@mixmark-io/domino';
import { Output, type ModelMessage } from 'ai';
import { MAX_RESPONSE_TOKENS } from '../features/ai/model';
import { generateUtility } from '../features/ai/utility-model';
import type { HtmlParserKind } from '../features/ai/global-config';
import { convertViaTurndown, convertViaWorkersAiMarkdown } from '../utils/html-to-markdown';
import type { UsageLike } from '../features/agent/usage-ledger';
import { replyCallbackData } from '../features/email/reply';

const triageSchema = z.object({
	level: z.enum(['low', 'medium', 'high']),
	category: z.enum(['normal', 'spam', 'captcha', 'trade', 'other']),
	summary: z.string(),
});

type AIResponse = z.infer<typeof triageSchema>;

// Constants for better maintainability
const MAX_EMAIL_CHARS = 24000;
const MAX_SUMMARY_TOKENS = 200;
const MAX_TELEGRAM_LENGTH = 4096;
const DEFAULT_SUBJECT = 'No subject';
const DEFAULT_CONTENT = 'No content';

const escapeMarkdown = (text: string): string => text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

function formatAddress(address?: Address | null): string {
	if (!address) return 'Unknown';
	const name = address.name || '';
	if (address.address) return name ? `${name} <${address.address}>` : address.address;
	return name || 'Unknown';
}

/** One triage call's ledger record, handed to the caller-injected recorder (docs/adr/0041). */
export interface TriageUsageRecord {
	kind: 'email_triage';
	model: string;
	usage: UsageLike;
}

export interface EmailTriageOptions {
	emailId?: number | null;
	language?: string | null;
	adminChatId?: number;
	recordUsage?: (record: TriageUsageRecord) => void;
	htmlParser?: HtmlParserKind;
}

export async function handleEmailMessage(message: ForwardableEmailMessage, env: Env, options: EmailTriageOptions = {}) {
	const { emailId, language = null, adminChatId, recordUsage, htmlParser = 'turndown' } = options;
	const notifyChatId = adminChatId ?? env.TELEGRAM_ADMIN_ID;
	try {
		const email = await PostalMime.parse(message.raw);
		console.info({ message: 'Received email', feature: 'email', to: message.to, from: message.from, subject: email.subject });

		const content = await extractContent(email, env, language, htmlParser, recordUsage);
		return await sendMessageToUser(email, content, env, emailId, message.to, notifyChatId);
	} catch (error) {
		// Utility generation logs model diagnostics; this record adds email context.
		console.error({
			message: 'Error processing email',
			feature: 'email',
			htmlParser,
			hasLanguagePreference: language != null,
			error,
		});
		await sendErrorNotification(error, env, notifyChatId);
	}
}

/**
 * Convert an HTML email body to Markdown for the triage prompt, mirroring the
 * `fetch_url` tool's `'turndown' | 'ai'` switch (docs/adr/0045). `'turndown'`
 * (default) is deterministic, free, and fast; `'ai'` delegates to
 * `env.AI.toMarkdown` for richer table preservation — pay-per-image-caption
 * and higher latency, but falls back to turndown on any error or `format:
 * 'error'` so triage is never blocked by the converter.
 *
 * `<table>` is **not** stripped (the old cheerio-text path dropped it,
 * losing every order-receipt table); turndown defaults flatten cells, `'ai'`
 * preserves the table as Markdown.
 */
async function processEmailContent(email: Email, env: Env, htmlParser: HtmlParserKind): Promise<string> {
	// Early return for empty content
	if (!email.text && !email.html) {
		return DEFAULT_CONTENT;
	}

	// Use text content if available — already plain text, no conversion needed.
	if (email.text) {
		return truncateByChars(email.text);
	}

	if (email.html) {
		const doc = createDocument(email.html);
		for (const element of Array.from(doc.querySelectorAll('script, style, noscript'))) element.remove();
		// `<table>` deliberately kept (docs/adr/0045): turndown flattens cells,
		// `'ai'` preserves the table as Markdown — both beat the old drop.
		const html = doc.body.innerHTML || email.html;
		const markdown = htmlParser === 'ai' && env.AI ? await convertEmailViaWorkersAi(env, html) : await convertViaTurndown(html);
		return truncateByChars(markdown);
	}

	return DEFAULT_CONTENT;
}

/**
 * Workers AI `toMarkdown` path — richer table/list preservation, but each
 * `<img>` (incl. base64 + tracking pixels) triggers image-caption models
 * (paid). Falls back to turndown on error / `format: 'error'` so triage
 * never blocks on the converter.
 */
async function convertEmailViaWorkersAi(env: Env, html: string): Promise<string> {
	try {
		const markdown = await convertViaWorkersAiMarkdown(env.AI, html, 'email.html', true);
		if (markdown !== null) return markdown;
		// 'error' or missing: fall through to turndown below.
		console.warn({ message: 'env.AI.toMarkdown returned non-markdown for email HTML; falling back to turndown', feature: 'email' });
	} catch (error) {
		console.warn({ message: 'env.AI.toMarkdown threw on email HTML; falling back to turndown', feature: 'email', error });
	}
	return convertViaTurndown(html);
}

/** Character-heuristic ceiling (docs/adr/0045): bounds the text sent for email classification. */
function truncateByChars(text: string): string {
	if (text.length <= MAX_EMAIL_CHARS) return text;
	return `${text.slice(0, MAX_EMAIL_CHARS)}\n\n[Content too long — HTML content truncated]`;
}

async function extractContent(
	email: Email,
	env: Env,
	language: string | null,
	htmlParser: HtmlParserKind,
	recordUsage?: (record: TriageUsageRecord) => void,
): Promise<AIResponse> {
	// Input validation and content processing
	const subject = email.subject || DEFAULT_SUBJECT;
	const processedContent = await processEmailContent(email, env, htmlParser);

	// Unset → summarize in the email's own language (docs/adr/0025, replacing the
	// former hardcoded Chinese); a set preference overrides it.
	const languageClause = language ? `in ${language}` : "in the email's own language";

	// AI SDK v7 (docs/adr/0041): the system preamble moves out of `messages`
	// into the `instructions` option — system-role entries in `messages` are
	// now rejected at the standardizePrompt boundary.
	const instructions = `Email analysis assistant. Tasks:
1. Analyze importance and categorize:
   - high: urgent/security
   - medium: regular updates
   - low: newsletters/marketing
2. Categories: normal, spam, captcha, trade, other
3. Provide a concise summary of the email content ${languageClause} (max ${MAX_SUMMARY_TOKENS} chars)

Return only a JSON object with exactly three fields: "level" (one of the importance levels above), "category" (one of the categories above), and "summary" (a string).
Example JSON output:
{"level":"low","category":"normal","summary":"A routine update."}
Do not include Markdown fences or text outside the JSON object.`;
	const messages: ModelMessage[] = [
		{
			role: 'user',
			content: `Analyze the email below and classify it.

Email:
From: ${formatAddress(email.from)}
Subject: ${subject}
Content: ${processedContent}

Guidelines:
- Keep summary concise (${languageClause}, max ${MAX_SUMMARY_TOKENS} tokens)
- Focus on main message
- Ignore HTML formatting
- Contain Verificaion Code/Link if it's a captcha email`,
		},
	];

	const t0 = Date.now();
	// Validate the verdict at generation time so malformed output reaches the error path.
	const result = await generateUtility(
		env,
		{
			instructions,
			messages,
			output: Output.object({ schema: triageSchema }),
			maxOutputTokens: MAX_RESPONSE_TOKENS,
		},
		{ functionId: 'email.triage' },
	);
	// Re-parsed to recover the *type*: the utility helper's cast erases the output
	// generic, so `result.output` arrives as `any`.
	const aiResponse: AIResponse = triageSchema.parse(result.output);
	// Best-effort accounting (PRD #103): a broken recorder must never fail the
	// triage that produced the tokens.
	try {
		recordUsage?.({ kind: 'email_triage', model: DEFAULT_CHAT_MODEL, usage: result.usage });
	} catch (error) {
		console.warn({ message: 'Email triage usage recording failed', feature: 'email', error });
	}
	// Scalar telemetry only: never log the full AI response or email body.
	console.info({
		message: 'AI email triage response',
		feature: 'email',
		responseMs: Date.now() - t0,
		triageLevel: aiResponse?.level,
		category: aiResponse?.category,
	});

	return aiResponse;
}

// `recipient` is the envelope recipient (the alias the mail arrived at) — with the
// catch-all domain it identifies who used the address and is what
// a ✉️ Reply will be sent From, so it goes in the DM alongside the parsed headers.
async function sendMessageToUser(
	email: Email,
	content: AIResponse,
	env: Env,
	emailId: number | null | undefined,
	recipient: string,
	notifyChatId: number,
) {
	if (!email.to) throw new Error('Missing recipient information');

	const bot = new Bot(env, []);

	// Check if this is direct text content (not AI summary)
	const isDirectText = email.text && content.summary === email.text;

	// Truncate content if it's too long for Telegram (max 4096 chars)
	let displayContent = content.summary;
	if (displayContent.length > MAX_TELEGRAM_LENGTH) {
		displayContent = displayContent.substring(0, MAX_TELEGRAM_LENGTH - 100) + '\n\n[Content truncated due to length]';
	}

	// Format the message with proper MarkdownV2 escaping
	const formattedMessage = [
		`*Title*`,
		escapeMarkdown(email.subject || DEFAULT_SUBJECT),
		``,
		`*From*`,
		escapeMarkdown(formatAddress(email.from)),
		``,
		`*To*`,
		escapeMarkdown(recipient),
		``,
		isDirectText ? `*Full Content*` : `*Summary*`,
		escapeMarkdown(displayContent),
	].join('\n');

	// Refer the email into chat. All buttons carry the stored email id:
	// ✉️ Reply arms a threaded reply (docs/adr/0009); 💬 Ask saves the body as a
	// `document` asset and starts a turn about it (docs/adr/0018); 🔍 View opens
	// the Settings Mini App's Email detail screen as a `web_app` button
	// (docs/adr/0035) —
	// omitted unless the Mini App base URL is configured, so the DM never
	// shows a button that can't work (the web_search-gating precedent).
	const previewUrl =
		emailId != null && env.MINIAPP_BASE_URL ? `${env.MINIAPP_BASE_URL}/miniapp/settings?screen=email&id=${emailId}` : undefined;
	const reply_markup =
		emailId != null
			? {
					inline_keyboard: [
						[
							{ text: '✉️ Reply', callback_data: replyCallbackData.reply(emailId) },
							{ text: '💬 Ask', callback_data: replyCallbackData.ask(emailId) },
							...(previewUrl ? [{ text: '🔍 View', web_app: { url: previewUrl } }] : []),
						],
					],
				}
			: undefined;

	await bot.sendMessage({
		chat_id: notifyChatId,
		text: formattedMessage,
		parse_mode: 'MarkdownV2',
		disable_notification: content.level === 'low',
		...(reply_markup ? { reply_markup } : {}),
	});
}

async function sendErrorNotification(error: unknown, env: Env, notifyChatId: number) {
	try {
		const bot = new Bot(env, []);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		await bot.sendMessage({
			chat_id: notifyChatId,
			text: `Error processing email: ${errorMessage}\n\nModel: ${DEFAULT_CHAT_MODEL}`,
		});
	} catch (sendError) {
		console.error({ message: 'Failed to send error notification', feature: 'email', error: sendError });
	}
}
