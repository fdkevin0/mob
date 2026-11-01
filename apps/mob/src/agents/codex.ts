// The Codex runtime: Codex's own app server (`codex app-server`), the
// protocol every Codex surface is built on, spoken as JSON lines on the
// agent's standard input and output. It reports what each turn used, which
// Codex's ACP adapter does not.
import type { llm } from '@mob/core';
import { version } from '../version';
import { failed, message, signIn, type AgentSession, type Choice, type Ending, type Options, type Runtime, type ToolContent, type ToolKind, type ToolStatus, type Update } from './runtime';

/** openWait bounds starting a session. */
const openWait = 2 * 60_000;

/** keys are the environment variables Codex takes an API key from instead of a saved sign-in. */
const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

/** Deferred is a promise with its own settling functions. */
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };

type Message = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** RPC is JSON-RPC over JSON lines, without the "jsonrpc" member, as the app server speaks it. */
class RPC {
	private next = 0;
	private waiting = new Map<number, Deferred<unknown>>();
	private writer: WritableStreamDefaultWriter<Uint8Array>;
	readonly closed: Promise<void>;

	constructor(input: WritableStream<Uint8Array>, output: ReadableStream<Uint8Array>,
		private notified: (method: string, params: unknown) => void,
		private requested: (method: string, params: unknown) => Promise<unknown>) {
		this.writer = input.getWriter();
		this.closed = this.read(output).catch(() => {}).finally(() => {
			for (const w of this.waiting.values()) w.reject(new Error('the agent exited'));
			this.waiting.clear();
		});
	}

	private async read(output: ReadableStream<Uint8Array>) {
		let rest = '';
		const decoder = new TextDecoder();
		for await (const chunk of output) {
			const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
			rest = lines.pop()!;
			for (const line of lines) if (line.trim()) this.receive(line);
		}
	}

	private receive(line: string) {
		let m: Message;
		try { m = JSON.parse(line); } catch { return; }
		if (m.method !== undefined && m.id !== undefined) {
			const id = m.id;
			this.requested(m.method, m.params).then(
				result => this.write({ id, result }),
				err => this.write({ id, error: { code: (err as { code?: number }).code ?? -32603, message: message(err) } }));
		} else if (m.method !== undefined) this.notified(m.method, m.params);
		else if (typeof m.id === 'number') {
			const w = this.waiting.get(m.id);
			this.waiting.delete(m.id);
			if (m.error) w?.reject(m.error);
			else w?.resolve(m.result);
		}
	}

	private write(m: Message) { this.writer.write(new TextEncoder().encode(JSON.stringify(m) + '\n')).catch(() => {}); }

	request<T>(method: string, params: unknown): Promise<T> {
		const id = ++this.next;
		const w = Promise.withResolvers<unknown>();
		this.waiting.set(id, w);
		this.write({ id, method, params });
		return w.promise as Promise<T>;
	}

	notify(method: string, params?: unknown) { this.write(params === undefined ? { method } : { method, params }); }
}

type Tokens = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
type TurnError = { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null };
type Turn = { id: string; status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error: TurnError | null };
type Change = { path: string; kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }; diff: string };
type Item = { type: string; id: string; [k: string]: unknown };
type Thread = { thread: { id: string }; model: string };

/** usage is what tokens from counted, as Mob counts them: input includes cached input, as OpenAI's does. */
const usage = (t: Tokens): llm.Usage => ({
	inputTokens: t.inputTokens, outputTokens: t.outputTokens, reasoningTokens: t.reasoningOutputTokens,
	cacheReadTokens: t.cachedInputTokens, cacheWriteTokens: t.cacheWriteInputTokens,
});

const minus = (a: Tokens, b: Tokens): Tokens => ({
	totalTokens: a.totalTokens - b.totalTokens, inputTokens: a.inputTokens - b.inputTokens, cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
	cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens, outputTokens: a.outputTokens - b.outputTokens, reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
});

/** status is an item's status as a tool call's. */
function status(s: unknown): ToolStatus {
	if (s === 'completed') return 'completed';
	if (s === 'failed' || s === 'declined') return 'failed';
	return 'in_progress';
}

/** changeKind is what a file change does, as a tool call's kind. */
function changeKind(changes: Change[]): ToolKind {
	if (changes.length && changes.every(c => c.kind.type === 'delete')) return 'delete';
	if (changes.length && changes.every(c => c.kind.type === 'update' && c.kind.move_path)) return 'move';
	return 'edit';
}

/** tool is the tool call an item shows, for the items that are calls. */
function tool(item: Item, start: boolean): Update | undefined {
	const s = start ? 'in_progress' : status(item.status);
	switch (item.type) {
		case 'commandExecution': {
			const out = typeof item.aggregatedOutput === 'string' && item.aggregatedOutput ? [{ type: 'text' as const, text: item.aggregatedOutput }] : undefined;
			return { type: 'tool', start, id: item.id, title: String(item.command ?? ''), kind: 'execute', input: { command: item.command, cwd: item.cwd }, status: s, content: start ? undefined : out, output: start ? undefined : { exitCode: item.exitCode } };
		}
		case 'fileChange': {
			const changes = (item.changes ?? []) as Change[];
			const content: ToolContent[] = changes.map(c => ({ type: 'text', text: '--- ' + c.path + '\n' + c.diff }));
			return { type: 'tool', start, id: item.id, title: 'Edit ' + changes.map(c => c.path).join(', '), kind: changeKind(changes), locations: changes.flatMap(c => c.kind.move_path ? [c.path, c.kind.move_path] : [c.path]), status: s, content };
		}
		case 'mcpToolCall': {
			const result = item.result as { content?: { type: string; text?: string }[] } | null;
			const error = item.error as { message?: string } | null;
			const text = error?.message ?? result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
			return { type: 'tool', start, id: item.id, title: `${item.server}.${item.tool}`, kind: 'other', input: item.arguments, status: s, content: !start && text ? [{ type: 'text', text }] : undefined };
		}
		case 'dynamicToolCall':
			return { type: 'tool', start, id: item.id, title: String(item.tool ?? ''), kind: 'other', input: item.arguments, status: start ? s : item.success === false ? 'failed' : 'completed' };
		case 'webSearch':
			return { type: 'tool', start, id: item.id, title: 'Search the web', kind: 'fetch', input: item.query !== undefined ? { query: item.query } : undefined, status: start ? s : 'completed' };
	}
	return undefined;
}

/** Session is an open Codex thread. */
class Session implements AgentSession {
	id = '';
	model = '';
	readonly closed: Promise<void>;
	private rpc: RPC;
	private ended = false;
	private end = Promise.withResolvers<void>();
	/** turn is the running turn's ID, and its ending once it ends. */
	private turn = '';
	private ending?: Deferred<Ending>;
	private cancelled = false;
	/** items are the calls of the running turn, by ID, which approval requests name. */
	private items = new Map<string, Item>();
	/** streamed are the agent messages whose text arrived in parts. */
	private streamed = new Set<string>();
	/** before is the thread's total before the running turn; total its latest. */
	private before?: Tokens;
	private total?: Tokens;

	constructor(private o: Options) {
		this.rpc = new RPC(o.conn.input, o.conn.output, (m, p) => this.notified(m, p), (m, p) => this.requested(m, p));
		this.closed = this.rpc.closed;
		void this.closed.then(() => {
			this.ending?.resolve({ err: new Error('it exited'), usage: [] });
			this.close();
		});
	}

	stderr() { return this.o.conn.stderr?.() ?? ''; }

	close() {
		if (this.ended) return;
		this.ended = true;
		this.end.resolve();
		this.o.conn.stop();
	}

	private failed(what: string, err: unknown) { return failed(this.o.preset.title, what, err, this.stderr()); }

	async open(signal: AbortSignal) {
		const { task: t } = this.o;
		const bound = AbortSignal.any([signal, AbortSignal.timeout(openWait)]);
		const within = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
			if (bound.aborted) return reject(bound.reason);
			const stop = () => reject(bound.reason);
			bound.addEventListener('abort', stop, { once: true });
			work.then(resolve, reject).finally(() => bound.removeEventListener('abort', stop));
		});
		try {
			await within(this.rpc.request('initialize', { clientInfo: { name: 'mob', title: 'Mob', version }, capabilities: { experimentalApi: false, requestAttestation: false } }));
		} catch (e) { throw this.failed('start', e); }
		this.rpc.notify('initialized');
		let account: { account: unknown; requiresOpenaiAuth: boolean };
		try { account = await within(this.rpc.request('account/read', { refreshToken: false })); } catch (e) { throw this.failed('start', e); }
		// A key in the environment signs Codex in without a saved account.
		if (!account.account && account.requiresOpenaiAuth && !keys.some(k => process.env[k])) throw signIn(this.o.preset);
		// Mob's MCP server is a streamable HTTP server Codex reaches with its headers.
		const config: Record<string, unknown> = {};
		for (const s of this.o.servers(true)) {
			config[`mcp_servers.${s.name}.url`] = s.url;
			config[`mcp_servers.${s.name}.http_headers`] = s.headers;
		}
		// Codex works in the worktree on its own and asks before anything else; a reader cannot write at all.
		const settings = { cwd: t.worktree, approvalPolicy: 'on-request', sandbox: t.readOnly ? 'read-only' : 'workspace-write', config };
		let thread: Thread | undefined;
		if (t.session) {
			try { thread = await within(this.rpc.request<Thread>('thread/resume', { threadId: t.session, ...settings, excludeTurns: true })); } catch (e) { if (bound.aborted) throw e; }
		}
		if (!thread) {
			try { thread = await within(this.rpc.request<Thread>('thread/start', settings)); } catch (e) { throw this.failed('start a session', e); }
			this.o.created(thread.thread.id);
		}
		[this.id, this.model] = [thread.thread.id, thread.model];
	}

	prompt(text: string): Promise<Ending> {
		const ending = Promise.withResolvers<Ending>();
		[this.ending, this.turn, this.cancelled, this.before] = [ending, '', false, this.total];
		this.items.clear();
		this.streamed.clear();
		this.rpc.request<{ turn: Turn }>('turn/start', { threadId: this.id, input: [{ type: 'text', text, text_elements: [] }] }).then(r => {
			this.turn = r.turn.id;
			if (this.cancelled) this.cancel();
		}, err => ending.resolve({ err, usage: [] }));
		return ending.promise.finally(() => { if (this.ending === ending) this.ending = undefined; });
	}

	cancel() {
		this.cancelled = true;
		if (this.turn) this.rpc.request('turn/interrupt', { threadId: this.id, turnId: this.turn }).catch(() => {});
	}

	/** completed ends the running prompt with how turn ended and what it used. */
	private completed(turn: Turn) {
		const ending = this.ending;
		if (!ending || (this.turn && turn.id !== this.turn)) return;
		const used = this.total && this.before ? minus(this.total, this.before) : this.total;
		const rows = used && (used.inputTokens > 0 || used.outputTokens > 0) ? [{ model: '', usage: usage(used) }] : [];
		if (turn.status === 'interrupted') return ending.resolve({ reason: 'cancelled', usage: rows });
		if (turn.status === 'failed') {
			const e = turn.error;
			if (e?.codexErrorInfo === 'unauthorized') return ending.resolve({ signedOut: true, usage: rows });
			if (e?.codexErrorInfo === 'contextWindowExceeded') return ending.resolve({ reason: 'max_tokens', usage: rows });
			return ending.resolve({ err: new Error((e?.message ?? 'the turn failed') + (e?.additionalDetails ? ': ' + e.additionalDetails : '')), usage: rows });
		}
		ending.resolve({ reason: 'end_turn', usage: rows });
	}

	private update(u: Update) { this.o.handler.update(u); }

	private notified(method: string, params: unknown) {
		const p = params as { threadId?: string; turnId?: string; [k: string]: unknown };
		if (p?.threadId !== undefined && p.threadId !== this.id) return;
		switch (method) {
			case 'item/agentMessage/delta':
				this.streamed.add(String(p.itemId));
				return this.update({ type: 'text', text: String(p.delta) });
			case 'item/reasoning/summaryTextDelta':
				return this.update({ type: 'reasoning', text: String(p.delta) });
			case 'item/started': case 'item/completed': {
				const item = p.item as Item;
				const start = method === 'item/started';
				if (item.type === 'agentMessage' && !start && !this.streamed.has(item.id) && item.text) return this.update({ type: 'text', text: String(item.text) });
				const u = tool(item, start);
				if (!u) return;
				this.items.set(item.id, item);
				return this.update(u);
			}
			case 'turn/plan/updated': {
				const plan = p.plan as { step: string; status: string }[];
				return this.update({ type: 'plan', entries: plan.map(s => ({ content: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status })) });
			}
			case 'thread/tokenUsage/updated': {
				const u = p.tokenUsage as { total: Tokens; last: Tokens; modelContextWindow: number | null };
				// The total before the first turn this session sees is the total less that turn's first request.
				this.before ??= minus(u.total, u.last);
				this.total = u.total;
				if (u.modelContextWindow) this.update({ type: 'context', used: u.last.totalTokens, size: u.modelContextWindow });
				return;
			}
			case 'model/rerouted':
				this.model = String(p.toModel);
				return this.update({ type: 'model', model: this.model });
			case 'turn/completed': return this.completed(p.turn as Turn);
		}
	}

	/** ask is the owner's, or Mob's, answer to what the agent asks before a call. */
	private ask(r: Parameters<Options['handler']['permission']>[0]): Promise<Choice> {
		return Promise.race([this.o.handler.permission(r), this.end.promise.then(() => 'cancel' as const)]);
	}

	private async requested(method: string, params: unknown): Promise<unknown> {
		const p = params as { itemId: string; [k: string]: unknown };
		switch (method) {
			case 'item/commandExecution/requestApproval': {
				const command = typeof p.command === 'string' ? p.command : '';
				const choice = await this.ask({ id: p.itemId, title: command || (p.reason as string | undefined), kind: 'execute', input: { command: p.command, cwd: p.cwd, reason: p.reason, network: p.networkApprovalContext ?? undefined } });
				return { decision: ({ allow: 'accept', always: 'acceptForSession', reject: 'decline', cancel: 'cancel' } as const)[choice] };
			}
			case 'item/fileChange/requestApproval': {
				const item = this.items.get(p.itemId);
				const changes = (item?.changes ?? []) as Change[];
				const files = changes.flatMap(c => c.kind.move_path ? [c.path, c.kind.move_path] : [c.path]);
				// Writing under another root asks for that root, which is what an approval of it covers.
				const root = typeof p.grantRoot === 'string' ? p.grantRoot : '';
				const choice = await this.ask({ id: p.itemId, title: root ? 'Write in ' + root : 'Edit ' + files.join(', '), kind: changeKind(changes), locations: root ? [...files, root] : files, input: { reason: p.reason, root: root || undefined } });
				return { decision: ({ allow: 'accept', always: 'acceptForSession', reject: 'decline', cancel: 'cancel' } as const)[choice] };
			}
			case 'item/permissions/requestApproval': {
				const choice = await this.ask({ id: p.itemId, title: 'Grant ' + JSON.stringify(p.permissions), kind: 'other', input: { permissions: p.permissions, reason: p.reason } });
				const granted = choice === 'allow' || choice === 'always';
				return { permissions: granted ? p.permissions : {}, scope: choice === 'always' ? 'session' : 'turn' };
			}
			// Mob has no way to ask the owner for a form's answers.
			case 'mcpServer/elicitation/request': return { action: 'decline', content: null, _meta: null };
			case 'item/tool/requestUserInput': return { answers: {} };
		}
		throw Object.assign(new Error(`Mob does not answer ${method}`), { code: -32601 });
	}
}

export const codex: Runtime = {
	reads: () => true,
	async open(o, signal) {
		const s = new Session(o);
		try {
			await s.open(signal);
			return s;
		} catch (e) {
			s.close();
			throw e;
		}
	},
};
