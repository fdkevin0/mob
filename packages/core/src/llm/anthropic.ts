// Anthropic Messages, served by Anthropic and by vendors that offer an
// Anthropic-compatible endpoint (DeepSeek, Kimi, GLM).
import { byteLength, emptyResult, maxResponseBytes, maxToolArguments, maxToolCallId, maxToolCalls, maxToolNameLength, readSSE, type Emit, type Info, type Model, type Ref, type Request, type Result, type Usage } from './llm';
import { send, secrets, statusError, type Fetch } from './send';

export type Config = { baseURL: string; key: string; headers?: Record<string, string>; fetch?: Fetch };

const version = '2023-06-01';
/** defaultOutput is the reply size for a model whose output limit is unknown. */
const defaultOutput = 32000;
/** budgets are thinking tokens per effort; "none" leaves thinking off. */
const budgets: Record<string, number> = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32000 };
/** ephemeral marks the end of a prompt prefix to cache, for five minutes. */
const ephemeral = { type: 'ephemeral' };

/** toolID adapts IDs another vendor issued to the pattern Anthropic accepts. */
const toolID = (id = '') => id.replace(/[^a-zA-Z0-9_-]/g, '_');

type Block = Record<string, unknown>;

export function messages(req: Request) {
	const out: { role: string; content: Block[] }[] = [];
	const add = (role: string, ...blocks: Block[]) => {
		if (!blocks.length) return;
		// Consecutive turns of one role are merged: tool results answering one
		// assistant turn must arrive in a single user message.
		const last = out[out.length - 1];
		if (last && last.role === role) last.content.push(...blocks);
		else out.push({ role, content: blocks });
	};
	for (const m of req.messages) {
		if (m.role === 'tool') add('user', { type: 'tool_result', tool_use_id: toolID(m.toolCallId), content: m.text });
		else if (m.role === 'assistant') {
			const blocks: Block[] = [];
			if (m.reasoning && m.signature) blocks.push({ type: 'thinking', thinking: m.reasoning, signature: m.signature });
			if (m.text) blocks.push({ type: 'text', text: m.text });
			for (const c of m.toolCalls ?? []) {
				let input: unknown = {};
				try { const v = JSON.parse(c.arguments); if (v && typeof v === 'object' && !Array.isArray(v)) input = v; } catch { /* {} */ }
				blocks.push({ type: 'tool_use', id: toolID(c.id), name: c.name, input });
			}
			add('assistant', ...blocks);
		} else if (m.text) add('user', { type: 'text', text: m.text });
	}
	return out;
}

type RawUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
function normal(u: RawUsage = {}): Usage {
	const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
	const out: Usage = { inputTokens: (u.input_tokens ?? 0) + read + write, outputTokens: u.output_tokens ?? 0 };
	if (read) out.cacheReadTokens = read;
	if (write) out.cacheWriteTokens = write;
	return out;
}

export class AnthropicModel implements Model {
	constructor(readonly ref: Ref, readonly info: Info, private config: Config) {}

	async stream(req: Request, emit: Emit, signal?: AbortSignal): Promise<Result> {
		const result = emptyResult();
		let maxTokens = req.maxTokens && req.maxTokens > 0 ? req.maxTokens : defaultOutput;
		// Anthropic caches a prompt's prefix only up to blocks marked for it:
		// the tools, the system prompt and the latest message, so each step of a
		// turn, and the next turn, reads what the previous one wrote.
		const msgs = messages(req);
		const lastMessage = msgs[msgs.length - 1];
		if (lastMessage) {
			const last = lastMessage.content[lastMessage.content.length - 1];
			if (last.type !== 'thinking') last.cache_control = ephemeral;
		}
		const body: Record<string, unknown> = { model: this.ref.model, messages: msgs, stream: true };
		if (req.system) body.system = [{ type: 'text', text: req.system, cache_control: ephemeral }];
		if (this.info.output && this.info.output > 0) maxTokens = Math.min(maxTokens, this.info.output);
		// Thinking shares the requested tokens and leaves at least half of them
		// for the answer. Anthropic requires at least 1024 thinking tokens.
		const budget = Math.min(budgets[this.ref.effort] ?? 0, Math.floor(maxTokens / 2));
		if (budget >= 1024) body.thinking = { type: 'enabled', budget_tokens: budget };
		body.max_tokens = maxTokens;
		if (req.tools?.length) {
			const ts: Block[] = req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
			ts[ts.length - 1].cache_control = ephemeral;
			body.tools = ts;
		}
		const headers = new Headers({ 'Content-Type': 'application/json', 'anthropic-version': version });
		if (this.config.key) headers.set('x-api-key', this.config.key);
		for (const [k, v] of Object.entries(this.config.headers ?? {})) headers.set(k, v);
		let response: Response;
		try {
			response = await send(this.config.fetch ?? fetch, this.config.baseURL.replace(/\/+$/, '') + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) }, signal);
		} catch (e) {
			if (signal?.aborted) throw e;
			throw new Error(`model connection failed: ${e instanceof Error ? e.message : e}`, { cause: e });
		}
		if (response.status !== 200) throw await statusError(response, secrets(this.config.key, this.config.headers));
		let usage: Usage = { inputTokens: 0, outputTokens: 0 };
		const blocks = new Map<number, number>(); // content block index → tool call index
		let stopped = false, size = 0;
		try {
			await readSSE(response.body!, async (_event, data) => {
				let e: { type?: string; index?: number; message?: { usage?: RawUsage }; usage?: RawUsage; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string } };
				try { e = JSON.parse(data); } catch { throw new Error('invalid model stream JSON'); }
				switch (e.type) {
					case 'error': throw new Error('model reported a stream error');
					case 'message_start': usage = normal(e.message?.usage); break;
					case 'message_delta': usage.outputTokens = e.usage?.output_tokens ?? 0; break;
					case 'message_stop': stopped = true; break;
					case 'content_block_start':
						if (e.content_block?.type === 'tool_use') {
							if (result.calls.length >= maxToolCalls) throw new Error('too many model tool calls');
							blocks.set(e.index ?? 0, result.calls.length);
							const id = e.content_block.id ?? '', name = e.content_block.name ?? '';
							result.calls.push({ id, name, arguments: '' });
							if (id.length > maxToolCallId || name.length > maxToolNameLength) throw new Error('model tool call exceeded limit');
						}
						break;
					case 'content_block_delta': {
						let kind: 'text' | 'reasoning' | '' = '', text = '';
						const d = e.delta ?? {};
						if (d.type === 'text_delta') { kind = 'text'; text = d.text ?? ''; result.text += text; }
						else if (d.type === 'thinking_delta') { kind = 'reasoning'; text = d.thinking ?? ''; result.reasoning += text; }
						else if (d.type === 'signature_delta') result.signature += d.signature ?? '';
						else if (d.type === 'input_json_delta') {
							const i = blocks.get(e.index ?? 0);
							if (i === undefined) throw new Error('model sent tool input outside a tool call');
							result.calls[i].arguments += d.partial_json ?? '';
							if (byteLength(result.calls[i].arguments) > maxToolArguments) throw new Error('model tool call exceeded limit');
						}
						size += byteLength(text);
						if (size > maxResponseBytes) throw new Error('model response exceeded limit');
						if (text && kind) await emit(kind, text);
					}
				}
			});
			if (!stopped) throw Object.assign(new Error('model stream ended before completion'), { result });
		} finally {
			for (const c of result.calls) if (!c.arguments) c.arguments = '{}';
			result.usage = usage;
		}
		return result;
	}
}
