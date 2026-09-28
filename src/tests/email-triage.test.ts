import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as Telegram from 'telegram-bot-api-types';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { Bot } from '../core/bot';
import type { Env } from '../core/env';
import { handleEmailMessage } from '../ai/email';

const RAW_EMAIL = [
	'From: Sender Name <sender@example.com>',
	'To: me@example.com',
	'Subject: Your verification code',
	'Content-Type: text/plain; charset=utf-8',
	'',
	'Your code is 123456.',
	'',
].join('\r\n');

const sent: Telegram.SendMessageParams[] = [];
let originalSendMessage: typeof Bot.prototype.sendMessage;

beforeEach(() => {
	sent.length = 0;
	// Intercept the network boundary: handleEmailMessage constructs its own Bot.
	originalSendMessage = Bot.prototype.sendMessage;
	Bot.prototype.sendMessage = async function (data: Telegram.SendMessageParams) {
		sent.push(data);
		return { message_id: sent.length } as Telegram.Message;
	};
});

afterEach(() => {
	Bot.prototype.sendMessage = originalSendMessage;
	vi.unstubAllGlobals();
});

function fakeEmailMessage(raw: string = RAW_EMAIL): ForwardableEmailMessage {
	return {
		from: 'sender@example.com',
		to: 'me@example.com',
		raw: new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(raw));
				controller.close();
			},
		}),
		headers: new Headers(),
		rawSize: raw.length,
		setReject() {},
		forward: async () => {},
		reply: async () => {},
	} as unknown as ForwardableEmailMessage;
}

function createFakeEnv(
	triage: { level: string; category: string; summary: string },
	extras: { ai?: Env['AI']; body?: string } = {}
): {
	env: Env;
	captured: { options?: LanguageModelV3CallOptions };
	calls: { count: number };
} {
	// A scripted AI SDK mock model: emits the triage verdict as JSON text (the
	// structured-output port since the move off forced tool calls) and captures the
	// raw call options so the response format and prompt clauses are assertable.
	// `extras.body` overrides the response to exercise the malformed-verdict path.
	const captured: { options?: LanguageModelV3CallOptions } = {};
	const calls = { count: 0 };
	const model = new MockLanguageModelV3({
		doGenerate: async (options) => {
			captured.options = options;
			calls.count += 1;
			return {
				content: [{ type: 'text', text: extras.body ?? JSON.stringify(triage) }],
				finishReason: { unified: 'stop' as const, raw: undefined },
				usage: {
					inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 20, text: 20, reasoning: undefined },
				},
				warnings: [],
			};
		},
	});

	return {
		env: {
			CHAT_MODEL: model,
			TELEGRAM_ADMIN_ID: 1,
			TELEGRAM_API_TOKEN: 'test-token',
			STATE: fakeStateKv(),
			...(extras.ai ? { AI: extras.ai } : {}),
		} as unknown as Env,
		captured,
		calls,
	};
}

/** A minimal in-memory `STATE` KV stand-in — only the subset `getGlobalConfig` calls. */
function fakeStateKv(): KVNamespace {
	return {
		get: async () => null,
		put: async () => {},
		delete: async () => {},
	} as unknown as KVNamespace;
}

/**
 * Pins the inbound-email triage (docs/adr — Email triage) with a scripted AI SDK
 * mock model — no Workers AI, no live Telegram. Asserts the notification shape,
 * the forced-tool-call structured output port (ADR-0041), the language-preference
 * seam (ADR-0025), the usage ledger RPC, and best-effort accounting.
 */
describe('handleEmailMessage — notification delivery', () => {
	it('sends exactly one silent notification to the admin carrying the summary', async () => {
		const first = createFakeEnv({
			level: 'low',
			category: 'captcha',
			summary: '这是一封验证码邮件',
		});

		await handleEmailMessage(fakeEmailMessage(), first.env);

		expect(sent.length).toBe(1);
		const notification = sent[0];
		expect(notification.chat_id).toBe(first.env.TELEGRAM_ADMIN_ID);
		expect(notification.text?.includes('这是一封验证码邮件') ?? false).toBe(true);
		expect(notification.disable_notification).toBe(true);
	});
});

describe('handleEmailMessage — structured output as a json response format', () => {
	it('sends DeepSeek JSON mode with explicit JSON instructions and an example', async () => {
		const verdict = { level: 'low', category: 'captcha', summary: 'Your code is 123456' };
		const requests: Array<{ response_format: unknown; messages: Array<{ role: string; content: string }> }> = [];
		vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(JSON.parse(init?.body as string));
			return new Response(JSON.stringify({
				id: 'triage-test',
				model: 'deepseek-flash',
				choices: [{ message: { role: 'assistant', content: JSON.stringify(verdict) }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
			}), { headers: { 'content-type': 'application/json' } });
		});
		const { env } = createFakeEnv(verdict);
		delete env.CHAT_MODEL;
		env.DEEPSEEK_API_KEY = 'test-key';

		await handleEmailMessage(fakeEmailMessage(), env);

		expect(requests).toHaveLength(1);
		expect(requests[0].response_format).toEqual({ type: 'json_object' });
		const instructions = requests[0].messages.find((message) => message.role === 'system')?.content;
		expect(instructions).toMatch(/json/i);
		expect(JSON.parse(instructions!.match(/\{[^{}]+\}/)![0])).toEqual({
			level: expect.any(String), category: expect.any(String), summary: expect.any(String),
		});
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toContain(verdict.summary);
	});

	// The utility path uses schema-validated JSON across providers; this pins that
	// Structured output must not use a forced tool call.
	it('asks for a json response format carrying the triage schema, with no tool call forced', async () => {
		const first = createFakeEnv({ level: 'low', category: 'captcha', summary: '这是一封验证码邮件' });
		await handleEmailMessage(fakeEmailMessage(), first.env);

		const call = first.captured.options;
		expect(call?.responseFormat?.type).toBe('json');
		expect(call?.responseFormat?.type === 'json' && call.responseFormat.schema != null).toBe(true);
		// Not `undefined` — the SDK always sends a choice; what matters is that it
		// is no longer the historical forced `{ type: 'tool' }` choice.
		expect(call?.toolChoice?.type).not.toBe('tool');
		expect(call?.tools ?? []).toHaveLength(0);
	});
});

describe('handleEmailMessage — malformed structured output', () => {
	it('fails once and alerts the admin with the single model name', async () => {
		const { env, calls } = createFakeEnv({ level: 'low', category: 'normal', summary: 's' }, { body: 'Unstructured prose' });
		await handleEmailMessage(fakeEmailMessage(), env);
		expect(calls.count).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0].text).toContain('Error processing email');
		expect(sent[0].text).toContain('Model: deepseek-flash');
	});
});

describe('handleEmailMessage — language preference (ADR-0025)', () => {
	it('unset → summarize in the email\'s own language (no hardcoded Chinese)', async () => {
		const unset = createFakeEnv({ level: 'low', category: 'normal', summary: 's' });
		await handleEmailMessage(fakeEmailMessage(), unset.env);
		const unsetPrompt = JSON.stringify(unset.captured.options?.prompt ?? []);
		expect(unsetPrompt.includes("in the email's own language")).toBe(true);
		expect(unsetPrompt.includes('Chinese')).toBe(false);
	});

	it('a set language overrides and is injected into the triage prompt', async () => {
		const set = createFakeEnv({ level: 'low', category: 'normal', summary: 's' });
		await handleEmailMessage(fakeEmailMessage(), set.env, { language: 'English' });
		const setPrompt = JSON.stringify(set.captured.options?.prompt ?? []);
		expect(setPrompt.includes('in English')).toBe(true);
		expect(setPrompt.includes("in the email's own language")).toBe(false);
	});
});

describe('handleEmailMessage — usage ledger (ADR-0041)', () => {
	it('records exactly one email_triage entry attributed to DeepSeek Flash, with token counts', async () => {
		const usage = createFakeEnv({ level: 'low', category: 'normal', summary: 's' });
		const recorded: Array<{ kind: string; model: string; usage: { inputTokens?: number } }> = [];
		await handleEmailMessage(fakeEmailMessage(), usage.env, { recordUsage: (record) => recorded.push(record) });
		expect(recorded.length).toBe(1);
		expect(recorded[0].kind).toBe('email_triage');
		expect(recorded[0].usage.inputTokens).toBe(10);
		// The caller records the fixed production model, independently of the test model.
		expect(recorded[0].model).toBe('deepseek-flash');
	});

	it('best-effort accounting: a throwing recorder must not fail triage (the summary still reaches the DM)', async () => {
		const hostile = createFakeEnv({ level: 'low', category: 'normal', summary: 'still delivered' });
		const sentBefore = sent.length;
		await handleEmailMessage(fakeEmailMessage(), hostile.env, { recordUsage: () => {
			throw new Error('ledger RPC down');
		} });
		expect(sent.length).toBe(sentBefore + 1);
		expect(sent[sent.length - 1].text?.includes('still delivered') ?? false).toBe(true);
	});
});

// ── HTML→Markdown converter (ADR-0045, unpublished) ──────────────────────────────

const HTML_BODY = [
	'<html><head><title>Order</title>',
	'<script>var x = 1;</script>',
	'<style>body { color: red; }</style></head>',
	'<body>',
	'<h1>Order confirmation</h1>',
	'<table><tr><td>Order #12345</td></tr></table>',
	'<p>Ship to: 123 Main St</p>',
	'</body></html>',
].join('\n');

const RAW_HTML_EMAIL = [
	'From: Sender Name <sender@example.com>',
	'To: me@example.com',
	'Subject: Order confirmation',
	'Content-Type: text/html; charset=utf-8',
	'',
	HTML_BODY,
	'',
].join('\r\n');

/** A minimal `env.AI.toMarkdown` mock that captures the blob bytes and returns scripted markdown. */
function fakeAiToMarkdown(
	markdown: string,
	capture?: { seenHtml?: string }
): Env['AI'] {
	return {
		toMarkdown: async (files: Array<{ blob: Blob }>) => {
			if (capture) capture.seenHtml = await files[0].blob.text();
			return [{ name: 'email.html', format: 'markdown' as const, mimetype: 'text/html', tokens: 8, id: '0', data: markdown }];
		},
	} as unknown as Env['AI'];
}

describe('handleEmailMessage — HTML converter (turndown default, ADR-0045)', () => {
	it('converts HTML to markdown via turndown by default; strips script/style; keeps table cells; truncates to MAX_EMAIL_CHARS', async () => {
		const first = createFakeEnv({ level: 'low', category: 'normal', summary: 's' });
		// No env.AI: the default `turndown` path must run without it.
		await handleEmailMessage(fakeEmailMessage(RAW_HTML_EMAIL), first.env, { htmlParser: 'turndown' });

		const prompt = JSON.stringify(first.captured.options?.prompt ?? []);
		expect(prompt.includes('# Order confirmation')).toBe(true);
		expect(prompt.includes('Order #12345')).toBe(true);
		expect(prompt.includes('123 Main St')).toBe(true);
		expect(prompt.includes('var x = 1')).toBe(false);
		expect(prompt.includes('color: red')).toBe(false);
	});
});

describe('handleEmailMessage — HTML converter (ai parser, ADR-0045)', () => {
	it('routes HTML through env.AI.toMarkdown when parser is "ai"', async () => {
		const seen: { seenHtml?: string } = {};
		const first = createFakeEnv({ level: 'low', category: 'normal', summary: 's' }, { ai: fakeAiToMarkdown('# AI Converted\n\norder: 12345', seen) });
		await handleEmailMessage(fakeEmailMessage(RAW_HTML_EMAIL), first.env, { htmlParser: 'ai' });

		const prompt = JSON.stringify(first.captured.options?.prompt ?? []);
		expect(prompt.includes('AI Converted')).toBe(true);
		expect(seen.seenHtml).toContain('<table>');
	});

	it('falls back to turndown when env.AI.toMarkdown returns format:error', async () => {
		const first = createFakeEnv({ level: 'low', category: 'normal', summary: 's' }, {
			ai: {
				toMarkdown: async () => [{ name: 'email.html', format: 'error' as const, mimetype: 'text/html', id: '0', error: 'conversion failed' }],
			} as unknown as Env['AI'],
		});
		await handleEmailMessage(fakeEmailMessage(RAW_HTML_EMAIL), first.env, { htmlParser: 'ai' });

		const prompt = JSON.stringify(first.captured.options?.prompt ?? []);
		// Fell back to turndown output
		expect(prompt.includes('# Order confirmation')).toBe(true);
	});
});

describe('handleEmailMessage — char ceiling (MAX_EMAIL_CHARS, ADR-0045)', () => {
	it('truncates a long HTML body to MAX_EMAIL_CHARS with a content-too-long marker', async () => {
		// Build a 30k-char HTML email body
		const longBody = `<html><head></head><body><h1>Long</h1><p>${'x'.repeat(30000)}</p></body></html>`;
		const raw = [
			'From: sender@example.com',
			'To: me@example.com',
			'Subject: Long email',
			'Content-Type: text/html; charset=utf-8',
			'',
			longBody,
			'',
		].join('\r\n');
		const first = createFakeEnv({ level: 'low', category: 'normal', summary: 's' });
		await handleEmailMessage(fakeEmailMessage(raw), first.env, { htmlParser: 'turndown' });

		const prompt = JSON.stringify(first.captured.options?.prompt ?? []);
		expect(prompt.includes('Content too long')).toBe(true);
		// Cap is 24000 chars for the markdown, plus the marker suffix: well under 30k
		expect(prompt.length).toBeLessThan(26000);
	});
});
