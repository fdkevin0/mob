// The provider-neutral model interface the conversation engine depends on.
// Drivers translate it to one wire protocol each; the provider registry
// decides which driver, endpoint and key a model reference uses.

// Ref names a model as users type it: provider/model[:effort]. Model IDs may
// contain slashes and colons (@cf/meta/llama, llama3.2:3b), so only the first
// slash separates the provider and only a known effort level is a suffix.
export type Ref = { provider: string; model: string; effort: string };

export const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function parseRef(s: string): Ref | undefined {
	const text = s.trim();
	const slash = text.indexOf('/');
	if (slash <= 0 || slash === text.length - 1) return undefined;
	const ref = { provider: text.slice(0, slash), model: text.slice(slash + 1), effort: '' };
	const colon = ref.model.lastIndexOf(':');
	if (colon > 0 && efforts.includes(ref.model.slice(colon + 1))) {
		ref.effort = ref.model.slice(colon + 1);
		ref.model = ref.model.slice(0, colon);
	}
	return ref;
}

/** The reference without its effort. */
export const refKey = (r: Ref) => `${r.provider}/${r.model}`;
export const refString = (r: Ref) => (r.effort ? `${refKey(r)}:${r.effort}` : refKey(r));

/** Cost is USD per million tokens. */
export type Cost = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

// Info is what is known about a model: the catalog's metadata, the user's
// overrides, or conservative defaults when neither says.
export type Info = {
	id: string;
	name?: string;
	context?: number;
	output?: number;
	reasoning?: boolean;
	tools: boolean;
	vision?: boolean;
	efforts?: string[];
	cost?: Cost;
	/** free is set for a model that costs nothing to call: listed at no price, or a vendor's free tier. */
	free?: boolean;
	/** Set when the catalog described the model. */
	known: boolean;
};

/** One provider's models, as /models and the API list them. */
export type Group = { provider: string; name: string; models: Info[]; error?: string };

export type ToolCall = { id: string; name: string; arguments: string };
export type Tool = { name: string; description: string; parameters: Record<string, unknown> };

// Message is one turn of a prompt. Reasoning and signature belong to the
// model that produced them; the engine replays them only to that model.
export type Message = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	text: string;
	reasoning?: string;
	signature?: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
	toolName?: string;
};

export type Request = { system: string; messages: Message[]; tools?: Tool[]; maxTokens?: number };

/** Usage counts input as every prompt token, cached or not, on every protocol. */
export type Usage = {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
};

/** priced fills cost from the model's list price, when known. */
export function priced(u: Usage, c?: Cost): Usage {
	if (!c) return u;
	const read = u.cacheReadTokens ?? 0, write = u.cacheWriteTokens ?? 0;
	return { ...u, cost: ((u.inputTokens - read - write) * c.input + u.outputTokens * c.output + read * (c.cacheRead ?? 0) + write * (c.cacheWrite ?? 0)) / 1e6 };
}

export type Result = { text: string; reasoning: string; signature: string; calls: ToolCall[]; usage?: Usage };
export const emptyResult = (): Result => ({ text: '', reasoning: '', signature: '', calls: [] });

export type Emit = (kind: 'text' | 'reasoning', delta: string) => void | Promise<void>;

// Model is a callable model. stream emits text and reasoning deltas as they
// arrive and returns the whole step.
export interface Model {
	ref: Ref;
	info: Info;
	stream(req: Request, emit: Emit, signal?: AbortSignal): Promise<Result>;
}

// Limits every driver enforces on untrusted model output.
export const maxResponseBytes = 2 << 20;
export const maxToolCalls = 16;
export const maxToolArguments = 1 << 20;
export const maxToolCallId = 200;
export const maxToolNameLength = 100;

/** readSSE also handles CRLF and multi-line data fields; callers choose how to interpret events. */
export async function readSSE(body: ReadableStream<Uint8Array>, handle: (event: string, data: string) => void | Promise<void>) {
	const decoder = new TextDecoder();
	let buffer = '', event = '';
	let data: string[] = [];
	const flush = async () => {
		if (!data.length) { event = ''; return; }
		const raw = data.join('\n'), name = event;
		data = []; event = '';
		await handle(name, raw);
	};
	const line = async (text: string) => {
		if (text === '') await flush();
		else if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
		else if (text.startsWith('event:')) event = text.slice(6).trim();
	};
	const reader = body.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			if (buffer.length > 2 << 20 && !buffer.includes('\n')) throw new Error('model stream line exceeded limit');
			let at: number;
			while ((at = buffer.indexOf('\n')) >= 0) {
				await line(buffer.slice(0, at).replace(/\r$/, ''));
				buffer = buffer.slice(at + 1);
			}
		}
		buffer += decoder.decode();
		if (buffer) await line(buffer.replace(/\r$/, ''));
		await flush();
	} finally {
		reader.releaseLock();
	}
}

/** byteLength is the UTF-8 size Go's len reports. */
export const byteLength = (s: string) => new TextEncoder().encode(s).length;
