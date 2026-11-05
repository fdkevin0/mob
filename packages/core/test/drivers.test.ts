// One set of expectations for both drivers: Mob's own protocol code and the AI
// SDK's, each speaking to a fake vendor that answers with recorded streams.
import { afterEach, describe, expect, test } from 'bun:test';
import { limits, OverflowError, StalledError } from '../src/llm/send';
import { memoryProviders, ProviderRegistry, type Driver } from '../src/provider/registry';
import type { Request, Result } from '../src/llm/llm';

const key = 'sk-test-secret-key';
type Sent = { url: string; headers: Headers; body: any };

const sse = (events: unknown[], { done = false, named = false } = {}) => {
	const lines = events.map(e => (named ? `event: ${(e as { type: string }).type}\n` : '') + `data: ${JSON.stringify(e)}\n\n`);
	if (done) lines.push('data: [DONE]\n\n');
	return new Response(lines.join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

/** vendor answers each request with the next response, recording what was sent. */
function vendor(...answers: (Response | (() => Response | Promise<Response>))[]) {
	const sent: Sent[] = [];
	const fetcher = async (url: string, init: RequestInit) => {
		sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
		const next = answers.shift();
		if (!next) throw new Error('no more answers');
		const response = typeof next === 'function' ? await next() : next;
		// As fetch does, cancelling the request ends its body.
		const reader = response.body?.getReader();
		if (!reader) return response;
		const body = new ReadableStream<Uint8Array>({
			start(c) { init.signal?.addEventListener('abort', () => c.error(init.signal!.reason), { once: true }); },
			async pull(c) { const { value, done } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
		});
		return new Response(body, { status: response.status, headers: response.headers });
	};
	return { sent, fetcher };
}

const registry = (driver: Driver, fetcher: (url: string, init: RequestInit) => Promise<Response>, extra: object = {}) => {
	const r = new ProviderRegistry(memoryProviders({ providers: [
		{ id: 'o', chat: 'https://chat.example/v1/', key, headers: { 'X-Team': 'mob-team' }, ...extra },
		{ id: 'a', anthropic: 'https://messages.example/anthropic', key, modelPrefs: { 'claude-x': { output: 20000 } } },
		{ id: 'local', chat: 'http://localhost:11434/v1' },
	] }), undefined, false, fetcher);
	r.driver = driver;
	return r;
};

const conversation: Request = {
	system: 'Be brief.',
	maxTokens: 4000,
	tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
	messages: [
		{ role: 'user', text: 'Read a.txt' },
		{ role: 'assistant', text: '', reasoning: 'I should read it.', signature: 'sig-1', toolCalls: [{ id: 'call.1', name: 'read', arguments: '{"path":"a.txt"}' }] },
		{ role: 'tool', text: 'hello', toolCallId: 'call.1', toolName: 'read' },
	],
};

const collect = async (model: { stream: (r: Request, e: (k: 'text' | 'reasoning', d: string) => void) => Promise<Result> }, req: Request) => {
	const deltas: [string, string][] = [];
	const result = await model.stream(req, (k, d) => { deltas.push([k, d]); });
	return { result, deltas };
};

const failure = async (p: Promise<unknown>) => {
	try { await p; } catch (e) { return e as Error & { result?: Result }; }
	throw new Error('expected a failure');
};

const saved = { ...limits };
afterEach(() => Object.assign(limits, saved));

const chunk = (delta: object, extra: object = {}) => ({ choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

describe.each(['mob', 'aisdk'] as const)('%s driver', driver => {
	describe('Chat Completions', () => {
		test('streams reasoning and text, gathers tool calls, and counts usage', async () => {
			const { sent, fetcher } = vendor(sse([
				chunk({ role: 'assistant', reasoning_content: 'Think' }),
				chunk({ reasoning_content: 'ing.' }),
				chunk({ content: 'Reading ' }),
				chunk({ content: 'b.txt' }),
				chunk({ tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
				chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"b.txt"}' } }] }),
				finish('tool_calls'),
				{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
			], { done: true }));
			const { result, deltas } = await collect(registry(driver, fetcher).resolve('o/gpt-x:high'), conversation);
			expect(deltas).toEqual([['reasoning', 'Think'], ['reasoning', 'ing.'], ['text', 'Reading '], ['text', 'b.txt']]);
			expect(result).toMatchObject({ text: 'Reading b.txt', reasoning: 'Thinking.', calls: [{ id: 'c2', name: 'read', arguments: '{"path":"b.txt"}' }] });
			expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, reasoningTokens: 5 });

			const [{ url, headers, body }] = sent;
			expect(url).toBe('https://chat.example/v1/chat/completions');
			expect(headers.get('authorization')).toBe(`Bearer ${key}`);
			expect(headers.get('x-team')).toBe('mob-team');
			expect(body).toMatchObject({ model: 'gpt-x', stream: true, stream_options: { include_usage: true }, max_tokens: 4000, reasoning_effort: 'high' });
			expect(body.tools).toEqual([{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: conversation.tools![0].parameters } }]);
			expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
			expect(body.messages[1]).toEqual({ role: 'user', content: 'Read a.txt' });
			expect(body.messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'I should read it.', tool_calls: [{ id: 'call.1', type: 'function', function: { name: 'read' } }] });
			expect(JSON.parse(body.messages[2].tool_calls[0].function.arguments)).toEqual({ path: 'a.txt' });
			expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call.1', content: 'hello' });
		});

		test('a provider without a key sends no credential', async () => {
			const { sent, fetcher } = vendor(sse([chunk({ content: 'hi' }), finish('stop')], { done: true }));
			await collect(registry(driver, fetcher).resolve('local/llama3'), { system: '', messages: [{ role: 'user', text: 'hi' }] });
			expect(sent[0].headers.has('authorization')).toBe(false);
			expect(sent[0].body.reasoning_effort).toBeUndefined();
		});

		test('DeepSeek reports cache hits in a field of its own', async () => {
			const { fetcher } = vendor(sse([chunk({ content: 'ok' }), finish('stop'), { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2, prompt_cache_hit_tokens: 40 } }], { done: true }));
			const { result } = await collect(registry(driver, fetcher).resolve('o/deepseek-chat'), { system: '', messages: [{ role: 'user', text: 'hi' }] });
			expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 2, cacheReadTokens: 40 });
		});

		test('a stream that ends before it finishes fails and keeps what arrived', async () => {
			const { fetcher } = vendor(sse([chunk({ content: 'Half' })]));
			const e = await failure(collect(registry(driver, fetcher).resolve('o/gpt-x'), conversation));
			expect(e.message).toBe('model stream ended before completion');
			expect(e.result?.text).toBe('Half');
		});

		test('an error in the stream fails the request', async () => {
			const { fetcher } = vendor(sse([chunk({ content: 'a' }), { error: { message: 'overloaded' } }]));
			expect((await failure(collect(registry(driver, fetcher).resolve('o/gpt-x'), conversation))).message).toBe('model reported a stream error');
		});

		test('more tool calls than allowed fail the request', async () => {
			const calls = Array.from({ length: 17 }, (_, index) => ({ index, id: `c${index}`, type: 'function', function: { name: 'read', arguments: '{}' } }));
			const { fetcher } = vendor(sse([chunk({ tool_calls: calls }), finish('tool_calls')], { done: true }));
			expect((await failure(collect(registry(driver, fetcher).resolve('o/gpt-x'), conversation))).message).toBe('too many model tool calls');
		});

		test("a refusal reaches the user with the key masked, and a prompt too long is told apart", async () => {
			const { fetcher } = vendor(
				Response.json({ error: { message: `Incorrect API key provided: ${key}` } }, { status: 401 }),
				Response.json({ error: { message: "This model's maximum context length is 128000 tokens", code: 'context_length_exceeded' } }, { status: 400 }),
			);
			const models = registry(driver, fetcher);
			const refused = await failure(collect(models.resolve('o/gpt-x'), conversation));
			expect(refused.message).toBe('model returned HTTP 401: Incorrect API key provided: ••••');
			expect(refused).not.toBeInstanceOf(OverflowError);
			const long = await failure(collect(models.resolve('o/gpt-x'), conversation));
			expect(long).toBeInstanceOf(OverflowError);
			expect(long.message).toStartWith('model returned HTTP 400:');
		});

		test('a request that failed before its response began is sent again', async () => {
			limits.retryDelay = 1;
			const { sent, fetcher } = vendor(new Response('busy', { status: 503 }), sse([chunk({ content: 'ok' }), finish('stop')], { done: true }));
			const { result } = await collect(registry(driver, fetcher).resolve('o/gpt-x'), conversation);
			expect(result.text).toBe('ok');
			expect(sent).toHaveLength(2);
		});

		test('a connection that fails is reported as such', async () => {
			limits.retries = 0;
			const { fetcher } = vendor(() => { throw new TypeError('fetch failed'); });
			expect((await failure(collect(registry(driver, fetcher).resolve('o/gpt-x'), conversation))).message).toBe('model connection failed: fetch failed');
		});

		test('a response that stops arriving fails as stalled', async () => {
			limits.stallTimeout = 50;
			const encoder = new TextEncoder();
			const { fetcher } = vendor(() => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: 'Hel' }))}\n\n`)); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
			const e = await failure(collect(registry(driver, fetcher).resolve('o/gpt-x'), conversation));
			expect(e).toBeInstanceOf(StalledError);
			expect(e.result?.text).toBe('Hel');
		});

		test('the provider quirk adapts the request', async () => {
			const { sent, fetcher } = vendor(sse([chunk({ content: 'ok' }), finish('stop')], { done: true }));
			const models = registry(driver, fetcher, { preset: 'openai' });
			const { findPreset } = await import('../src/provider/presets');
			const preset = findPreset('openai')!;
			preset.quirk = (model, headers, body) => { headers.set('x-quirk', model); body.extra = true; };
			try {
				await collect(models.resolve('o/gpt-x'), conversation);
			} finally { delete preset.quirk; }
			expect(sent[0].headers.get('x-quirk')).toBe('gpt-x');
			expect(sent[0].body.extra).toBe(true);
		});
	});

	describe('Anthropic Messages', () => {
		const events = [
			{ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 } } },
			{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm.' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-2' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading.' } },
			{ type: 'content_block_stop', index: 1 },
			{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } },
			{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
			{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"b.txt"}' } },
			{ type: 'content_block_stop', index: 2 },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } },
			{ type: 'message_stop' },
		];

		test('streams thinking with its signature, text and tool calls, caches the prompt, and counts usage', async () => {
			const { sent, fetcher } = vendor(sse(events, { named: true }));
			const { result, deltas } = await collect(registry(driver, fetcher).resolve('a/claude-x:medium'), conversation);
			expect(deltas).toEqual([['reasoning', 'Hmm.'], ['text', 'Reading.']]);
			expect(result).toMatchObject({ text: 'Reading.', reasoning: 'Hmm.', signature: 'sig-2', calls: [{ id: 'toolu_1', name: 'read', arguments: '{"path":"b.txt"}' }] });
			expect(result.usage).toEqual({ inputTokens: 95, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 5 });

			const [{ url, headers, body }] = sent;
			expect(url).toBe('https://messages.example/anthropic/v1/messages');
			expect(headers.get('x-api-key')).toBe(key);
			expect(headers.get('anthropic-version')).toBe('2023-06-01');
			expect(body).toMatchObject({ model: 'claude-x', stream: true, max_tokens: 4000, thinking: { type: 'enabled', budget_tokens: 2000 } });
			expect(body.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }]);
			expect(body.tools).toEqual([{ name: 'read', description: 'Read a file', input_schema: conversation.tools![0].parameters, cache_control: { type: 'ephemeral' } }]);
			expect(body.messages).toEqual([
				{ role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
				{ role: 'assistant', content: [
					{ type: 'thinking', thinking: 'I should read it.', signature: 'sig-1' },
					{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.txt' } },
				] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hello', cache_control: { type: 'ephemeral' } }] },
			]);
		});

		test('a model without effort does not think, and its output limit caps the reply', async () => {
			const { sent, fetcher } = vendor(sse(events, { named: true }));
			await collect(registry(driver, fetcher).resolve('a/claude-x'), { ...conversation, maxTokens: 0 });
			expect(sent[0].body.thinking).toBeUndefined();
			expect(sent[0].body.max_tokens).toBe(20000);
		});

		test('a stream that ends before message_stop fails and keeps what arrived', async () => {
			const { fetcher } = vendor(sse(events.slice(0, 7), { named: true }));
			const e = await failure(collect(registry(driver, fetcher).resolve('a/claude-x'), conversation));
			expect(e.message).toBe('model stream ended before completion');
			expect(e.result?.text).toBe('Reading.');
		});

		test('an error event fails the request', async () => {
			const { fetcher } = vendor(sse([...events.slice(0, 7), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }], { named: true }));
			expect((await failure(collect(registry(driver, fetcher).resolve('a/claude-x'), conversation))).message).toBe('model reported a stream error');
		});

		test('an error event before any output fails the request', async () => {
			const { fetcher } = vendor(sse([events[0], { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }], { named: true }));
			expect((await failure(collect(registry(driver, fetcher).resolve('a/claude-x'), conversation))).message).toBe('model reported a stream error');
		});

		test('a response that stops arriving fails as stalled', async () => {
			limits.stallTimeout = 50;
			const encoder = new TextEncoder();
			const { fetcher } = vendor(() => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(events[0])}\n\n`)); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
			expect(await failure(collect(registry(driver, fetcher).resolve('a/claude-x'), conversation))).toBeInstanceOf(StalledError);
		});

		test('a prompt too long is told apart', async () => {
			const { fetcher } = vendor(Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } }, { status: 400 }));
			const e = await failure(collect(registry(driver, fetcher).resolve('a/claude-x'), conversation));
			expect(e).toBeInstanceOf(OverflowError);
			expect(e.message).toBe('model returned HTTP 400: prompt is too long: 210000 tokens > 200000 maximum');
		});
	});
});
