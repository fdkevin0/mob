// The Agent Client Protocol driver: agents that run an ACP server on their
// standard input and output, which is every agent Mob knows so far.
import {
	ClientSideConnection, PROTOCOL_VERSION, ndJsonStream,
	type Client, type McpServer as ACPMcpServer, type PermissionOption, type RequestPermissionOutcome, type SessionConfigOption,
	type SessionModeState, type SessionUpdate, type ToolCallContent, type ToolCallLocation, type Usage as ACPUsage,
} from '@agentclientprotocol/sdk';
import { version } from '../version';
import { failed, signIn, type AgentSession, type Choice, type Ending, type McpServer, type ModelUsage, type Options, type Runtime, type ToolContent, type Update } from './runtime';
import { normal } from './usage';

/** openWait bounds starting a session. */
const openWait = 2 * 60_000;

/** authRequired reports whether err is the agent asking to be signed in. */
const authRequired = (err: unknown) => (err as { code?: number } | undefined)?.code === -32000;

/** kinds are the option kinds that answer with each choice, in the order they are looked for. */
const kinds: Record<Exclude<Choice, 'cancel'>, string[]> = {
	allow: ['allow_once', 'allow_always'],
	always: ['allow_always', 'allow_once'],
	reject: ['reject_once', 'reject_always'],
};

/** outcome is the option of the first kind choice looks for that the request offers. */
export function outcome(choice: Choice, options: PermissionOption[]): RequestPermissionOutcome {
	if (choice !== 'cancel') {
		for (const kind of kinds[choice]) {
			const o = options.find(o => o.kind === kind);
			if (o) return { outcome: 'selected', optionId: o.optionId };
		}
	}
	return { outcome: 'cancelled' };
}

/** paths are the files of locations; null, which clears them, and undefined, which leaves them, pass through. */
const paths = (l?: ToolCallLocation[] | null) => l === null ? null : l?.map(l => l.path);

/** content is what a call shows, in the port's terms. */
function content(c?: ToolCallContent[] | null): ToolContent[] | undefined {
	if (!c) return undefined;
	const out: ToolContent[] = [];
	for (const x of c) {
		if (x.type === 'content' && x.content.type === 'text') out.push({ type: 'text', text: x.content.text });
		else if (x.type === 'diff') out.push({ type: 'diff', path: x.path, newText: x.newText, oldText: x.oldText });
	}
	return out;
}

/** update is u in the port's terms; nothing for the updates Mob does not show. */
export function update(u: SessionUpdate): Update | undefined {
	switch (u.sessionUpdate) {
		case 'agent_message_chunk': return u.content.type === 'text' ? { type: 'text', text: u.content.text } : undefined;
		case 'agent_thought_chunk': return u.content.type === 'text' ? { type: 'reasoning', text: u.content.text } : undefined;
		case 'tool_call': return { type: 'tool', start: true, id: u.toolCallId, title: u.title, kind: u.kind, locations: paths(u.locations), input: u.rawInput, status: u.status, content: content(u.content), output: u.rawOutput };
		case 'tool_call_update': return { type: 'tool', start: false, id: u.toolCallId, title: u.title, kind: u.kind, locations: paths(u.locations), input: u.rawInput, status: u.status, content: content(u.content), output: u.rawOutput };
		case 'usage_update': return { type: 'context', used: u.used, size: u.size, cost: u.cost };
		case 'config_option_update': {
			const model = modelOption(u.configOptions);
			return model ? { type: 'model', model } : undefined;
		}
		case 'plan': return { type: 'plan', entries: u.entries.map(e => ({ content: e.content, status: e.status })) };
	}
	return undefined;
}

/** modelOption is the model a session's options select, if they name one. */
export function modelOption(options?: SessionConfigOption[] | null): string {
	for (const o of options ?? []) {
		if (o.type !== 'select' || o.category !== 'model') continue;
		const value = String(o.currentValue);
		// DeepSeek Harness names a model by its route: ["provider","model"].
		try {
			const route = JSON.parse(value);
			if (Array.isArray(route) && route.length) return String(route[route.length - 1]);
		} catch { /* a plain name */ }
		return value;
	}
	return '';
}

type Tokens = { inputTokens?: number; cachedInputTokens?: number; cachedWriteTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number };

/** reported is what a prompt's response says it used, by model when its metadata breaks it down as Claude Agent's does. */
export function reported(u?: ACPUsage | null, meta?: Record<string, unknown> | null): ModelUsage[] {
	if (!u) return [];
	const total = normal(u.inputTokens, u.cachedReadTokens ?? 0, u.cachedWriteTokens ?? 0, u.outputTokens, u.thoughtTokens ?? 0, u.totalTokens);
	if (!total.inputTokens && !total.outputTokens) return [];
	const models = (meta?.quota as { model_usage?: { model?: string; token_count?: Tokens }[] } | undefined)?.model_usage;
	if (Array.isArray(models) && models.length) {
		const rows = models.map(m => {
			const t = m.token_count ?? {};
			return { model: m.model ?? '', usage: normal(t.inputTokens ?? 0, t.cachedInputTokens ?? 0, t.cachedWriteTokens ?? 0, t.outputTokens ?? 0, t.reasoningOutputTokens ?? 0, t.totalTokens ?? 0) };
		});
		// The breakdown is used only when it accounts for the whole.
		const input = rows.reduce((n, r) => n + r.usage.inputTokens, 0), output = rows.reduce((n, r) => n + r.usage.outputTokens, 0);
		if (input === total.inputTokens && output === total.outputTokens) return rows;
	}
	return [{ model: '', usage: total }];
}

const servers = (list: McpServer[]): ACPMcpServer[] =>
	list.map(s => ({ type: 'http', name: s.name, url: s.url, headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })) }));

/** Session is an open ACP session. */
class Session implements AgentSession {
	id = '';
	model = '';
	readonly conn: ClientSideConnection;
	readonly closed: Promise<void>;
	/** loading is set while the agent replays a session it loads, which the conversation already shows. */
	private loading = false;
	private ended = false;
	private end = Promise.withResolvers<void>();

	constructor(private o: Options) {
		this.conn = new ClientSideConnection(() => this.client(), ndJsonStream(o.conn.input, o.conn.output));
		this.closed = this.conn.closed.then(() => {}, () => {});
		void this.closed.then(() => this.close());
	}

	stderr() { return this.o.conn.stderr?.() ?? ''; }

	close() {
		if (this.ended) return;
		this.ended = true;
		this.end.resolve();
		this.o.conn.stop();
	}

	failed(what: string, err: unknown) { return failed(this.o.preset.title, what, err, this.stderr()); }

	async open(signal: AbortSignal) {
		const { preset: p, task: t } = this.o;
		const bound = AbortSignal.any([signal, AbortSignal.timeout(openWait)]);
		const within = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
			if (bound.aborted) return reject(bound.reason);
			const stop = () => reject(bound.reason);
			bound.addEventListener('abort', stop, { once: true });
			work.then(resolve, reject).finally(() => bound.removeEventListener('abort', stop));
		});
		let init;
		try { init = await within(this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'mob', version }, clientCapabilities: {} })); } catch (e) { throw this.failed('start', e); }
		const caps = init.agentCapabilities ?? {};
		const mcp = servers(this.o.servers(!!caps.mcpCapabilities?.http));
		let modes: SessionModeState | null | undefined;
		if (t.session && caps.loadSession) {
			// The agent replays the session while loading it; the conversation already shows it.
			this.loading = true;
			try {
				const loaded = await within(this.conn.loadSession({ sessionId: t.session, cwd: t.worktree, mcpServers: mcp }));
				[this.id, modes, this.model] = [t.session, loaded.modes, modelOption(loaded.configOptions)];
			} catch (e) { if (bound.aborted) throw e; }
			this.loading = false;
		} else if (t.session && (caps.sessionCapabilities as { resume?: unknown } | undefined)?.resume) {
			// Resuming restores the session without replaying it.
			try {
				const resumed = await within(this.conn.resumeSession({ sessionId: t.session, cwd: t.worktree, mcpServers: mcp }));
				[this.id, modes, this.model] = [t.session, resumed.modes, modelOption(resumed.configOptions)];
			} catch (e) { if (bound.aborted) throw e; }
		}
		if (!this.id) {
			const created = await this.newSession(within, init.authMethods ?? [], mcp);
			[this.id, modes, this.model] = [created.sessionId, created.modes, modelOption(created.configOptions)];
			this.o.created(this.id);
		}
		let mode = p.mode ?? '';
		const offered = (m: string) => !!modes?.availableModes.some(o => o.id === m);
		if (t.readOnly) {
			// A reader that cannot be kept from editing does not start.
			mode = p.readOnly ?? '';
			if (!mode || !offered(mode)) throw this.failed('work read-only', new Error(`it offers no ${JSON.stringify(mode)} mode`));
		}
		if (mode && modes && modes.currentModeId !== mode && offered(mode)) {
			try { await within(this.conn.setSessionMode({ sessionId: this.id, modeId: mode })); } catch (e) { throw this.failed('set its mode', e); }
		}
	}

	/** newSession creates a session in the task's worktree, signing in first with the environment variables an agent accepts, when it asks to and they are set. */
	private async newSession(within: <T>(p: Promise<T>) => Promise<T>, methods: unknown[], mcp: ACPMcpServer[]) {
		const request = { cwd: this.o.task.worktree, mcpServers: mcp };
		try { return await within(this.conn.newSession(request)); } catch (e) {
			if (!authRequired(e)) throw this.failed('start a session', e);
		}
		for (const m of methods as { type?: string; id: string; vars?: { name: string }[] }[]) {
			if (m.type !== 'env_var' || !m.vars?.some(v => process.env[v.name])) continue;
			try {
				await within(this.conn.authenticate({ methodId: m.id }));
				return await within(this.conn.newSession(request));
			} catch { /* the next method */ }
		}
		throw signIn(this.o.preset);
	}

	prompt(text: string): Promise<Ending> {
		return this.conn.prompt({ sessionId: this.id, prompt: [{ type: 'text', text }] }).then(
			r => ({ reason: r.stopReason, usage: reported(r.usage, r._meta) }),
			// Claude Agent finds out it is not signed in only when it answers.
			err => ({ err, signedOut: authRequired(err), usage: [] }));
	}

	cancel() { this.conn.cancel({ sessionId: this.id }).catch(() => {}); }

	/** client answers the agent's requests for the session. Mob offers agents no file system or terminal of its own: they use their own in the worktree. */
	private client(): Client {
		const h = this.o.handler;
		return {
			sessionUpdate: async n => {
				if (this.loading) return;
				const u = update(n.update);
				if (u) h.update(u);
			},
			requestPermission: async request => {
				const tc = request.toolCall;
				const answer = h.permission({ id: tc.toolCallId, title: tc.title, kind: tc.kind, locations: paths(tc.locations), input: tc.rawInput });
				const choice = await Promise.race([answer, this.end.promise.then(() => 'cancel' as const)]);
				return { outcome: outcome(choice, request.options) };
			},
		};
	}
}

export const acp: Runtime = {
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
