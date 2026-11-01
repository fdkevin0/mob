import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Task } from '@mob/core';
import { codex } from '../src/agents/codex';
import { preset } from '../src/agents/presets';
import type { AgentSession, Choice, PermissionRequest, Update } from '../src/agents/runtime';

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** Server is a fake Codex app server on the other end of a session's streams. */
class Server {
	readonly toAgent = new TransformStream<Uint8Array, Uint8Array>();
	readonly toClient = new TransformStream<Uint8Array, Uint8Array>();
	private writer = this.toClient.writable.getWriter();
	/** got are the requests and notifications the client sent, by method. */
	got: Message[] = [];
	/** answers are the client's answers to the server's requests, by request ID. */
	answers = new Map<number, unknown>();
	account: unknown = { account: { type: 'chatgpt', email: null }, requiresOpenaiAuth: true };
	/** turn runs for each turn the client starts, after the server answers its request. */
	turn: (s: Server, text: string, id: string) => Promise<void> = async (s, text, id) => {
		s.notify('item/agentMessage/delta', { threadId: 't1', turnId: id, itemId: 'm1', delta: 'got ' + text });
		s.notify('turn/completed', { threadId: 't1', turn: { id, status: 'completed', error: null } });
	};
	private turns = 0;
	private asked = 0;
	private waiting = new Map<number, (v: unknown) => void>();

	constructor() { void this.read(); }

	private async read() {
		const decoder = new TextDecoder();
		let rest = '';
		for await (const chunk of this.toAgent.readable) {
			const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
			rest = lines.pop()!;
			for (const line of lines) if (line) this.receive(JSON.parse(line));
		}
	}

	private receive(m: Message) {
		if (!m.method) {
			this.answers.set(m.id!, m.result ?? m.error);
			this.waiting.get(m.id!)?.(m.result ?? m.error);
			return;
		}
		this.got.push(m);
		if (m.id === undefined) return;
		const answer = (result: unknown) => this.send({ id: m.id, result });
		switch (m.method) {
			case 'initialize': return answer({ userAgent: 'fake', codexHome: '/', platformFamily: 'unix', platformOs: 'linux' });
			case 'account/read': return answer(this.account);
			case 'thread/start': return answer({ thread: { id: 't1' }, model: 'gpt-test' });
			case 'thread/resume': return answer({ thread: { id: String(m.params!.threadId) }, model: 'gpt-resumed' });
			case 'turn/interrupt':
				answer({});
				return this.notify('turn/completed', { threadId: 't1', turn: { id: m.params!.turnId, status: 'interrupted', error: null } });
			case 'turn/start': {
				const id = 'u' + ++this.turns;
				answer({ turn: { id, status: 'inProgress', error: null } });
				const input = m.params!.input as { text: string }[];
				void this.turn(this, input[0]!.text, id);
				return;
			}
		}
		this.send({ id: m.id, error: { code: -32601, message: 'unknown' } });
	}

	send(m: Message) { void this.writer.write(new TextEncoder().encode(JSON.stringify(m) + '\n')); }
	notify(method: string, params: Record<string, unknown>) { this.send({ method, params }); }

	/** ask sends the client a request and waits for its answer. */
	ask(method: string, params: Record<string, unknown>) {
		const id = ++this.asked;
		const answered = new Promise(r => this.waiting.set(id, r));
		this.send({ id, method, params });
		return answered;
	}

	sent(method: string) { return this.got.filter(m => m.method === method); }
}

const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY'];
let saved: (string | undefined)[] = [];
beforeEach(() => { saved = keys.map(k => process.env[k]); for (const k of keys) delete process.env[k]; });
afterEach(() => keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }));

/** open opens a session with server, recording what it sends and answering permission requests with choice. */
async function open(server: Server, t: Partial<Task> = {}, choice: Choice = 'allow') {
	const updates: Update[] = [], asked: PermissionRequest[] = [], created: string[] = [];
	const task = { id: 'task', worktree: '/work', session: '', readOnly: false, ...t } as Task;
	const session: AgentSession = await codex.open({
		preset: preset('codex'), task,
		conn: { input: server.toAgent.writable, output: server.toClient.readable, stop: () => { void server.toClient.writable.abort().catch(() => {}); } },
		servers: http => http ? [{ name: 'mob', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } }] : [],
		handler: { update: u => { updates.push(u); }, permission: async r => { asked.push(r); return choice; } },
		created: id => { created.push(id); },
	}, AbortSignal.timeout(5000));
	return { session, updates, asked, created };
}

const tokens = (input: number, cached: number, output: number) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 3 });

test('a new thread works in the worktree with Mob\'s MCP server', async () => {
	const server = new Server();
	const { session, created, updates } = await open(server);
	expect([session.id, session.model, created]).toEqual(['t1', 'gpt-test', ['t1']]);
	expect(server.sent('initialized')).toHaveLength(1);
	expect(server.sent('thread/start')[0]!.params).toEqual({
		cwd: '/work', approvalPolicy: 'on-request', sandbox: 'workspace-write',
		config: { 'mcp_servers.mob.url': 'http://127.0.0.1:1/mcp', 'mcp_servers.mob.http_headers': { Authorization: 'Bearer x' } },
	});
	const end = await session.prompt('hello');
	expect(end).toEqual({ reason: 'end_turn', usage: [] });
	expect(updates).toEqual([{ type: 'text', text: 'got hello' }]);
	session.close();
});

test('a task goes on in its thread, and a reader cannot write', async () => {
	const server = new Server();
	const { session, created } = await open(server, { session: 'old', readOnly: true });
	expect([session.id, session.model, created]).toEqual(['old', 'gpt-resumed', []]);
	expect(server.sent('thread/resume')[0]!.params).toMatchObject({ threadId: 'old', sandbox: 'read-only', excludeTurns: true });
	expect(codex.reads(preset('codex'))).toBe(true);
	session.close();
});

test('Codex not signed in is told how to sign in, unless a key is set', async () => {
	const server = new Server();
	server.account = { account: null, requiresOpenaiAuth: true };
	await expect(open(server)).rejects.toThrow('Codex is not signed in: run `codex login`');
	process.env.OPENAI_API_KEY = 'sk-test';
	const { session } = await open(Object.assign(new Server(), { account: { account: null, requiresOpenaiAuth: true } }));
	expect(session.id).toBe('t1');
	session.close();
});

test('calls, approvals, plans and what a turn used', async () => {
	const server = new Server();
	const answers: unknown[] = [];
	server.turn = async (s, _, id) => {
		const base = { threadId: 't1', turnId: id };
		s.notify('turn/plan/updated', { ...base, explanation: null, plan: [{ step: 'Test', status: 'inProgress' }, { step: 'Fix', status: 'pending' }] });
		const run = { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: '/work', status: 'inProgress', aggregatedOutput: null, exitCode: null };
		s.notify('item/started', { ...base, item: run });
		answers.push(await s.ask('item/commandExecution/requestApproval', { ...base, itemId: 'c1', command: 'npm test', cwd: '/work', reason: 'needs network' }));
		s.notify('item/completed', { ...base, item: { ...run, status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } });
		const edit = { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/etc/hosts', kind: { type: 'update', move_path: null }, diff: '+x' }] };
		s.notify('item/started', { ...base, item: edit });
		answers.push(await s.ask('item/fileChange/requestApproval', { ...base, itemId: 'f1', grantRoot: '/etc' }));
		s.notify('item/completed', { ...base, item: { ...edit, status: 'declined' } });
		answers.push(await s.ask('mcpServer/elicitation/request', { threadId: 't1' }));
		s.notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: tokens(5000, 4000, 100), last: tokens(1000, 800, 40), modelContextWindow: 200000 } });
		s.notify('thread/tokenUsage/updated', { ...base, tokenUsage: { total: tokens(6000, 4900, 150), last: tokens(1000, 900, 50), modelContextWindow: 200000 } });
		s.notify('item/completed', { ...base, item: { type: 'agentMessage', id: 'm1', text: 'Tests pass' } });
		s.notify('turn/completed', { threadId: 't1', turn: { id, status: 'completed', error: null } });
	};
	const { session, updates, asked } = await open(server, {}, 'always');
	const end = await session.prompt('fix it');
	expect(answers).toEqual([{ decision: 'acceptForSession' }, { decision: 'acceptForSession' }, { action: 'decline', content: null, _meta: null }]);
	expect(asked).toEqual([
		{ id: 'c1', title: 'npm test', kind: 'execute', input: { command: 'npm test', cwd: '/work', reason: 'needs network', network: undefined } },
		{ id: 'f1', title: 'Write in /etc', kind: 'edit', locations: ['/etc/hosts', '/etc'], input: { reason: undefined, root: '/etc' } },
	]);
	expect(updates).toEqual([
		{ type: 'plan', entries: [{ content: 'Test', status: 'in_progress' }, { content: 'Fix', status: 'pending' }] },
		{ type: 'tool', start: true, id: 'c1', title: 'npm test', kind: 'execute', input: { command: 'npm test', cwd: '/work' }, status: 'in_progress', content: undefined, output: undefined },
		{ type: 'tool', start: false, id: 'c1', title: 'npm test', kind: 'execute', input: { command: 'npm test', cwd: '/work' }, status: 'completed', content: [{ type: 'text', text: 'ok' }], output: { exitCode: 0 } },
		{ type: 'tool', start: true, id: 'f1', title: 'Edit /etc/hosts', kind: 'edit', locations: ['/etc/hosts'], status: 'in_progress', content: [{ type: 'text', text: '--- /etc/hosts\n+x' }] },
		{ type: 'tool', start: false, id: 'f1', title: 'Edit /etc/hosts', kind: 'edit', locations: ['/etc/hosts'], status: 'failed', content: [{ type: 'text', text: '--- /etc/hosts\n+x' }] },
		{ type: 'context', used: 1040, size: 200000 },
		{ type: 'context', used: 1050, size: 200000 },
		{ type: 'text', text: 'Tests pass' },
	]);
	// The turn used the thread's total less what it held before the turn's first request.
	expect(end).toEqual({ reason: 'end_turn', usage: [{ model: '', usage: { inputTokens: 2000, outputTokens: 90, reasoningTokens: 3, cacheReadTokens: 1700, cacheWriteTokens: 0 } }] });
	session.close();
});

test('a stopped turn ends cancelled, and a turn signed out or too long says so', async () => {
	const server = new Server();
	let fail: unknown = null;
	server.turn = async (s, text, id) => {
		if (text === 'hold') return;
		s.notify('turn/completed', { threadId: 't1', turn: { id, status: 'failed', error: fail } });
	};
	const { session } = await open(server);
	const held = session.prompt('hold');
	await Bun.sleep(20);
	session.cancel();
	expect(await held).toEqual({ reason: 'cancelled', usage: [] });
	expect(server.sent('turn/interrupt')[0]!.params).toEqual({ threadId: 't1', turnId: 'u1' });
	fail = { message: 'no', codexErrorInfo: 'unauthorized' };
	expect(await session.prompt('x')).toEqual({ signedOut: true, usage: [] });
	fail = { message: 'full', codexErrorInfo: 'contextWindowExceeded' };
	expect(await session.prompt('x')).toEqual({ reason: 'max_tokens', usage: [] });
	fail = { message: 'boom', codexErrorInfo: null, additionalDetails: 'stream closed' };
	expect(((await session.prompt('x')).err as Error).message).toBe('boom: stream closed');
	session.close();
});
