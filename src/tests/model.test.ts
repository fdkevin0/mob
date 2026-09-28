import { historyToModelMessages } from '../features/ai/session-messages';
import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../core/env';
import {
	DEEPSEEK_BASE_URL,
	DEFAULT_CHAT_MODEL,
	resolveModel,
	transformDeepSeekRequestBody,
} from '../features/ai/model';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('DeepSeek built-in provider', () => {
	it('uses the official endpoint and native vision model', () => {
		expect(DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com');
		expect(DEFAULT_CHAT_MODEL).toBe('deepseek-flash');
	});

	it('translates the shared off value into DeepSeek Chat Completions thinking control', () => {
		const original = { model: 'deepseek-flash', reasoning_effort: 'none', messages: [] };
		expect(transformDeepSeekRequestBody(original)).toEqual({
			model: 'deepseek-flash',
			messages: [],
			thinking: { type: 'disabled' },
		});
		expect(original).toHaveProperty('reasoning_effort', 'none');
	});

	it('leaves supported reasoning efforts unchanged', () => {
		const body = { model: 'deepseek-flash', reasoning_effort: 'high' };
		expect(transformDeepSeekRequestBody(body)).toBe(body);
	});

	it('builds an authenticated official Chat Completions request from the Env binding', async () => {
		const captured: { request?: Request } = {};
		vi.stubGlobal(
			'fetch',
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				captured.request = new Request(input, init);
				return new Response(
					JSON.stringify({
						id: 'response-1',
						model: 'deepseek-flash',
						choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}) as typeof fetch
		);

		const env = { DEEPSEEK_API_KEY: 'test-deepseek-key' } as Env;
		const resolved = await resolveModel(env, 'off');
		const result = await generateText({
			model: resolved.model,
			messages: await historyToModelMessages([{ id: 'image', role: 'user', parts: [
				{ type: 'text', text: 'What is in the picture?' },
				{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' },
			] }]),
			providerOptions: resolved.providerOptions,
			maxRetries: 0,
		});

		expect(result.text).toBe('ok');
		expect(captured.request?.url).toBe('https://api.deepseek.com/chat/completions');
		expect(captured.request?.headers.get('authorization')).toBe('Bearer test-deepseek-key');
		const body = (await captured.request?.json()) as Record<string, unknown>;
		expect(body.model).toBe('deepseek-flash');
		expect(body.messages).toEqual([{ role: 'user', content: [
			{ type: 'text', text: 'What is in the picture?' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
		] }]);
		expect(body.thinking).toEqual({ type: 'disabled' });
		expect(body).not.toHaveProperty('reasoning_effort');
	});
});
