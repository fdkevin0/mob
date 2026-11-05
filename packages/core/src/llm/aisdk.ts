// The AI SDK driver: one Model for both wire protocols, built on the AI SDK's
// provider packages instead of Mob's own. Mob calls the provider's language
// model directly (doStream), not streamText, so the engine keeps its own loop:
// tool calls come back unexecuted and unvalidated, as from the other drivers.
//
// What the SDK does not do the Mob way stays Mob's: requests go through send
// (stall detection, retries only before a response begins, Retry-After),
// failures are worded by statusError (credentials masked, overflow told
// apart), and model output is held to the same limits.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { byteLength, emptyResult, maxResponseBytes, maxToolArguments, maxToolCallId, maxToolCalls, maxToolNameLength, type Emit, type Info, type Message, type Model, type Ref, type Request, type Result, type Usage } from './llm';
import { send, secrets, statusError, type Fetch } from './send';

export type Protocol = 'chat' | 'anthropic';

export type Config = {
	protocol: Protocol;
	baseURL: string;
	key: string;
	headers?: Record<string, string>;
	fetch?: Fetch;
	/** prepare adjusts a vendor's Chat Completions request after it is built (provider quirks). */
	prepare?: (headers: Headers, body: Record<string, unknown>) => void;
};

type LanguageModel = ReturnType<ReturnType<typeof createAnthropic>>;
type CallOptions = Parameters<LanguageModel['doStream']>[0];
type Prompt = CallOptions['prompt'];
type Part = Exclude<Prompt[number]['content'], string>[number];
type StreamPart = Awaited<ReturnType<LanguageModel['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type SDKUsage = Extract<StreamPart, { type: 'finish' }>['usage'];

/** defaultOutput is the reply size for a model whose output limit is unknown. */
const defaultOutput = 32000;
/** budgets are Anthropic thinking tokens per effort; "none" leaves thinking off. */
const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32000 };
/** cache marks the end of a prompt prefix Anthropic caches, for five minutes. */
const cache = { anthropic: { cacheControl: { type: 'ephemeral' } } };

/** toolID adapts IDs another vendor issued to the pattern Anthropic accepts. */
const toolID = (id = '') => id.replace(/[^a-zA-Z0-9_-]/g, '_');

/** input is a tool call's arguments as an object, or {} when the model wrote something else. */
function input(args: string): Record<string, unknown> {
	try {
		const v = JSON.parse(args);
		if (v && typeof v === 'object' && !Array.isArray(v)) return v;
	} catch { /* {} */ }
	return {};
}

/** prompt is a request in the SDK's terms. Reasoning goes back as each protocol replays it: Anthropic only with its signature. */
export function prompt(req: Request, protocol: Protocol): Prompt {
	const anthropic = protocol === 'anthropic';
	const id = anthropic ? toolID : (s = '') => s;
	const out: Prompt = [];
	if (req.system) out.push({ role: 'system', content: req.system, ...(anthropic && { providerOptions: cache }) });
	const turn = (m: Message): Prompt[number] | undefined => {
		if (m.role === 'tool') return { role: 'tool', content: [{ type: 'tool-result', toolCallId: id(m.toolCallId), toolName: m.toolName ?? '', output: { type: 'text', value: m.text } }] };
		if (m.role === 'assistant') {
			const parts: Part[] = [];
			if (m.reasoning && (!anthropic || m.signature)) parts.push({ type: 'reasoning', text: m.reasoning, ...(anthropic && { providerOptions: { anthropic: { signature: m.signature } } }) });
			if (m.text || !anthropic) parts.push({ type: 'text', text: m.text });
			for (const c of m.toolCalls ?? []) parts.push({ type: 'tool-call', toolCallId: id(c.id), toolName: c.name, input: input(c.arguments) });
			return parts.length ? { role: 'assistant', content: parts } as Prompt[number] : undefined;
		}
		if (!m.text && anthropic) return undefined;
		return { role: 'user', content: [{ type: 'text', text: m.text }] };
	};
	for (const m of req.messages) {
		const t = turn(m);
		if (t) out.push(t);
	}
	// Anthropic caches up to the latest message too, so each step of a turn, and the next turn, reads what the previous one wrote.
	const last = out[out.length - 1];
	if (anthropic && last && last.role !== 'system') {
		const part = last.content[last.content.length - 1];
		if (part.type !== 'reasoning') part.providerOptions = cache;
	}
	return out;
}

/** usage counts input as every prompt token, cached or not; DeepSeek reports its cache hits in a field of its own. */
function usage(u: SDKUsage): Usage {
	const raw = (u.raw ?? {}) as { prompt_cache_hit_tokens?: number };
	const out: Usage = { inputTokens: u.inputTokens.total ?? 0, outputTokens: u.outputTokens.total ?? 0 };
	const read = u.inputTokens.cacheRead || raw.prompt_cache_hit_tokens || 0;
	if (u.outputTokens.reasoning) out.reasoningTokens = u.outputTokens.reasoning;
	if (read) out.cacheReadTokens = read;
	if (u.inputTokens.cacheWrite) out.cacheWriteTokens = u.inputTokens.cacheWrite;
	return out;
}

/** describe words a failure the SDK reports in the stream. */
function describe(error: unknown) {
	const name = error instanceof Error ? error.name : '';
	if (name.includes('JSONParse') || name.includes('TypeValidation')) return 'invalid model stream JSON';
	if (error instanceof Error && error.message.includes('without a finish reason')) return 'model stream ended before completion';
	return 'model reported a stream error';
}

/** unwrap is what a response's body failed with, such as StalledError, which the SDK wraps in its own error. */
function unwrap(e: unknown) {
	for (let depth = 0; e instanceof Error && e.name === 'AI_APICallError' && e.cause instanceof Error && depth < 5; depth++) e = e.cause;
	return e;
}

export class SDKModel implements Model {
	constructor(readonly ref: Ref, readonly info: Info, private config: Config) {}

	async stream(req: Request, emit: Emit, signal?: AbortSignal): Promise<Result> {
		const { protocol, key, headers = {} } = this.config;
		const anthropic = protocol === 'anthropic';
		const base = this.config.baseURL.replace(/\/+$/, '');
		// failure is how a request failed in Mob's words, kept here because the SDK wraps what its fetch throws.
		let failure: unknown;
		const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
			const h = new Headers(init?.headers);
			// A provider without a key sends no credential header at all.
			if (!key) { h.delete('x-api-key'); h.delete('authorization'); }
			let body = init?.body;
			if (!anthropic && this.config.prepare && typeof body === 'string') {
				const value = JSON.parse(body) as Record<string, unknown>;
				this.config.prepare(h, value);
				body = JSON.stringify(value);
			}
			let response: Response;
			try {
				response = await send(this.config.fetch ?? fetch, String(url), { method: 'POST', headers: h, body }, signal);
			} catch (e) {
				failure = signal?.aborted ? e : new Error(`model connection failed: ${e instanceof Error ? e.message : e}`, { cause: e });
				throw failure;
			}
			if (response.status !== 200) throw (failure = await statusError(response, secrets(key, headers)));
			return response;
		};
		const model = anthropic
			? createAnthropic({ baseURL: base + '/v1', apiKey: key, headers, fetch: fetcher as typeof fetch })(this.ref.model)
			: createOpenAICompatible({ name: 'chat', baseURL: base, apiKey: key || undefined, headers, fetch: fetcher as typeof fetch, includeUsage: true }).chatModel(this.ref.model);

		const options: CallOptions = { prompt: prompt(req, protocol), abortSignal: signal };
		if (req.tools?.length) {
			const last = req.tools.length - 1;
			options.tools = req.tools.map((t, i) => ({ type: 'function' as const, name: t.name, description: t.description, inputSchema: t.parameters, ...(anthropic && i === last && { providerOptions: cache }) }));
		}
		if (anthropic) {
			let maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : defaultOutput;
			if (this.info.output && this.info.output > 0) maxTokens = Math.min(maxTokens, this.info.output);
			// Thinking shares the requested tokens and leaves at least half of them
			// for the answer; the SDK asks for the answer's tokens plus the budget.
			const budget = Math.min(budgets[this.ref.effort] ?? 0, Math.floor(maxTokens / 2));
			// Tool input arrives whole, as vendors' Anthropic-compatible endpoints expect; eager streaming is Anthropic's own.
			const anthropicOptions: Record<string, unknown> = { toolStreaming: false };
			if (budget >= 1024) {
				anthropicOptions.thinking = { type: 'enabled', budgetTokens: budget };
				maxTokens -= budget;
			}
			options.providerOptions = { anthropic: anthropicOptions } as CallOptions['providerOptions'];
			options.maxOutputTokens = maxTokens;
		} else {
			if (req.maxTokens && req.maxTokens > 0) options.maxOutputTokens = req.maxTokens;
			if (this.ref.effort) options.providerOptions = { openaiCompatible: { reasoningEffort: this.ref.effort } };
		}

		const result = emptyResult();
		const fail = (e: unknown): never => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { result }); };
		let stream: ReadableStream<StreamPart>;
		try {
			({ stream } = await model.doStream(options));
		} catch (e) {
			if (failure !== undefined) throw failure;
			const cause = unwrap(e);
			if (cause !== e || signal?.aborted) throw cause;
			// The SDK reads the start of an Anthropic stream before it answers, so an error event there arrives here.
			if (e instanceof Error && e.name === 'AI_APICallError') throw new Error('model reported a stream error', { cause: e });
			throw e;
		}

		const calls = new Map<string, number>(); // the SDK's tool call ID → index in result.calls
		const call = (id: string, name = '') => {
			let i = calls.get(id);
			if (i === undefined) {
				if (result.calls.length >= maxToolCalls) fail(new Error('too many model tool calls'));
				i = result.calls.push({ id, name, arguments: '' }) - 1;
				calls.set(id, i);
			}
			const c = result.calls[i];
			if (c.id.length > maxToolCallId || c.name.length > maxToolNameLength || byteLength(c.arguments) > maxToolArguments) fail(new Error('model tool call exceeded limit'));
			return c;
		};
		let size = 0, finished = false;
		const reader = stream.getReader();
		try {
			for (;;) {
				const { value: part, done } = await reader.read();
				if (done) break;
				switch (part.type) {
					case 'text-delta':
					case 'reasoning-delta': {
						const signature = (part.providerMetadata?.anthropic as { signature?: string } | undefined)?.signature;
						if (signature) result.signature += signature;
						size += byteLength(part.delta);
						if (size > maxResponseBytes) fail(new Error('model response exceeded limit'));
						if (!part.delta) break;
						const kind = part.type === 'text-delta' ? 'text' : 'reasoning';
						if (kind === 'text') result.text += part.delta; else result.reasoning += part.delta;
						await emit(kind, part.delta);
						break;
					}
					case 'tool-input-start': call(part.id, part.toolName); break;
					case 'tool-input-delta': call(part.id).arguments += part.delta; call(part.id); break;
					case 'tool-call': {
						const c = call(part.toolCallId, part.toolName);
						c.name = part.toolName;
						c.arguments = part.input;
						call(part.toolCallId);
						break;
					}
					case 'error': fail(new Error(describe(part.error), { cause: part.error })); break;
					case 'finish':
						result.usage = usage(part.usage);
						finished = part.finishReason.unified !== 'interrupted' && part.finishReason.unified !== 'error';
				}
			}
		} catch (e) {
			if ((e as { result?: Result }).result) throw e;
			fail(failure ?? unwrap(e));
		} finally {
			reader.releaseLock();
		}
		if (!finished) fail(new Error('model stream ended before completion'));
		for (const c of result.calls) if (!c.arguments) c.arguments = '{}';
		return result;
	}
}
