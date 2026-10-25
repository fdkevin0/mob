// One running agent working on one task: an ACP session followed into the
// task's conversation, with the permissions it asks for as the owner's approvals.
import {
	ClientSideConnection, PROTOCOL_VERSION, ndJsonStream,
	type Client, type McpServer, type PromptResponse, type RequestPermissionOutcome, type RequestPermissionRequest,
	type SessionModeState, type SessionUpdate, type StopReason, type ToolCallContent, type ToolCallLocation, type ToolKind, type Usage as ACPUsage,
} from '@agentclientprotocol/sdk';
import { Aborted, rememberAlways, taskFailed, taskReview, taskRunning, taskStopped, taskWaiting, type Answer, type Decision, type DelegateTurn, type Task } from '@mob/core';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { version } from '../version';
import type { Conn } from './process';
import type { Preset } from './presets';
import type { Service } from './service';
import { modelOption, reported, type ModelUsage } from './usage';

/** approvalWait is how long the agent waits for the owner to decide, as long as Mob keeps an approval. */
export const approvalWait = 60 * 60_000;
/** cancelWait is how long a stopped prompt may take to end before the agent is ended with it. */
const cancelWait = 10_000;
/** openWait bounds starting a session. */
const openWait = 2 * 60_000;
/** outputLimit bounds each text a tool call's output shows. */
const outputLimit = 16 << 10;

type Call = { name: string; input: Record<string, unknown>; title: string; kind?: ToolKind | null; locations?: ToolCallLocation[] | null; raw?: unknown };

type Ending = { reason?: StopReason; err?: unknown; usage?: ACPUsage | null; meta?: Record<string, unknown> | null; began: number };

/** Item is one thing the agent sent: an update, a permission request, or the end of a prompt. */
type Item = { update: SessionUpdate } | { permission: Permission } | { end: Ending };

const cancelled: RequestPermissionOutcome = { outcome: 'cancelled' };

/** Permission is a request waiting for the owner's answer. */
export class Permission {
	/** tool and scope are what remembering an approval of it covers. */
	tool = '';
	scope = '';
	timer?: ReturnType<typeof setTimeout>;
	readonly answer: Promise<RequestPermissionOutcome>;
	private resolve!: (o: RequestPermissionOutcome) => void;
	private given = false;
	/** once is set for Mob's own requests, which are never remembered. */
	constructor(readonly request: RequestPermissionRequest, readonly once = false) {
		this.answer = new Promise(r => { this.resolve = r; });
	}

	/** give answers the request, unless it is answered already. */
	give(o: RequestPermissionOutcome) {
		if (this.given) return;
		this.given = true;
		this.resolve(o);
	}

	cancel() { clearTimeout(this.timer); this.give(cancelled); }

	/** choose answers with the request's first option of the first kind it offers. */
	choose(...kinds: string[]) {
		clearTimeout(this.timer);
		for (const kind of kinds) {
			const o = this.request.options.find(o => o.kind === kind);
			if (o) return this.give({ outcome: 'selected', optionId: o.optionId });
		}
		this.give(cancelled);
	}
}

const allow = ['allow_once', 'allow_always'], allowAlways = ['allow_always', 'allow_once'], reject = ['reject_once', 'reject_always'];

/** authRequired reports whether err is the agent asking to be signed in. */
const authRequired = (err: unknown) => (err as { code?: number } | undefined)?.code === -32000;

const message = (err: unknown) => {
	if (err instanceof Error) return err.message;
	const e = err as { message?: string; data?: unknown } | undefined;
	if (e?.message) return e.data ? `${e.message}: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}` : e.message;
	return String(err);
};

// ansi matches terminal colour codes, which agents write to standard error.
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;

export class Session {
	conn!: ClientSideConnection;
	id = '';
	/** token lets the agent reach Mob's MCP server. */
	token = '';
	/** model is the model the session's options select. */
	model = '';
	private items: Item[] = [];
	private waiters = new Set<() => void>();
	private closed = false;
	/** ended settles when the session closes. */
	private ended = Promise.withResolvers<void>();
	private loading = false;
	/** prompting is set while a prompt runs; queue holds what the owner said meanwhile, sent once it ends. */
	private prompting = false;
	private queue: string[] = [];
	/** pending are the permission requests the owner was asked, by approval ID. */
	private pending = new Map<string, Permission>();
	/** calls are the tool calls the agent made, to show their results in a later turn than the one that started them. */
	private calls = new Map<string, Call>();
	/** cost is the cost the agent last reported for its run, unpriced what of it no prompt's end recorded yet. */
	private cost = 0;
	private unpriced = 0;

	private constructor(private svc: Service, readonly preset: Preset, readonly task: Task, private stopAgent: () => void, private stderr: () => string) {}

	/** open starts an ACP session with the agent on conn: the task's own, loaded again, or a new one in its worktree. */
	static async open(svc: Service, p: Preset, t: Task, conn: Conn, signal: AbortSignal): Promise<Session> {
		const s = new Session(svc, p, t, conn.stop, conn.stderr ?? (() => ''));
		s.conn = new ClientSideConnection(() => s.client(), ndJsonStream(conn.input, conn.output));
		void s.conn.closed.then(() => s.close(), () => s.close());
		const bound = AbortSignal.any([signal, AbortSignal.timeout(openWait)]);
		const within = <T>(work: Promise<T>) => new Promise<T>((resolve, reject) => {
			if (bound.aborted) return reject(bound.reason);
			const stop = () => reject(bound.reason);
			bound.addEventListener('abort', stop, { once: true });
			work.then(resolve, reject).finally(() => bound.removeEventListener('abort', stop));
		});
		try {
			let init;
			try { init = await within(s.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'mob', version }, clientCapabilities: {} })); } catch (e) { throw s.failed('start', e); }
			const caps = init.agentCapabilities ?? {};
			const { servers, token } = svc.mcpServers(t, !!caps.mcpCapabilities?.http);
			s.token = token;
			let modes: SessionModeState | null | undefined;
			if (t.session && caps.loadSession) {
				// The agent replays the session while loading it; the conversation already shows it.
				s.loading = true;
				try {
					const loaded = await within(s.conn.loadSession({ sessionId: t.session, cwd: t.worktree, mcpServers: servers }));
					[s.id, modes, s.model] = [t.session, loaded.modes, modelOption(loaded.configOptions)];
				} catch (e) { if (bound.aborted) throw e; }
				s.loading = false;
			} else if (t.session && (caps.sessionCapabilities as { resume?: unknown } | undefined)?.resume) {
				// Resuming restores the session without replaying it.
				try {
					const resumed = await within(s.conn.resumeSession({ sessionId: t.session, cwd: t.worktree, mcpServers: servers }));
					[s.id, modes, s.model] = [t.session, resumed.modes, modelOption(resumed.configOptions)];
				} catch (e) { if (bound.aborted) throw e; }
			}
			if (!s.id) {
				const created = await s.newSession(within, init.authMethods ?? [], servers);
				[s.id, modes, s.model] = [created.sessionId, created.modes, modelOption(created.configOptions)];
				svc.store.setTaskSession(t.id, s.id);
			}
			let mode = p.mode ?? '';
			const offered = (m: string) => !!modes?.availableModes.some(o => o.id === m);
			if (t.readOnly) {
				// A reader that cannot be kept from editing does not start.
				mode = p.readOnly ?? '';
				if (!mode || !offered(mode)) throw s.failed('work read-only', new Error(`it offers no ${JSON.stringify(mode)} mode`));
			}
			if (mode && modes && modes.currentModeId !== mode && offered(mode)) {
				try { await within(s.conn.setSessionMode({ sessionId: s.id, modeId: mode })); } catch (e) { throw s.failed('set its mode', e); }
			}
			return s;
		} catch (e) {
			s.close();
			throw e;
		}
	}

	/** newSession creates a session in the task's worktree, signing in first with the environment variables an agent accepts, when it asks to and they are set. */
	private async newSession(within: <T>(p: Promise<T>) => Promise<T>, methods: unknown[], servers: McpServer[]) {
		const request = { cwd: this.task.worktree, mcpServers: servers };
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
		throw this.signIn();
	}

	/** signIn says the agent is not signed in and how to sign it in. */
	private signIn() { return new Error(`${this.preset.title} is not signed in: ${this.preset.signIn}`); }

	/** failed explains why the agent failed to do what, with what it wrote to standard error. */
	failed(what: string, err: unknown) {
		let out = this.stderr().replace(ansi, '');
		if (out.length > 1000) out = out.slice(-1000);
		return new Error(`${this.preset.title} failed to ${what}: ${message(err)}` + (out ? '\n' + out : ''));
	}

	get isClosed() { return this.closed; }

	close() {
		if (this.closed) return;
		this.closed = true;
		this.ended.resolve();
		this.svc.forget(this.token);
		this.wake();
		this.stopAgent();
	}

	private wake() {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const w of waiters) w();
	}

	/** deliver hands x to the turn that follows the agent, unless the session has ended. */
	deliver(x: Item) {
		if (this.closed) return false;
		this.items.push(x);
		this.wake();
		return true;
	}

	/** next is the next thing the agent sent, once it does; or why there is none. */
	private async next(signal?: AbortSignal): Promise<Item | 'closed' | 'aborted'> {
		for (;;) {
			if (signal?.aborted) return 'aborted';
			const x = this.items.shift();
			if (x) return x;
			if (this.closed) return 'closed';
			await new Promise<void>(resolve => {
				const done = () => { signal?.removeEventListener('abort', done); this.waiters.delete(done); resolve(); };
				this.waiters.add(done);
				signal?.addEventListener('abort', done, { once: true });
			});
		}
	}

	/** prompt sends text to the agent, or queues it while a prompt runs. */
	private prompt(text: string) {
		if (this.prompting) this.queue.push(text);
		else this.send(text);
	}

	private send(text: string) {
		this.prompting = true;
		// What the agent said of its last work no longer holds once it has more.
		this.svc.store.setTaskResult(this.task.id, '', '');
		const began = Date.now();
		this.conn.prompt({ sessionId: this.id, prompt: [{ type: 'text', text }] }).then(
			(r: PromptResponse) => this.deliver({ end: { reason: r.stopReason, usage: r.usage, meta: r._meta, began } }),
			err => this.deliver({ end: { err, began } }));
	}

	/** advance records that the prompt ended and sends the queued text, reporting whether it did. */
	private advance() {
		this.prompting = false;
		const text = this.queue.shift();
		if (text === undefined) return false;
		this.send(text);
		return true;
	}

	private status(status: string) { this.svc.store.setTaskStatus(this.task.id, status); }

	busy() { return this.prompting; }

	/** enqueue queues text for the agent while a prompt runs, reporting whether one did. */
	enqueue(text: string) {
		if (this.prompting) this.queue.push(text);
		return this.prompting;
	}

	/** reply follows the agent into turn until its prompt ends or it waits for the owner to decide. */
	async reply(turn: DelegateTurn, signal: AbortSignal): Promise<void> {
		if (turn.text) {
			// What the owner says instead of deciding answers no to what waits.
			this.reject(turn.conversationId);
			this.prompt(turn.text);
		}
		if (!this.prompting && !this.items.length) return;
		this.status(taskRunning);
		for (;;) {
			let x: Item | 'closed' | 'aborted' | undefined;
			if (this.prompting) {
				x = await this.next(signal);
				if (x === 'closed') {
					this.svc.drop(this.task.id, this);
					this.status(taskFailed);
					throw this.failed('keep running', new Error('it exited'));
				}
				if (x === 'aborted') {
					await this.interrupt();
					this.status(taskStopped);
					throw signal.reason instanceof Error ? signal.reason : new Aborted();
				}
			} else {
				// With no prompt running, show what the agent sent meanwhile, such as the commands it offers, and stop following it.
				x = this.items.shift();
				if (!x) { this.status(taskReview); return; }
			}
			if ('update' in x) {
				try { await this.show(turn, x.update); } catch (e) { await this.interrupt(); throw e; }
			} else if ('permission' in x) {
				let asked: boolean;
				try { asked = await this.ask(turn, x.permission); } catch (e) { x.permission.cancel(); await this.interrupt(); throw e; }
				if (asked) { this.status(taskWaiting); return; }
			} else {
				// What the prompt used counts even when it failed.
				await this.used(turn, x.end).catch(err => console.warn(`record what a coding agent used (task ${this.task.id}): ${message(err)}`));
				if (this.advance()) continue;
				return this.finished(x.end);
			}
		}
	}

	/** finished reports how a prompt ended. */
	private finished(e: Ending) {
		if (authRequired(e.err)) {
			// Claude Agent finds out it is not signed in only when it answers.
			this.status(taskFailed);
			throw this.signIn();
		}
		if (e.err !== undefined) { this.status(taskFailed); throw this.failed('answer', e.err); }
		switch (e.reason) {
			case 'cancelled': this.status(taskStopped); throw new Aborted();
			case 'refusal': this.status(taskFailed); throw new Error(`${this.preset.title} refused to go on`);
			case 'max_tokens': case 'max_turn_requests':
				this.status(taskReview);
				throw new Error(`${this.preset.title} stopped at its limit (${e.reason}); send a message to continue`);
		}
		this.status(taskReview);
	}

	/**
	 * interrupt cancels the running prompt and every request waiting for the
	 * owner, then waits for the prompt to end; an agent that does not end it
	 * is ended itself.
	 */
	async interrupt() {
		this.queue = [];
		for (const [id, p] of this.pending) { this.pending.delete(id); p.cancel(); }
		if (!this.prompting) return;
		this.conn.cancel({ sessionId: this.id }).catch(() => {});
		const deadline = AbortSignal.timeout(cancelWait);
		for (;;) {
			const x = await this.next(deadline);
			if (x === 'aborted') { this.svc.drop(this.task.id, this); return; }
			if (x === 'closed') return;
			if ('permission' in x) x.permission.cancel();
			else if ('end' in x) { this.prompting = false; return; }
		}
	}

	/** reject answers no to every request waiting for the owner, recording the approvals as denied. */
	private reject(conversationID: string) {
		const pending = this.pending;
		this.pending = new Map();
		for (const [id, p] of pending) {
			try { this.svc.store.withdraw(conversationID, id); } catch { /* decided already */ }
			p.choose('reject_once');
		}
	}

	/** decide passes the owner's answer on to the request it decides, reporting whether one was waiting. */
	decide(d: Decision, a: Answer): boolean {
		const p = this.pending.get(d.approvalId);
		this.pending.delete(d.approvalId);
		const reason = (a.reason ?? '').trim();
		if (p && !a.approved && reason) this.queue.push(reason);
		if (!p) return false;
		if (!a.approved) {
			p.choose(...reject);
			// The reason is the agent's next prompt: the one at work ends rather than working around the denial without it.
			if (reason) this.conn.cancel({ sessionId: this.id }).catch(() => {});
		} else if (a.remember && p.scope) {
			this.svc.store.addGrant(a.remember === rememberAlways ? '' : this.task.conversationId, p.tool, p.scope);
			p.choose(...allowAlways);
		} else p.choose(...allow);
		// The call goes on in the next turn, which shows how it ends.
		if (a.approved) this.svc.store.complete(d, { approved: true }, '');
		return true;
	}

	/**
	 * ask shows a permission request in turn and asks the owner, unless the
	 * worktree or a remembered approval already allows it; it reports whether
	 * the owner was asked.
	 */
	private async ask(turn: DelegateTurn, p: Permission): Promise<boolean> {
		const tc = p.request.toolCall;
		const input = describe(tc.title, tc.kind, tc.locations, tc.rawInput);
		let { kind, locations, rawInput: raw } = tc;
		let title = tc.title ?? '';
		const known = this.calls.get(tc.toolCallId);
		if (known) {
			for (const [k, v] of Object.entries(known.input)) if (!(k in input)) input[k] = v;
			// The request may name only the call the agent showed before.
			kind ??= known.kind;
			if (!locations?.length) locations = known.locations;
			title ||= known.title;
			raw ??= known.raw;
		}
		p.tool = this.toolName(kind);
		p.scope = p.once ? '' : scope(tc.title, title, raw);
		if (this.task.readOnly && changes(kind)) {
			// A reader never changes the worktree it shares.
			p.choose(...reject);
			return false;
		}
		if (this.inWorktree(kind, locations) || this.granted(p)) {
			p.choose(...allow);
			return false;
		}
		if (!turn.hasTool(tc.toolCallId)) await turn.tool(tc.toolCallId, p.tool, input);
		const id = await turn.requestApproval(tc.toolCallId, input);
		p.timer = setTimeout(() => {
			if (this.pending.get(id) !== p) return;
			this.pending.delete(id);
			p.cancel();
		}, approvalWait);
		this.pending.set(id, p);
		return true;
	}

	/** inWorktree reports whether a call edits, deletes or moves only files inside the task's worktree, which the agent may do without asking, unless the task only reads it. */
	inWorktree(kind?: ToolKind | null, locations?: ToolCallLocation[] | null) {
		if (this.task.readOnly || !changes(kind) || !locations?.length) return false;
		return locations.every(l => inside(this.task.worktree, l.path));
	}

	/** granted reports whether the owner chose to keep allowing calls like p. A call with nothing to tell it apart from others is never remembered. */
	private granted(p: Permission) {
		return !!p.scope && this.svc.store.granted(this.task.conversationId, p.tool, p.scope);
	}

	/** toolName is how the conversation names a call of kind by this agent. */
	private toolName(kind?: ToolKind | null) { return this.preset.name + '_' + (kind || 'other'); }

	/** show writes one update into turn. */
	private async show(turn: DelegateTurn, u: SessionUpdate) {
		switch (u.sessionUpdate) {
			case 'agent_message_chunk':
				if (u.content.type === 'text') await turn.stream('text', u.content.text);
				return;
			case 'agent_thought_chunk':
				if (u.content.type === 'text') await turn.stream('reasoning', u.content.text);
				return;
			case 'tool_call': {
				const c: Call = { name: this.toolName(u.kind), input: describe(u.title, u.kind, u.locations, u.rawInput), title: u.title, kind: u.kind ?? null, locations: u.locations, raw: u.rawInput };
				this.calls.set(u.toolCallId, c);
				await turn.tool(u.toolCallId, c.name, c.input);
				return this.finish(turn, u.toolCallId, u.status, u.content, u.rawOutput);
			}
			case 'tool_call_update': {
				let c = this.calls.get(u.toolCallId);
				if (!c) {
					c = { name: this.toolName(u.kind), input: describe(u.title, u.kind, u.locations, u.rawInput), title: u.title ?? '', kind: u.kind, locations: u.locations, raw: u.rawInput };
					this.calls.set(u.toolCallId, c);
				}
				// A call started in an earlier turn ends in this one.
				if ((u.status === 'completed' || u.status === 'failed') && !turn.hasTool(u.toolCallId)) await turn.tool(u.toolCallId, c.name, c.input);
				return this.finish(turn, u.toolCallId, u.status, u.content, u.rawOutput);
			}
			case 'usage_update':
				this.costed(u.cost);
				return turn.context(this.model || this.preset.name, u.used, u.size);
			case 'config_option_update': {
				const model = modelOption(u.configOptions);
				if (model) this.model = model;
				return;
			}
			case 'plan': return this.svc.store.setTaskPlan(this.task.id, u.entries.map(e => ({ content: e.content, status: e.status })));
		}
	}

	/** finish records a call's end once its status says it ended. */
	private async finish(turn: DelegateTurn, id: string, status?: string | null, content?: ToolCallContent[] | null, raw?: unknown) {
		if (status === 'completed') {
			this.calls.delete(id);
			await turn.toolDone(id, output(content, raw), '');
		} else if (status === 'failed') {
			this.calls.delete(id);
			const out = output(content, raw) as { output?: unknown };
			await turn.toolDone(id, undefined, out.output !== undefined ? String(out.output) : 'failed');
		}
	}

	/** costed adds the session cost an agent reported, which grows over the agent's run, to what the next prompt's end records. */
	private costed(cost?: { amount: number; currency: string } | null) {
		if (!cost || cost.currency !== 'USD') return;
		const spent = cost.amount - this.cost;
		// A smaller total is a new run's.
		if (spent > 0) this.unpriced += spent;
		else if (spent < 0) this.unpriced += cost.amount;
		this.cost = cost.amount;
	}

	/** used records what the prompt that ended with e used. */
	private async used(turn: DelegateTurn, e: Ending) {
		let model = this.model || this.preset.name;
		const cost = this.unpriced;
		this.unpriced = 0;
		let took = Date.now() - e.began;
		let rows: ModelUsage[] = reported(e.usage, e.meta);
		if (!rows.length && this.preset.tally) {
			const tallied = await this.preset.tally(this.id);
			if (tallied.model) model = tallied.model;
			// The tally counts this session alone; a task whose session could not be loaded again started a new one at zero.
			const r = this.svc.store.sessionTotal(turn.conversationId, this.id);
			const u = tallied.usage;
			const d = {
				inputTokens: u.inputTokens - r.inputTokens, outputTokens: u.outputTokens - r.outputTokens,
				reasoningTokens: Math.max((u.reasoningTokens ?? 0) - (r.reasoningTokens ?? 0), 0),
				cacheReadTokens: Math.max((u.cacheReadTokens ?? 0) - (r.cacheReadTokens ?? 0), 0),
				cacheWriteTokens: Math.max((u.cacheWriteTokens ?? 0) - (r.cacheWriteTokens ?? 0), 0),
			};
			if (d.inputTokens > 0 || d.outputTokens > 0) rows = [{ model: '', usage: d }];
		}
		if (!rows.length) {
			if (!cost) return;
			rows = [{ model: '', usage: { inputTokens: 0, outputTokens: 0 } }];
		}
		for (const [i, r] of rows.entries()) {
			const usage = i === 0 ? { ...r.usage, cost: (r.usage.cost ?? 0) + cost } : r.usage;
			if (i > 0) took = 0;
			await turn.used(this.id, r.model || model, usage, took);
		}
	}

	/** client answers the agent's requests for the session. Mob offers agents no file system or terminal of its own: they use their own in the worktree. */
	private client(): Client {
		return {
			sessionUpdate: async n => { if (!this.loading) this.deliver({ update: n.update }); },
			requestPermission: async request => {
				const p = new Permission(request);
				const tc = request.toolCall;
				if (this.inWorktree(tc.kind, tc.locations)) p.choose(...allow);
				else if (!this.deliver({ permission: p })) p.cancel();
				return { outcome: await Promise.race([p.answer, this.ended.promise.then(() => cancelled)]) };
			},
		};
	}

	/**
	 * askOwner shows a call of Mob's own in the turn that follows the agent and
	 * asks the owner to approve it, as the agent's requests are. Mob reports
	 * how the call ends with an update.
	 */
	askOwner(id: string, title: string, input: Record<string, unknown>): Promise<RequestPermissionOutcome> {
		const p = new Permission({ sessionId: this.id, toolCall: { toolCallId: id }, options: [
			{ kind: 'allow_once', name: 'Allow', optionId: 'allow' },
			{ kind: 'reject_once', name: 'Reject', optionId: 'reject' },
		] }, true);
		if (!this.deliver({ update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'other', status: 'pending', rawInput: input } }) || !this.deliver({ permission: p })) p.cancel();
		return p.answer;
	}

	/** report shows how a call of Mob's own ended, in the turn that follows the agent. */
	report(id: string, ok: boolean, text: string) {
		this.deliver({ update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }] } });
	}
}

/** changes reports whether a call of kind edits, deletes or moves files. */
const changes = (kind?: ToolKind | null) => kind === 'edit' || kind === 'delete' || kind === 'move';

/**
 * scope is what remembering an approval of a call covers: the title the
 * agent gave the request, as Codex and Claude Agent give the command or file;
 * or, when the request names only the call, as DeepSeek Harness and CodeBuddy
 * Code do, the call's title with its whole input, so that remembering one
 * command never allows another. Empty when there is neither.
 */
export function scope(requested: string | null | undefined, title: string, raw: unknown) {
	if (requested?.trim()) return requested;
	if (raw === undefined || raw === null) return '';
	return (title + ' ' + JSON.stringify(raw)).trim();
}

/** inside reports whether path is dir or within it once links are followed, so a link in the worktree cannot lead an edit outside it. */
export function inside(dir: string, path: string) {
	if (!isAbsolute(path)) path = join(dir, path);
	const d = resolveLinks(resolvePath(dir)), real = resolveLinks(resolvePath(path));
	if (d === undefined || real === undefined) return false;
	const rel = relative(d, real);
	return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** resolveLinks follows the links in path; a file that does not exist yet is resolved through its nearest existing parent. A link that leads nowhere cannot be resolved. */
function resolveLinks(path: string): string | undefined {
	try { return realpathSync(path); } catch { /* missing, or a dangling link */ }
	try { lstatSync(path); return undefined; } catch { /* nothing there */ }
	const parent = dirname(path);
	if (parent === path) return path;
	const real = resolveLinks(parent);
	return real === undefined ? undefined : join(real, basename(path));
}

/** describe is the input a call shows: its title, kind, files and the agent's own input. */
function describe(title: string | null | undefined, kind: ToolKind | null | undefined, locations: ToolCallLocation[] | null | undefined, raw: unknown): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	if (title) input.title = title;
	if (kind) input.kind = kind;
	if (locations?.length) input.files = locations.map(l => l.path);
	if (raw !== undefined && raw !== null) input.input = raw;
	return input;
}

/** output is what a finished call shows: its text, diffs, or the agent's own output. */
function output(content?: ToolCallContent[] | null, raw?: unknown): unknown {
	const parts: string[] = [];
	for (const c of content ?? []) {
		if (c.type === 'content' && c.content.type === 'text') parts.push(c.content.text);
		else if (c.type === 'diff') parts.push('--- ' + c.path + '\n' + c.newText);
	}
	if (!parts.length) return raw ?? {};
	let text = parts.join('\n\n');
	if (text.length > outputLimit) text = text.slice(0, outputLimit) + '\n… (cut)';
	return { output: text };
}
