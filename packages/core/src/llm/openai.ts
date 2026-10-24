// OpenAI Chat Completions, the protocol most vendors, relays and local servers
// (Ollama, LM Studio, vLLM) answer.
import { byteLength, emptyResult, maxResponseBytes, maxToolArguments, maxToolCallId, maxToolCalls, maxToolNameLength, readSSE, type Emit, type Info, type Model, type Ref, type Request, type Result, type Tool, type Usage } from './llm';
import { send, secrets, statusError, type Fetch } from './send';

export type Config = {
	baseURL: string;
	key: string;
	headers?: Record<string, string>;
	fetch?: Fetch;
	/** prepare adjusts a vendor's request after it is built (provider quirks). */
	prepare?: (headers: Headers, body: Record<string, unknown>) => void;
};

export function messages(req: Request) {
	const out: Record<string, unknown>[] = [];
	if (req.system) out.push({ role: 'system', content: req.system });
	for (const m of req.messages) {
		if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.text });
		else if (m.role === 'assistant') {
			const v: Record<string, unknown> = { role: 'assistant', content: m.text };
			if (m.reasoning) v.reasoning_content = m.reasoning;
			if (m.toolCalls?.length) v.tool_calls = m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
			out.push(v);
		} else out.push({ role: m.role, content: m.text });
	}
	return out;
}

const tools = (ts: Tool[]) => ts.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

type Chunk = {
	error?: unknown;
	usage?: RawUsage | null;
	choices?: { finish_reason?: string | null; delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
};
type RawUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };

function normal(u: RawUsage): Usage {
	const cached = u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0;
	const out: Usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
	if (u.completion_tokens_details?.reasoning_tokens) out.reasoningTokens = u.completion_tokens_details.reasoning_tokens;
	if (cached) out.cacheReadTokens = cached;
	return out;
}

export class OpenAIModel implements Model {
	constructor(readonly ref: Ref, readonly info: Info, private config: Config) {}

	async stream(req: Request, emit: Emit, signal?: AbortSignal): Promise<Result> {
		const result = emptyResult();
		const body: Record<string, unknown> = { model: this.ref.model, messages: messages(req), stream: true, stream_options: { include_usage: true } };
		if (req.maxTokens && req.maxTokens > 0) body.max_tokens = req.maxTokens;
		if (req.tools?.length) body.tools = tools(req.tools);
		if (this.ref.effort) body.reasoning_effort = this.ref.effort;
		const headers = new Headers({ 'Content-Type': 'application/json' });
		if (this.config.key) headers.set('Authorization', 'Bearer ' + this.config.key);
		for (const [k, v] of Object.entries(this.config.headers ?? {})) headers.set(k, v);
		this.config.prepare?.(headers, body);
		let response: Response;
		try {
			response = await send(this.config.fetch ?? fetch, this.config.baseURL.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }, signal);
		} catch (e) {
			if (signal?.aborted) throw e;
			throw new Error(`model connection failed: ${e instanceof Error ? e.message : e}`, { cause: e });
		}
		if (response.status !== 200) throw await statusError(response, secrets(this.config.key, this.config.headers));
		let finished = false, done = false, size = 0;
		await readSSE(response.body!, async (_event, data) => {
			if (data === '[DONE]') { done = true; return; }
			if (done) throw new Error('model sent data after completion');
			let chunk: Chunk;
			try { chunk = JSON.parse(data); } catch { throw new Error('invalid model stream JSON'); }
			if (chunk.error !== undefined && chunk.error !== null) throw new Error('model reported a stream error');
			if (chunk.usage) result.usage = normal(chunk.usage);
			const c = chunk.choices?.[0];
			if (!c) return;
			if (c.finish_reason !== undefined && c.finish_reason !== null) finished = true;
			const reasoning = c.delta?.reasoning_content || c.delta?.reasoning || '';
			for (const [kind, text] of [['reasoning', reasoning], ['text', c.delta?.content ?? '']] as const) {
				size += byteLength(text);
				if (size > maxResponseBytes) throw new Error('model response exceeded limit');
				if (!text) continue;
				if (kind === 'text') result.text += text; else result.reasoning += text;
				await emit(kind, text);
			}
			for (const call of c.delta?.tool_calls ?? []) {
				if (call.index < 0 || call.index >= maxToolCalls) throw new Error('too many model tool calls');
				while (result.calls.length <= call.index) result.calls.push({ id: '', name: '', arguments: '' });
				const v = result.calls[call.index];
				v.id += call.id ?? '';
				v.name += call.function?.name ?? '';
				v.arguments += call.function?.arguments ?? '';
				if (byteLength(v.arguments) > maxToolArguments || v.id.length > maxToolCallId || v.name.length > maxToolNameLength) throw new Error('model tool call exceeded limit');
			}
		});
		if (!finished && !done) throw Object.assign(new Error('model stream ended before completion'), { result });
		return result;
	}
}
