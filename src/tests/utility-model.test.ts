import { afterEach, describe, it, expect, vi } from 'vitest';
import { APICallError, NoOutputGeneratedError, Output } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { generateUtility } from '../features/ai/utility-model';
import type { Env } from '../core/env';

afterEach(() => vi.restoreAllMocks());

function fakeModel(text?: string): MockLanguageModelV3 {
	return new MockLanguageModelV3({ doGenerate: async () => ({
		content: text === undefined ? [] : [{ type: 'text', text }],
		finishReason: { unified: text === undefined ? 'tool-calls' : 'stop', raw: undefined },
		usage: {
			inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: text === undefined ? 0 : 2, text: text === undefined ? 0 : 2, reasoning: undefined },
		},
		warnings: [],
	}) });
}

describe('generateUtility', () => {
	it('uses Flash with thinking off and reports its usage, without reading model settings', async () => {
		const model = fakeModel('summary');
		const get = vi.fn(() => { throw new Error('must not read model config'); });
		const result = await generateUtility({ CHAT_MODEL: model, STATE: { get } } as unknown as Env, { prompt: 'summarize' });
		expect(result.text).toBe('summary');
		expect(result.usage.inputTokens).toBe(5);
		expect(model.doGenerateCalls[0].providerOptions).toEqual({ deepseek: { reasoningEffort: 'none' } });
		expect(get).not.toHaveBeenCalled();
	});

	it('propagates a provider failure once without retry, fallback, or logging the request', async () => {
		const error = new APICallError({ message: 'private response', url: 'https://api.deepseek.com/chat/completions', requestBodyValues: { secret: 'private image bytes' }, statusCode: 503, isRetryable: true });
		const model = new MockLanguageModelV3({ doGenerate: async () => { throw error; } });
		const run = vi.fn();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(generateUtility({ CHAT_MODEL: model, AI: { run } } as unknown as Env, { prompt: 'summarize' })).rejects.toBe(error);
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(run).not.toHaveBeenCalled();
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/private response|private image bytes/);
	});

	it('surfaces missing structured output at the boundary with content-free diagnostics', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(generateUtility({ CHAT_MODEL: fakeModel() } as unknown as Env, {
			prompt: 'summarize', output: Output.object({ schema: z.object({ summary: z.string() }) }),
		})).rejects.toSatisfy(NoOutputGeneratedError.isInstance);
		expect(log).toHaveBeenCalledWith(expect.objectContaining({
			message: 'Utility generation failed', model: 'deepseek-flash', finishReason: 'tool-calls', outputTokens: 0, responseTextLength: 0,
		}));
	});
});
