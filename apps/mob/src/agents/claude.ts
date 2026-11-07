// The Claude Agent runtime: the Claude Agent SDK, which runs Claude Code
// (`claude`) as a child process and speaks its stream-json protocol. It asks
// Mob before calls through canUseTool and reports what each model used.
import { query, type Options as SDKOptions, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { llm } from '@mob/core';
import { command, environment, grouped, kill } from './process';
import { failed, type AgentSession, type Ending, type ModelUsage, type Options, type Runtime, type StopReason, type ToolContent, type ToolKind, type Update } from './runtime';

/** openWait bounds starting a session. */
const openWait = 2 * 60_000;

const tailSize = 4 << 10;

/** signedOut matches what Claude Code answers when it has no sign-in. */
const signedOut = /not logged in|\/login|invalid api key|oauth token has expired/i;

/** kinds name what Claude Code's tools do; the rest are other. */
const kinds: Record<string, ToolKind> = {
	Read: 'read', NotebookRead: 'read', Grep: 'search', Glob: 'search', LS: 'search', ToolSearch: 'search',
	Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
	Bash: 'execute', BashOutput: 'execute', KillShell: 'execute', KillBash: 'execute',
	WebFetch: 'fetch', WebSearch: 'fetch', ExitPlanMode: 'switch_mode', Task: 'think', Agent: 'think',
};

/** call is how a tool call of Claude Code's shows: its title, kind, files and what it changes. */
export function call(name: string, input: Record<string, unknown>): { title: string; kind: ToolKind; locations: string[]; content?: ToolContent[] } {
	const kind = kinds[name] ?? 'other';
	const file = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
	const locations = file ? [file] : [];
	let title = name;
	if (name === 'Bash') title = String(input.command ?? '');
	else if (file) title = `${name} ${file}`;
	else if (typeof input.pattern === 'string') title = `${name} ${input.pattern}`;
	else if (typeof input.url === 'string') title = `${name} ${input.url}`;
	else if (typeof input.query === 'string') title = `${name} ${input.query}`;
	else if (typeof input.description === 'string') title = `${name}: ${input.description}`;
	let content: ToolContent[] | undefined;
	if (name === 'Edit' && file) content = [{ type: 'diff', path: file, oldText: String(input.old_string ?? ''), newText: String(input.new_string ?? '') }];
	else if (name === 'Write' && file) content = [{ type: 'diff', path: file, oldText: null, newText: String(input.content ?? '') }];
	return { title, kind, locations, content };
}

type Tokens = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

/** usage is what one request used, as Mob counts it: input includes the cache, which Anthropic counts apart. */
export const usage = (u: Tokens): llm.Usage => {
	const cacheRead = u.cache_read_input_tokens ?? 0, cacheWrite = u.cache_creation_input_tokens ?? 0;
	return { inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite, outputTokens: u.output_tokens ?? 0, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
};

const add = (a: llm.Usage, b: llm.Usage): llm.Usage => ({
	inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
	cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0), cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
});

/** text is what a tool result says. */
function text(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map(c => (c as { type?: string; text?: string }).type === 'text' ? String((c as { text: string }).text) : '').join('');
}

/** Input is the stream of the owner's prompts the SDK reads. */
class Input implements AsyncIterable<SDKUserMessage> {
	private queue: SDKUserMessage[] = [];
	private waiting?: () => void;
	private done = false;
	push(m: SDKUserMessage) { this.queue.push(m); this.waiting?.(); }
	end() { this.done = true; this.waiting?.(); }
	async *[Symbol.asyncIterator]() {
		for (;;) {
			const m = this.queue.shift();
			if (m) { yield m; continue; }
			if (this.done) return;
			await new Promise<void>(r => (this.waiting = r));
			this.waiting = undefined;
		}
	}
}

/** Prompt is what the prompt being answered used so far. */
type Prompt = { done: (e: Ending) => void; usage: Map<string, llm.Usage>; seen: Set<string>; context: number; model: string };

class Session implements AgentSession {
	id = '';
	model = '';
	readonly closed: Promise<void>;
	private input = new Input();
	private abort = new AbortController();
	private q!: Query;
	private tail = '';
	private ended = false;
	private end = Promise.withResolvers<void>();
	private current?: Prompt;
	private cancelling = false;
	/** costs are each model's cost the session reported so far; unknown after resuming until one is reported, since a resumed session reports what it cost before too. */
	private costs?: Map<string, number>;

	constructor(private o: Options, private run: typeof query) {
		this.closed = this.end.promise;
	}

	stderr() { return this.tail.trim(); }

	failed(what: string, err: unknown) { return failed(this.o.preset.title, what, err, this.stderr()); }

	close() {
		if (this.ended) return;
		this.ended = true;
		this.input.end();
		this.abort.abort();
		this.q?.close();
		this.current?.done({ err: new Error('the agent exited'), usage: [] });
		this.current = undefined;
		this.end.resolve();
	}

	/** spawn starts Claude Code with the SDK's arguments, by the preset's first installed command, as the other agents are. */
	private spawn(found: string[], s: SpawnOptions) {
		const env = { ...environment(), ...this.o.preset.env };
		if (this.o.confined && process.getuid?.() === 0) env.IS_SANDBOX = '1';
		const child = grouped(found[0]!, [...found.slice(1), ...s.args], s.cwd ?? this.o.task.worktree, env);
		child.stderr!.setEncoding('utf8').on('data', (d: string) => { this.tail = (this.tail + d).slice(-tailSize); });
		child.on('error', () => {});
		child.stdin!.on('error', () => {});
		s.signal.addEventListener('abort', () => kill(child), { once: true });
		return child;
	}

	async open(signal: AbortSignal) {
		const { preset: p, task: t } = this.o;
		const found = command(p);
		if (!found) throw new Error(`${p.title} is not installed: install ${p.commands[0]![0]}, or Node.js for npx`);
		const servers = this.o.servers(true);
		const options = (id: string, resume: boolean): SDKOptions => ({
			cwd: t.worktree,
			...(resume ? { resume: id } : { sessionId: id }),
			abortController: this.abort,
			// The SDK's arguments follow the command that is spawned instead.
			pathToClaudeCodeExecutable: found[0]!,
			spawnClaudeCodeProcess: s => this.spawn(found, s),
			settingSources: ['user', 'project', 'local'],
			includePartialMessages: true,
			// A reader asks before every edit, which Mob refuses; a confined agent asks nothing.
			permissionMode: t.readOnly ? 'default' : this.o.confined ? 'bypassPermissions' : 'acceptEdits',
			allowDangerouslySkipPermissions: !t.readOnly && this.o.confined,
			mcpServers: Object.fromEntries(servers.map(s => [s.name, { type: 'http' as const, url: s.url, headers: s.headers }])),
			// A confined agent is never asked; Mob's own tools ask the owner themselves when they need to.
			...(this.o.confined && !t.readOnly ? {} : {
				canUseTool: async (name: string, input: Record<string, unknown>, x: { toolUseID: string; signal: AbortSignal }): Promise<PermissionResult> =>
					servers.some(s => name.startsWith(`mcp__${s.name}__`)) ? { behavior: 'allow', updatedInput: input } : this.permission(name, input, x.toolUseID, x.signal),
			}),
		});
		const bound = AbortSignal.any([signal, AbortSignal.timeout(openWait)]);
		const start = async (resume: boolean) => {
			const id = (resume && t.session) || crypto.randomUUID();
			this.q = this.run({ prompt: this.input, options: options(id, resume) });
			const init = this.q.initializationResult();
			const stop = new Promise<never>((_, reject) => bound.addEventListener('abort', () => reject(bound.reason), { once: true }));
			await Promise.race([init, stop]);
			this.id = id;
			this.costs = resume ? undefined : new Map();
		};
		try {
			if (t.session) {
				try { await start(true); } catch (e) {
					if (bound.aborted) throw e;
					// A session Claude Code no longer has starts afresh.
					this.q.close();
					await start(false);
				}
			} else await start(false);
		} catch (e) { throw this.failed('start', e); }
		if (this.id !== t.session) this.o.created(this.id);
		void this.pump();
	}

	/** pump takes what Claude Code sends until it ends. */
	private async pump() {
		try {
			for await (const m of this.q) this.receive(m);
		} catch (e) {
			this.current?.done({ err: e, signedOut: signedOut.test(String((e as Error).message ?? e)), usage: [] });
			this.current = undefined;
		}
		this.close();
	}

	private update(u: Update) { if (!this.ended) this.o.handler.update(u); }

	private receive(m: SDKMessage) {
		const c = this.current;
		switch (m.type) {
			case 'system':
				if (m.subtype === 'init' && m.model && m.model !== this.model) {
					this.model = m.model;
					this.update({ type: 'model', model: m.model });
				}
				return;
			case 'stream_event': {
				if (m.parent_tool_use_id) return;
				const e = m.event;
				if (e.type !== 'content_block_delta') return;
				if (e.delta.type === 'text_delta') this.update({ type: 'text', text: e.delta.text });
				else if (e.delta.type === 'thinking_delta') this.update({ type: 'reasoning', text: e.delta.thinking });
				return;
			}
			case 'assistant': {
				const msg = m.message;
				if (c && msg.id && !c.seen.has(msg.id) && msg.usage) {
					// One request may arrive as several messages, each with its usage.
					c.seen.add(msg.id);
					const u = usage(msg.usage);
					c.usage.set(msg.model, add(c.usage.get(msg.model) ?? { inputTokens: 0, outputTokens: 0 }, u));
					if (!m.parent_tool_use_id) [c.context, c.model] = [u.inputTokens + u.outputTokens, msg.model];
				}
				if (m.parent_tool_use_id) return;
				for (const b of msg.content) {
					if (b.type !== 'tool_use') continue;
					const input = (b.input ?? {}) as Record<string, unknown>;
					if (b.name === 'TodoWrite') {
						const todos = (input.todos ?? []) as { content?: string; status?: string }[];
						this.update({ type: 'plan', entries: todos.map(x => ({ content: String(x.content ?? ''), status: String(x.status ?? 'pending') })) });
						continue;
					}
					const shown = call(b.name, input);
					this.update({ type: 'tool', start: true, id: b.id, title: shown.title, kind: shown.kind, locations: shown.locations, input, status: 'pending', content: shown.content });
				}
				return;
			}
			case 'user': {
				if (m.parent_tool_use_id || typeof m.message.content === 'string') return;
				for (const b of m.message.content) {
					if (b.type !== 'tool_result') continue;
					const out = text(b.content);
					this.update({ type: 'tool', start: false, id: b.tool_use_id, status: b.is_error ? 'failed' : 'completed', content: out ? [{ type: 'text', text: out }] : undefined, output: out });
				}
				return;
			}
			case 'result': {
				if (!c) return;
				this.current = undefined;
				const costs = new Map(Object.entries(m.modelUsage).map(([model, u]) => [model, u.costUSD]));
				const rows: ModelUsage[] = [...c.usage].map(([model, usage]) => ({ model, usage }));
				if (this.costs) {
					// What each model cost in this prompt; a model that only did Claude Code's own work, such as titles, has a row of its own.
					for (const [model, total] of costs) {
						const spent = total - (this.costs.get(model) ?? 0);
						if (!(spent > 0)) continue;
						const row = rows.find(r => r.model === model);
						if (row) row.usage = { ...row.usage, cost: spent };
						else rows.push({ model, usage: { inputTokens: 0, outputTokens: 0, cost: spent } });
					}
				}
				this.costs = costs;
				const size = m.modelUsage[c.model]?.contextWindow;
				if (size && c.context) this.update({ type: 'context', used: c.context, size });
				let reason: StopReason | undefined;
				let err: unknown;
				if (this.cancelling) reason = 'cancelled';
				else if (m.subtype === 'success' && !m.is_error) reason = m.stop_reason === 'max_tokens' || m.stop_reason === 'refusal' ? m.stop_reason : 'end_turn';
				else if (m.subtype === 'error_max_turns') reason = 'max_turn_requests';
				else err = new Error(m.subtype === 'success' ? m.result : m.errors.join('; ') || m.subtype);
				this.cancelling = false;
				c.done({ reason, err, signedOut: !!err && signedOut.test(String((err as Error).message)), usage: rows });
				return;
			}
		}
	}

	/** permission asks Mob before a call of Claude Code's. */
	private async permission(name: string, input: Record<string, unknown>, id: string, signal: AbortSignal): Promise<PermissionResult> {
		const shown = call(name, input);
		const asked = this.o.handler.permission({ id, title: shown.title, kind: shown.kind, locations: shown.locations, input });
		const aborted = new Promise<'cancel'>(r => signal.addEventListener('abort', () => r('cancel'), { once: true }));
		const choice = await Promise.race([asked, aborted, this.end.promise.then(() => 'cancel' as const)]);
		if (choice === 'allow' || choice === 'always') return { behavior: 'allow', updatedInput: input };
		if (choice === 'reject') return { behavior: 'deny', message: 'The owner declined this call.' };
		return { behavior: 'deny', message: 'The owner did not answer.', interrupt: true };
	}

	prompt(words: string): Promise<Ending> {
		if (this.ended) return Promise.resolve({ err: new Error('the agent exited'), usage: [] });
		const p = Promise.withResolvers<Ending>();
		this.current = { done: p.resolve, usage: new Map(), seen: new Set(), context: 0, model: this.model };
		this.input.push({ type: 'user', message: { role: 'user', content: words }, parent_tool_use_id: null, session_id: this.id });
		return p.promise;
	}

	cancel() {
		if (!this.current) return;
		this.cancelling = true;
		this.q.interrupt().catch(() => {});
	}
}

/** claudeRuntime drives Claude Code through run, the SDK's query unless a test gives its own. */
export function claudeRuntime(run: typeof query = query): Runtime {
	return {
		spawns: true,
		reads: () => true,
		async open(o, signal) {
			const s = new Session(o, run);
			try {
				await s.open(signal);
				return s;
			} catch (e) {
				s.close();
				throw e;
			}
		},
	};
}

export const claude = claudeRuntime();
