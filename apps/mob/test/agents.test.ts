import { afterEach, expect, test } from 'bun:test';
import {
	AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream,
	type Agent, type McpServer, type PromptRequest, type PromptResponse, type SessionUpdate, type ToolCallLocation, type ToolKind,
} from '@agentclientprotocol/sdk';
import { ConversationService, newID, rememberAlways, Store, type Answer, type llm, type Message, type Models, type Task, type Tool, type Turn } from '@mob/core';
import { openBun } from '@mob/core/sqlite/bun';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { start as startAgent, type Conn } from '../src/agents/process';
import type { Preset } from '../src/agents/presets';
import { check, diff, Limited, reviewLimit, snapshot } from '../src/agents/review';
import { inside } from '../src/agents/session';
import { Service } from '../src/agents/service';
import { subtaskActive } from '../src/agents/subtasks';
import { overview, tools } from '../src/agents/tools';
import { mob, idle, outline, type AgentNode } from '../src/agents/tree';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const temp = () => mkdtempSync(join(tmpdir(), 'mob-agents-'));

const models = [{ type: 'select' as const, id: 'model', name: 'Model', category: 'model' as const, currentValue: 'gpt-5.5-codex/high', options: [{ value: 'gpt-5.5-codex/high', name: 'gpt-5.5-codex (high)' }] }];
const modes = { currentModeId: 'read-only', availableModes: [{ id: 'read-only', name: 'Read only' }, { id: 'auto', name: 'Auto' }, { id: 'acceptEdits', name: 'Accept edits' }] };

/** Fake is an ACP agent that acts on the words of each prompt. */
class Fake implements Agent {
	dir = '';
	prompts: string[] = [];
	mode = '';
	loaded = '';
	resumed = '';
	servers: McpServer[] = [];
	spent = 0;
	release = Promise.withResolvers<void>();
	private cancels = new Map<string, () => void>();
	constructor(readonly conn: AgentSideConnection, readonly options: { resumes?: boolean; signedOut?: boolean; session?: string; failLoad?: boolean }) {}

	initialize() {
		// Like DeepSeek Harness: sessions are resumed, not loaded.
		if (this.options.resumes) return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } } as never };
		return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } } };
	}
	authenticate() { return {}; }
	cancel({ sessionId }: { sessionId: string }) { this.cancels.get(sessionId)?.(); }
	resumeSession(r: { sessionId: string; cwd: string }) { this.dir = r.cwd; this.resumed = r.sessionId; return {}; }
	newSession(r: { cwd: string; mcpServers: McpServer[] }) {
		if (this.options.signedOut) throw RequestError.authRequired();
		this.dir = r.cwd;
		this.servers = r.mcpServers;
		return { sessionId: this.options.session || 's1', modes, configOptions: models };
	}
	async loadSession(r: { sessionId: string; cwd: string }) {
		if (this.options.failLoad) throw RequestError.internalError();
		this.dir = r.cwd;
		this.loaded = r.sessionId;
		// Loading replays the session, which Mob already shows.
		await this.say(r.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed' } });
		return { modes };
	}
	setSessionMode(r: { modeId: string }) { this.mode = r.modeId; return {}; }

	say(sessionId: string, update: SessionUpdate) { return this.conn.sessionUpdate({ sessionId, update }); }
	text(sessionId: string, text: string) { return this.say(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); }

	async prompt(p: PromptRequest): Promise<PromptResponse> {
		const block = p.prompt[0]!;
		const text = block.type === 'text' ? block.text : '';
		this.prompts.push(text);
		const id = p.sessionId;
		const stopped = new Promise<'cancelled'>(r => this.cancels.set(id, () => r('cancelled')));
		const end: PromptResponse = { stopReason: 'end_turn' };
		if (text === 'hello') {
			await this.say(id, { sessionUpdate: 'plan', entries: [{ content: 'greet', status: 'completed', priority: 'medium' }] });
			await this.say(id, { sessionUpdate: 'tool_call', toolCallId: 'read1', title: 'Read README', kind: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '# Readme' } }] });
			await this.text(id, 'Hi');
		} else if (text === 'run' || text === 'edit') {
			let kind: ToolKind = 'execute', title = 'npm test', files: ToolCallLocation[] = [];
			if (text === 'edit') [kind, title, files] = ['edit', 'Edit main.go', [{ path: join(this.dir, 'main.go') }]];
			await this.say(id, { sessionUpdate: 'tool_call', toolCallId: 'call1', title, kind, status: 'pending', locations: files });
			const answer = await this.conn.requestPermission({ sessionId: id, toolCall: { toolCallId: 'call1', title, kind, locations: files }, options: [
				{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }, { kind: 'allow_always', name: 'Always', optionId: 'always' }, { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
			] });
			if (answer.outcome.outcome !== 'selected') return { stopReason: 'cancelled' };
			if (answer.outcome.optionId === 'reject') {
				await this.say(id, { sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'failed' });
				await this.text(id, 'skipped');
				return end;
			}
			await this.say(id, { sessionUpdate: 'tool_call_update', toolCallId: 'call1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });
			await this.text(id, 'done ' + answer.outcome.optionId);
		} else if (text.startsWith('sub ') || text.startsWith('subread ')) {
			// Hands the rest to a sub-task through Mob's MCP server; subread has it try to edit this task's worktree.
			const args = text.startsWith('subread ') ? { title: text.slice(8), prompt: 'edit', workspace: 'shared' } : { title: text.slice(4), prompt: 'hello' };
			await this.text(id, await this.callMob('task_start', args));
		} else if (text.startsWith('Review the work')) {
			// A squad's reviewer: it finds something in the work it reads.
			let out: string;
			try { out = await this.callMob('task_result', { outcome: 'rework', summary: 'found a bug in ' + this.dir.split(sep).pop() }); } catch (e) { out = 'error: ' + (e as Error).message; }
			await this.text(id, out);
		} else if (text.startsWith('result ')) {
			// Reports how its work ended through Mob's MCP server.
			const outcome = text.slice(7);
			let out: string;
			try { out = await this.callMob('task_result', { outcome, summary: 'found ' + outcome }); } catch (e) { out = 'error: ' + (e as Error).message; }
			await this.text(id, out);
		} else if (text === 'hold') {
			await this.text(id, 'holding ');
			await this.release.promise;
		} else if (text.startsWith('cmd ') || text === 'bare') {
			// Like DeepSeek Harness and CodeBuddy Code: the call is shown first, and the permission request names only its ID.
			const call = 'call-' + text;
			await this.say(id, text === 'bare'
				? { sessionUpdate: 'tool_call', toolCallId: call, title: '', kind: 'other', status: 'pending' }
				: { sessionUpdate: 'tool_call', toolCallId: call, title: 'bash', kind: 'other', status: 'pending', rawInput: { command: text.slice(4) } });
			const answer = await this.conn.requestPermission({ sessionId: id, toolCall: { toolCallId: call }, options: [
				{ kind: 'allow_once', name: 'Allow once', optionId: 'allow-once' }, { kind: 'reject_once', name: 'Reject', optionId: 'reject-once' },
			] });
			if (answer.outcome.outcome !== 'selected') return { stopReason: 'cancelled' };
			await this.text(id, answer.outcome.optionId);
		} else if (text === 'limit') {
			await this.text(id, 'halfway');
			return { stopReason: 'max_tokens' };
		} else if (text === 'tokens') {
			// As Claude Agent reports: input without the cache, the total with it, a breakdown by model and the cost of the run so far.
			this.spent += 0.25;
			await this.say(id, { sessionUpdate: 'usage_update', used: 1000, size: 200000, cost: { amount: this.spent, currency: 'USD' } });
			await this.text(id, 'counted');
			const count = { inputTokens: 10, cachedInputTokens: 900, cachedWriteTokens: 90, outputTokens: 40, totalTokens: 1040 };
			return { stopReason: 'end_turn', usage: { inputTokens: 10, cachedReadTokens: 900, cachedWriteTokens: 90, outputTokens: 40, totalTokens: 1040 }, _meta: { quota: { model_usage: [{ model: 'claude-test', token_count: count }] } } };
		} else if (text === 'login') {
			throw RequestError.authRequired();
		} else if (text === 'wait') {
			return { stopReason: await stopped };
		} else await this.text(id, 'got ' + text);
		return end;
	}

	/** callMob calls a tool of the MCP server Mob gave the session. */
	async callMob(name: string, args: Record<string, unknown>): Promise<string> {
		const server = this.servers[0] as { type?: string; url: string; headers: { name: string; value: string }[] } | undefined;
		if (this.servers.length !== 1 || server?.type !== 'http') throw new Error('no MCP server');
		return callTool(server.url, Object.fromEntries(server.headers.map(h => [h.name, h.value])), name, args);
	}
}

async function callTool(url: string, headers: Record<string, string>, name: string, args: Record<string, unknown>) {
	const client = new Client({ name: 'fake', version: '1' });
	await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
	try {
		const result = await client.callTool({ name, arguments: args });
		const text = (result.content as { text: string }[])[0]!.text;
		if (result.isError) throw new Error(text);
		return text;
	} finally { await client.close(); }
}

/** Fakes starts a fake agent for every session. */
class Fakes {
	agents: Fake[] = [];
	/** slow makes starting an agent wait until it is stopped. */
	slow = false;
	options: { resumes?: boolean; signedOut?: boolean; session?: string; failLoad?: boolean } = {};
	connect = async (_: Preset, __: string, signal: AbortSignal): Promise<Conn> => {
		if (this.slow) {
			await new Promise(r => signal.addEventListener('abort', r, { once: true }));
			throw signal.reason;
		}
		const toAgent = new TransformStream<Uint8Array, Uint8Array>(), toClient = new TransformStream<Uint8Array, Uint8Array>();
		let fake!: Fake;
		new AgentSideConnection(conn => (fake = new Fake(conn, { ...this.options })), ndJsonStream(toClient.writable, toAgent.readable));
		this.agents.push(fake);
		return { input: toAgent.writable, output: toClient.readable, stop: () => { void toAgent.writable.abort().catch(() => {}); void toClient.writable.abort().catch(() => {}); } };
	};
	last() { return this.agents[this.agents.length - 1]!; }
}

function run(dir: string, ...args: string[]) {
	const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
	if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

function repository() {
	const dir = temp();
	run(dir, 'init', '-q', '-b', 'main');
	run(dir, 'commit', '-q', '--allow-empty', '-m', 'start');
	return dir;
}

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const textOf = (m: Message) => m.parts.filter(p => p.type === 'text').map(p => String(p.text ?? '')).join('');

function harness(models?: Models) {
	const store = new Store(openBun(join(temp(), 'mob.sqlite')), 'test').open();
	const conv = new ConversationService(store, models);
	const fakes = new Fakes();
	const svc = new Service(store, conv, temp(), fakes.connect);
	conv.setDelegate(svc);
	conv.tools.register(...tools(svc));
	closers.push(async () => { await conv.close(); svc.close(); store.close(); });
	const repo = repository();
	const h = {
		store, conv, fakes, svc, repo,
		/** wait waits for the task's turn to end. */
		async wait(task: Task): Promise<Task> {
			const deadline = Date.now() + 10_000;
			while (conv.isActive(task.conversationId)) {
				if (Date.now() > deadline) throw new Error('task turn did not end');
				await sleep(5);
			}
			return store.task(task.id)!;
		},
		async say(task: Task, text: string) { await svc.message(task.id, text); return h.wait(task); },
		/** decide answers the task's only pending approval. */
		async decide(task: Task, answer: Omit<Answer, 'id'>, channel?: string) {
			const pending = conv.pending(task.conversationId);
			expect(pending).toHaveLength(1);
			await conv.execute({ id: task.conversationId, text: '', requestId: newID(), approval: { ...answer, id: pending[0]!.id }, owner: true, channel }, () => {});
			return h.wait(task);
		},
		/** reply is the text of the conversation's latest reply. */
		reply(task: Task) {
			const history = store.history(task.conversationId);
			const last = history[history.length - 1]!;
			if (last.metadata?.error) throw new Error('reply failed: ' + last.metadata.error);
			return textOf(last);
		},
		error(task: Task) {
			const history = store.history(task.conversationId);
			return String(history[history.length - 1]!.metadata?.error ?? '');
		},
		async start(prompt: string) { return h.wait(await svc.startTask('', repo, '', '', prompt)); },
		tool(name: string): Tool { return tools(svc).find(t => t.name === name)!; },
		/** until polls fn until it returns something. */
		async until<T>(what: string, fn: () => T | undefined | false): Promise<T> {
			const deadline = Date.now() + 10_000;
			for (;;) {
				const v = fn();
				if (v) return v;
				if (Date.now() > deadline) throw new Error(what);
				await sleep(5);
			}
		},
	};
	return h;
}

const toolCall = (input: Record<string, unknown>) => ({ input, requestApproval: async (x: unknown) => { throw Object.assign(new Error('asked'), { asked: x }); } }) as never;

test('a task runs in its own worktree', async () => {
	const h = harness();
	const task = await h.start('hello');
	expect([task.status, task.agent, task.session, task.branch.startsWith('mob/hello-')]).toEqual(['review', 'codex', 's1', true]);
	expect(run(task.worktree, 'branch', '--show-current')).toBe(task.branch);
	expect([h.fakes.last().dir, h.fakes.last().mode]).toEqual([task.worktree, 'auto']);
	expect(h.reply(task)).toBe('Hi');
	const history = h.store.history(task.conversationId);
	const last = history[history.length - 1]!;
	expect(last.metadata?.model ?? (last as { model?: string }).model).toBe('codex');
	// An agent's reply records when it began, first wrote and ended, but not its own requests' timing.
	const stats = last.stats!;
	expect(stats.firstTokenMs).toBeGreaterThanOrEqual(0);
	expect(stats.finishedAt).toBeGreaterThanOrEqual(stats.startedAt + stats.firstTokenMs!);
	expect(stats.generationMs).toBeUndefined();
	const read = last.parts.find(p => p.type === 'tool-codex_read');
	expect(read?.state).toBe('output-available');
	expect(JSON.stringify(read?.output)).toContain('# Readme');
	expect(task.plan).toEqual([{ content: 'greet', status: 'completed' }]);
	expect(h.svc.projects().map(p => p.name)).toEqual([h.repo.split(sep).pop()!]);
});

test('agents that are not signed in say how to sign in', async () => {
	const h = harness();
	let task = await h.wait(await h.svc.startTask('', h.repo, 'claude', '', 'login'));
	expect([task.agent, task.status, h.fakes.last().mode]).toEqual(['claude', 'failed', 'acceptEdits']);
	expect(h.error(task)).toContain('Claude Agent is not signed in');
	expect(h.error(task)).toContain('/login');
	h.fakes.options.signedOut = true;
	task = await h.wait(await h.svc.startTask('', h.repo, 'codebuddy', '', 'hello'));
	expect([task.agent, task.status]).toEqual(['codebuddy', 'failed']);
	expect(h.error(task)).toContain('CodeBuddy Code is not signed in: run `codebuddy`');
});

test('approvals reach the agent', async () => {
	const h = harness();
	let task = await h.start('run');
	expect(task.status).toBe('waiting');
	const pending = h.conv.pending(task.conversationId);
	expect(pending.map(p => p.tool)).toEqual(['codex_execute']);
	expect(JSON.stringify(pending[0]!.input)).toContain('npm test');
	task = await h.decide(task, { approved: true });
	expect([task.status, h.reply(task)]).toEqual(['review', 'done allow']);
	const history = h.store.history(task.conversationId);
	const last = history[history.length - 1]!;
	expect([last.parts[0]?.type, last.parts[0]?.state]).toEqual(['tool-codex_execute', 'output-available']);

	// A denial's reason goes to the agent once it has dealt with the denial.
	task = await h.say(task, 'run');
	task = await h.decide(task, { approved: false, reason: 'use make' });
	expect(h.reply(task)).toEndWith('got use make');

	// Always allow covers the same command from then on.
	task = await h.say(task, 'run');
	task = await h.decide(task, { approved: true, remember: rememberAlways });
	expect(h.reply(task)).toBe('done always');
	task = await h.say(task, 'run');
	expect([task.status, h.reply(task)]).toEqual(['review', 'done allow']);
});

test('edits in the worktree need no approval, and writing instead of deciding denies', async () => {
	const h = harness();
	let task = await h.start('edit');
	expect([task.status, h.reply(task)]).toEqual(['review', 'done allow']);
	task = await h.start('run');
	task = await h.say(task, 'never mind');
	expect(h.reply(task)).toBe('skippedgot never mind');
	expect(h.conv.pending(task.conversationId)).toHaveLength(0);
});

test('a stopped task is started again, loading its session', async () => {
	const h = harness();
	let task = await h.svc.startTask('', h.repo, '', 'wait', 'wait');
	await sleep(50);
	h.svc.stopTask(task.id);
	task = await h.wait(task);
	expect(task.status).toBe('stopped');
	// The replay is not shown again.
	task = await h.say(task, 'again');
	expect([h.fakes.agents.length, h.fakes.last().loaded, h.reply(task)]).toEqual([2, 's1', 'got again']);
});

test('only the owner works with tasks', async () => {
	const h = harness();
	const task = await h.start('hello');
	expect(h.conv.execute({ id: task.conversationId, text: 'hi', requestId: newID() }, () => {})).rejects.toMatchObject({ status: 403 });
});

test('task_start asks, then starts the task', async () => {
	const h = harness();
	await h.svc.addProject(h.repo, 'mob');
	const start = h.tool('task_start');
	expect(start.run(toolCall({ project: 'other', prompt: 'x' }))).rejects.toThrow('saved projects: mob');
	expect(start.run(toolCall({ project: 'mob', prompt: 'x' }))).rejects.toMatchObject({ asked: { project: h.repo, agent: 'codex', title: 'x', prompt: 'x' } });
	const out = await start.approved!({ conversationId: '', approvalId: '', input: JSON.stringify({ project: 'mob', agent: 'codex', title: 'Say hello', prompt: 'hello' }), store: h.store, owner: true }) as { task: string };
	const task = await h.wait(h.store.task(out.task)!);
	expect([task.project, task.title, task.status]).toEqual(['mob', 'Say hello', 'review']);
	expect(JSON.stringify(overview(h.svc, ''))).toContain('"latestReply":"Hi"');
});

test('a message while the agent works goes into the same turn', async () => {
	const h = harness();
	let task = await h.svc.startTask('', h.repo, '', '', 'hold');
	await h.svc.message(task.id, 'also this');
	h.fakes.last().release.resolve();
	task = await h.wait(task);
	const history = h.store.history(task.conversationId);
	expect(history.some(m => m.role === 'user' && textOf(m) === 'also this')).toBe(true);
	expect([task.status, textOf(history.filter(m => m.role === 'assistant').pop()!)]).toEqual(['review', 'holding got also this']);
});

test('deciding after a restart fails the approved call', async () => {
	const h = harness();
	let task = await h.start('run');
	// Mob stops: the agent ends with it, and starting again marks the task.
	h.svc.drop(task.id, h.svc.running(task.id)!);
	h.svc.recover();
	task = await h.decide(task, { approved: true });
	expect([task.status, h.fakes.agents.length]).toEqual(['stopped', 1]);
	expect(h.reply(task)).toContain('stopped before');
	for (const m of h.store.history(task.conversationId)) for (const p of m.parts) if (p.type === 'tool-codex_execute') expect(p.state).toBe('output-error');
});

test('inside follows links', () => {
	const dir = sep + join('w', 't');
	const cases: [string, boolean][] = [[join(dir, 'a.go'), true], [dir, true], ['b/c.go', true], [join(dir, '..', 'x'), false], [join(dir + 'x', 'a'), false]];
	for (const [path, want] of cases) expect([path, inside(dir, path)]).toEqual([path, want]);
	// Links are followed, even to files that do not exist yet.
	const worktree = temp(), outside = temp();
	symlinkSync(outside, join(worktree, 'link'));
	symlinkSync(join(outside, 'missing'), join(worktree, 'dangling'));
	const linked: [string, boolean][] = [[join(worktree, 'new', 'a.go'), true], [join(worktree, 'link', 'authorized_keys'), false], [join(worktree, 'link'), false], [join(worktree, 'dangling'), false]];
	for (const [path, want] of linked) expect([path, inside(worktree, path)]).toEqual([path, want]);
});

test('notices tell the owner', async () => {
	const h = harness();
	let notices: { conversationId: string; text: string; approvals?: { id: string }[]; channel?: string }[] = [];
	closers.push(h.conv.notices(n => notices.push(n)));
	const took = () => { const list = notices; notices = []; return list; };

	const task = await h.start('run');
	let got = took();
	expect(got).toHaveLength(1);
	expect([got[0]!.conversationId, got[0]!.approvals?.length]).toEqual([task.conversationId, 1]);
	expect(got[0]!.text).toStartWith('**Task waits for your decision:** codex · run');
	// The app a decision came from already shows how the turn ended.
	await h.decide(task, { approved: true }, 'Telegram');
	got = took();
	expect(got).toHaveLength(1);
	expect(got[0]!.channel).toBe('Telegram');
	expect(got[0]!.text).toContain('**Task done:** codex · run\nBranch `' + task.branch + '`\n\ndone allow');

	await h.wait(await h.svc.startTask('', h.repo, 'claude', '', 'login'));
	got = took();
	expect(got).toHaveLength(1);
	expect(got[0]!.text).toContain('**Task failed:** claude · login\n\nClaude Agent is not signed in');

	const limited = await h.wait(await h.svc.startTask('', h.repo, '', '', 'limit'));
	expect(limited.status).toBe('review');
	got = took();
	expect(got).toHaveLength(1);
	expect(got[0]!.text).toContain('**Task stopped early:** codex · limit\n\nCodex stopped at its limit (max_tokens); send a message to continue\n\nhalfway');

	const stopped = await h.svc.startTask('', h.repo, '', '', 'wait');
	await sleep(50);
	h.svc.stopTask(stopped.id);
	await h.wait(stopped);
	expect(took()).toHaveLength(0);

	// Nor does stopping one whose agent is still starting.
	h.fakes.slow = true;
	let starting = await h.svc.startTask('', h.repo, '', '', 'hello');
	await sleep(50);
	h.svc.stopTask(starting.id);
	starting = await h.wait(starting);
	expect(starting.status).toBe('stopped');
	expect(took()).toHaveLength(0);
});

test('what agents use is recorded', async () => {
	const home = temp();
	const before = process.env.CODEX_HOME;
	process.env.CODEX_HOME = home;
	closers.push(() => { if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before; });
	const h = harness();
	// Codex says what its session used only in its own records.
	const dir = join(home, 'sessions', '2026', '10', '20');
	mkdirSync(dir, { recursive: true });
	const rollout = join(dir, 'rollout-2026-10-20T10-00-00-s1.jsonl');
	const line = (input: number, cached: number, output: number) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 5, total_tokens: input + output }, last_token_usage: {} }, rate_limits: null } }) + '\n';
	writeFileSync(rollout, JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { cwd: '/', model: 'gpt-test' } }) + '\n' + line(1000, 800, 100));
	let task = await h.start('hello');
	appendFileSync(rollout, line(1500, 1200, 150));
	task = await h.say(task, 'again');
	let u = h.store.conversationUsage(task.conversationId).get(task.conversationId)!;
	expect([u.inputTokens, u.cacheReadTokens, u.outputTokens, u.reasoningTokens, u.turns, u.requests, u.models.map(m => m.model)]).toEqual([1500, 1200, 150, 5, 2, 2, ['gpt-test']]);
	// A session that cannot be loaded again is replaced by one counting from zero; what the old one used stays.
	h.svc.stopTask(task.id);
	await h.wait(task);
	h.fakes.options = { session: 's2', failLoad: true };
	writeFileSync(join(dir, 'rollout-2026-10-20T11-00-00-s2.jsonl'), line(100, 0, 20));
	task = await h.say(task, 'more');
	u = h.store.conversationUsage(task.conversationId).get(task.conversationId)!;
	expect([task.session, u.inputTokens, u.outputTokens, u.turns]).toEqual(['s2', 1600, 170, 3]);
	// Agents that report usage in their responses are taken at their word, with input counted with the cache, and the cost they report.
	task = await h.say(task, 'tokens');
	task = await h.say(task, 'tokens');
	u = h.store.conversationUsage(task.conversationId).get(task.conversationId)!;
	const top = u.models[0]!;
	expect([u.models.length, top.model, top.inputTokens, top.cacheReadTokens, top.cacheWriteTokens, top.outputTokens, u.cost.toFixed(2)]).toEqual([3, 'claude-test', 2000, 1800, 180, 80, '0.50']);
	const listed = (overview(h.svc, '').tasks[0]!.usage as { totalTokens: number }).totalTokens;
	expect(listed).toBe(u.totalTokens);
});

test('the tree shows who started whom', async () => {
	const h = harness();
	const root = h.store.create();
	const task = await h.wait(await h.svc.startTask(root.id, h.repo, '', 'Greet', 'hello'));
	const alone = await h.start('hello');
	const nodes = h.svc.tree('');
	expect(nodes).toHaveLength(3);
	const byID = new Map<string, AgentNode>(nodes.map(n => [n.conversationId, n]));
	const child = byID.get(task.conversationId)!, top = byID.get(root.id)!;
	expect([child.parent, child.label, child.model, child.status, !!child.task, child.tools]).toEqual([root.id, 'Codex', 'gpt-5.5-codex/high', 'review', true, ['read']]);
	expect([top.agent, top.status, top.parent, top.task]).toEqual([mob, idle, undefined, undefined]);
	expect(byID.get(alone.conversationId)!.parent).toBeUndefined();
	expect(outline(nodes)).toContain('- **Idle** · Mob · New conversation\n  - **Done** · Codex · Greet · ');
});

test('reviewing a task', async () => {
	const h = harness();
	const task = await h.start('hello');
	// The agent commits one file and leaves another changed and one new; meanwhile the project moves on.
	writeFileSync(join(task.worktree, 'a.go'), 'package a\n');
	writeFileSync(join(task.worktree, 'b.go'), 'package b\n');
	run(task.worktree, 'add', '.');
	run(task.worktree, 'commit', '-q', '-m', 'add a and b');
	writeFileSync(join(task.worktree, 'b.go'), 'package b\n\nvar B = 1\n');
	writeFileSync(join(task.worktree, 'new.txt'), 'new\n');
	writeFileSync(join(h.repo, 'main.go'), 'package main\n');
	run(h.repo, 'add', '.');
	run(h.repo, 'commit', '-q', '-m', 'main moves on');

	const got = await diff(h.svc, task.id, false, 'b.go') as { commits: string[]; changed: string[]; untracked: string[]; patch: string };
	const changed = got.changed.join(';');
	expect([got.commits.length, got.commits[0]!.endsWith('add a and b'), changed.includes('a.go'), changed.includes('3\t0\tb.go'), changed.includes('main.go')]).toEqual([1, true, true, true, false]);
	expect(got.untracked).toEqual(['new.txt']);
	expect([got.patch.includes('+var B = 1'), got.patch.includes('a.go'), got.patch.includes('new.txt')]).toEqual([true, false, false]);
	// A new file the agent has not added shows in full, alone or with the rest.
	for (const file of ['new.txt', '']) {
		const patch = (await diff(h.svc, task.id, true, file) as { patch: string }).patch;
		expect([file, patch.includes('+++ b/new.txt'), patch.includes('+new'), patch.includes('var B')]).toEqual([file, true, true, file === '']);
	}
	expect(diff(h.svc, 'nope', false, '')).rejects.toThrow('no task');

	// task_check asks first, then runs in the worktree it was approved for.
	const checkTool = h.tool('task_check');
	expect(checkTool.run(toolCall({ task: task.id, command: ' ' }))).rejects.toThrow('command is empty');
	const input = JSON.stringify({ task: task.id, project: task.project, worktree: task.worktree, command: 'ls new.txt; echo failing >&2; exit 3' });
	const result = await checkTool.approved!({ conversationId: '', approvalId: '', input, store: h.store, owner: true }) as { exitCode: number; output: string };
	expect([result.exitCode, result.output.includes('new.txt'), result.output.includes('failing')]).toEqual([3, true, true]);
	expect(checkTool.scope!(input)).toBe(task.project + ' ls new.txt; echo failing >&2; exit 3');

	// The owner's turns see the task; other callers' do not.
	for (const owner of [true, false]) {
		const turn = { owner, request: { system: '', messages: [] } } as unknown as Turn;
		snapshot(h.svc, turn);
		expect([owner, turn.request.system.includes('review: hello (task ' + task.id)]).toEqual([owner, owner]);
	}
});

test('a check that runs too long or is stopped ends', async () => {
	const stop = new AbortController();
	const running = check(temp(), 'sleep 5', stop.signal);
	setTimeout(() => stop.abort(new Error('stopped')), 50);
	expect(running).rejects.toThrow('stopped');
});

test('limited keeps the end', () => {
	const l = new Limited(4);
	l.write('abc');
	l.write('defg');
	expect(l.toString()).toBe('… 3 bytes cut\ndefg');
});

/** reviewer is Mob's model reviewing a finished task: it reads the task's diff, then concludes. */
const reviewer: llm.Model = {
	ref: { provider: 'test', model: 'reviewer' } as llm.Ref,
	info: { id: 'reviewer', name: 'reviewer', tools: true, known: false } as llm.Info,
	async stream(req, emit) {
		const last = req.messages[req.messages.length - 1]!;
		if (last.role === 'tool') {
			const text = 'Looks ready to merge; the diff names its branch: ' + last.text.includes('mob/say-hello') + '.';
			await emit('text', text);
			return { text, reasoning: '', signature: '', calls: [] };
		}
		const id = /coding task (\w+)/.exec(last.text)?.[1];
		if (!id) return { text: 'no task', reasoning: '', signature: '', calls: [] };
		return { text: '', reasoning: '', signature: '', calls: [{ id: 'diff1', name: 'task_diff', arguments: JSON.stringify({ task: id }) }] };
	},
};
const reviewers: Models = { default: () => 'test/reviewer', resolve: () => reviewer, setDefault: () => reviewer.ref, list: async () => [] };

test('Mob reviews a finished task', async () => {
	const h = harness(reviewers);
	const notices: { conversationId: string; text: string }[] = [];
	closers.push(h.conv.notices(n => notices.push(n)));
	const origin = h.store.create();
	const out = await h.tool('task_start').approved!({ conversationId: origin.id, approvalId: '', input: JSON.stringify({ project: h.repo, agent: 'codex', title: 'Say hello', prompt: 'hello' }), store: h.store, owner: true }) as { task: string };
	const task = await h.wait(h.store.task(out.task)!);
	expect([task.parent, task.status]).toEqual([origin.id, 'review']);
	await h.until('no review notice', () => notices.length > 0 && !h.conv.isActive(origin.id));
	// One notice, Mob's conclusion instead of the agent's words.
	expect(notices).toHaveLength(1);
	expect(notices[0]!.conversationId).toBe(origin.id);
	expect(notices[0]!.text).toStartWith('**Task reviewed:** codex · Say hello\nBranch `' + task.branch + '`\n\nLooks ready to merge');
	const history = h.store.history(origin.id);
	expect([history.length, textOf(history[0]!).startsWith('Automatic task update from Mob'), history[1]!.parts[0]?.type]).toEqual([2, true, 'tool-task_diff']);
	// Reviews on their own stop after reviewLimit.
	h.svc.reviews.set(task.id, reviewLimit);
	expect(h.svc.review(task)).toBe(false);
});

test('a session is resumed when the agent cannot load it', async () => {
	const h = harness();
	h.fakes.options.resumes = true;
	let task = await h.wait(await h.svc.startTask('', h.repo, 'dsh', '', 'hello'));
	expect([task.agent, task.session]).toEqual(['dsh', 's1']);
	h.svc.stopTask(task.id);
	task = await h.say(task, 'again');
	const f = h.fakes.last();
	expect([h.fakes.agents.length, f.resumed, f.dir, h.reply(task)]).toEqual([2, 's1', task.worktree, 'got again']);
});

test('starting an agent passes its patch and environment', async () => {
	// The patch file is the command's last argument.
	const p: Preset = { name: 'echo', title: 'Echo', commands: [['sh', '-c', 'eval "cat \\"\\${$#}\\""; echo "$MOB_AGENT_TEST$EXTRA"', 'sh']], env: { EXTRA: 'on' }, patch: '- id: x\n  disabled: true\n', signIn: '' };
	process.env.MOB_AGENT_TEST = 'leaked';
	closers.push(() => { delete process.env.MOB_AGENT_TEST; });
	const conn = startAgent(p, temp());
	const out = await new Response(conn.output).text();
	conn.stop();
	// MOB_* variables, such as the access token, stay with Mob.
	expect(out).toBe('- id: x\n  disabled: true\non\n');
	await sleep(50);
	expect(readdirSync(tmpdir()).filter(f => f.startsWith('mob-agent-') && f.endsWith('.patch.yml'))).toEqual([]);
});

test('remembering a request that names only its call', async () => {
	const h = harness();
	let task = await h.start('cmd curl https://trusted.example');
	expect(task.status).toBe('waiting');
	const pending = h.conv.pending(task.conversationId);
	expect(pending.map(p => p.tool)).toEqual(['codex_other']);
	expect(JSON.stringify(pending[0]!.input)).toContain('trusted.example');
	// The tree shows the command, not only the request's generic title.
	const [node] = h.svc.tree('');
	const a = node!.approvals[0]!;
	expect([a.tool, a.whole, a.text.includes('title: bash'), a.text.includes('curl https://trusted.example')]).toEqual(['codex_other', true, true, true]);
	task = await h.decide(task, { approved: true, remember: rememberAlways });
	expect([task.status, h.reply(task)]).toEqual(['review', 'allow-once']);
	// The same command is allowed from then on; another one is not.
	task = await h.say(task, 'cmd curl https://trusted.example');
	expect([task.status, h.reply(task)]).toEqual(['review', 'allow-once']);
	task = await h.say(task, 'cmd curl https://unrelated.example');
	expect(task.status).toBe('waiting');
	task = await h.decide(task, { approved: false });
	// A request with nothing to tell it apart is never remembered.
	task = await h.say(task, 'bare');
	task = await h.decide(task, { approved: true, remember: rememberAlways });
	task = await h.say(task, 'bare');
	expect(task.status).toBe('waiting');
	expect(h.store.grants().map(g => g.scope)).toEqual(['bash {"command":"curl https://trusted.example"}']);
});

test('a message stops with the signal that sent it', async () => {
	const h = harness();
	const task = await h.start('hello');
	const stop = new AbortController();
	await h.svc.message(task.id, 'wait', stop.signal);
	await h.until('the agent did not start', () => h.svc.running(task.id));
	// The token that sent the instruction is revoked: its turn ends.
	stop.abort();
	await h.until('the turn outlived its stop', () => !h.conv.isActive(task.conversationId));
});

test('an agent starts sub-tasks', async () => {
	const h = harness();
	const root = h.store.create();
	let lead = await h.svc.startTask(root.id, h.repo, '', 'Lead', 'sub Child');
	// The owner is asked first, in the lead task's conversation.
	lead = await h.wait(lead);
	expect(lead.status).toBe('waiting');
	const asked = h.svc.tree('').find(n => n.conversationId === lead.conversationId)!.approvals;
	expect(asked).toHaveLength(1);
	expect(asked[0]!.text).toContain('Start a sub-task: Child');
	expect(asked[0]!.text).toContain('"prompt":"hello"');
	await h.decide(lead, { approved: true });
	let child = await h.until('no sub-task started', () => h.store.tasks().find(c => c.parent === lead.conversationId));
	// The sub-task may be found before its first turn begins.
	child = await h.until('the sub-task did not finish', () => { const c = h.store.task(child.id)!; return c.status === 'review' && !h.conv.isActive(c.conversationId) && c; });
	expect([child.title, child.project]).toEqual(['Child', lead.project]);
	// A sub-task's server only takes its result: the tree is two agents deep at most.
	const sub = h.fakes.agents.find(f => f.dir === child.worktree)!;
	expect(sub.servers).toHaveLength(1);
	expect(sub.callMob('task_start', { title: 'x', prompt: 'more' })).rejects.toThrow();
	// Once its sub-tasks end, the lead agent hears how they went.
	const summary = await h.until('the lead agent was not told its sub-tasks ended', () =>
		h.store.history(lead.conversationId).filter(m => m.role === 'user').map(textOf).find(t => t.startsWith('Automatic update from Mob')));
	expect([summary.includes('Child'), summary.includes(child.branch), summary.includes('Hi')]).toEqual([true, true, true]);
	// The start is reported in the turn after the decision, which may have ended before the sub-task began.
	await h.wait(lead);
	await h.until('the approved call did not end', () => JSON.stringify(h.store.history(lead.conversationId)).includes('Started sub-task ' + child.id));
	// Another task's agent cannot reach this one's sub-tasks.
	expect(() => h.svc.hub.subtask(child.id, child.id)).toThrow();
	// Once the lead has delivered its work too, the sub-task's agent ends, and the lead's stays.
	await h.wait(lead);
	await h.until("the sub-task's agent was not reaped", () => !h.svc.running(child.id));
	expect(h.svc.running(lead.id)).toBeDefined();
	// A message starts it again, in the session it had.
	child = await h.say(child, 'hello');
	expect([child.status, h.reply(child), h.fakes.last().loaded]).toEqual(['review', 'Hi', 's1']);
});

test('sub-tasks that end after their lead stopped are reaped', async () => {
	const h = harness();
	const lead = await h.start('hello');
	const child = await h.wait(await h.svc.startTask(lead.conversationId, h.repo, '', 'Child', 'run'));
	expect(child.status).toBe('waiting');
	// The lead stops while its sub-task waits for the owner, so nothing is reaped yet.
	h.svc.stopTask(lead.id);
	expect(h.svc.running(child.id)).toBeDefined();
	// No turn of the stopped lead follows, so the sub-task's own end reaps it.
	await h.decide(child, { approved: true });
	await h.until("the sub-task's agent was not reaped", () => !h.svc.running(child.id));
});

test("a squad waits for its reviewers' turns to end", async () => {
	const h = harness();
	const { settleSquad } = await import('../src/agents/squad');
	const work = await h.start('hello');
	const origin = h.store.create();
	const reviewer = await h.svc.startReader(work.conversationId, work, 'codex', 'Review', 'hold', r => {
		h.svc.reviewers.add(r.id);
		h.svc.squads.set(work.id, { conversation: origin.id, reviewers: [r.id], starting: false });
	});
	const agent = await h.until('the reviewer did not start', () => h.fakes.agents.find(f => f.prompts.includes('hold')));
	// The reviewer has said how it ended, but its turn is still finishing.
	h.store.setTaskStatus(reviewer.id, 'review');
	settleSquad(h.svc, work);
	expect(h.svc.squads.has(work.id)).toBe(true);
	// Its turn's end settles the squad, and its agent goes.
	agent.release.resolve();
	await h.until("the reviewer's agent was not reaped", () => !h.svc.squads.has(work.id) && !h.svc.running(reviewer.id));
});

test('ended tasks are summarized', async () => {
	const h = harness();
	const root = h.store.create();
	const tasks = [await h.svc.startTask(root.id, h.repo, '', 'One', 'hello'), await h.svc.startTask(root.id, h.repo, '', 'Two', 'hello')];
	for (const t of tasks) await h.wait(t);
	const notes = () => h.store.history(root.id).filter(m => m.command).map(textOf);
	await h.until('no summary', () => notes().length > 0);
	expect(notes()).toHaveLength(1);
	expect(['All 2 tasks', 'One', 'Two'].map(s => notes()[0]!.includes(s))).toEqual([true, true, true]);
	// Ending again reports nothing new.
	const { settle } = await import('../src/agents/subtasks');
	settle(h.svc, tasks[0]!.id);
	expect(notes()).toHaveLength(1);
	// A task that ends again after more work is reported again.
	await sleep(5);
	await h.say(tasks[0]!, 'hello');
	await h.until('the second end was not reported', () => notes().length >= 2);
});

test('sub-task limits hold across approvals', async () => {
	const h = harness();
	const lead = await h.start('hello');
	// Approvals decided together each take a place before they start.
	for (let i = 0; i < subtaskActive; i++) h.svc.hub.reserve(lead);
	expect(() => h.svc.hub.reserve(lead)).toThrow('the most at once');
	h.svc.hub.release(lead);
	h.svc.hub.reserve(lead);
});

test('forgotten tokens reach nothing', async () => {
	const h = harness();
	const lead = await h.start('hello');
	const url = h.svc.hub.listen();
	const token = 'token-' + lead.id;
	h.svc.hub.tokens.set(token, lead.id);
	const headers = { Authorization: 'Bearer ' + token };
	expect(await callTool(url, headers, 'task_result', { outcome: 'passed', summary: 'ok' })).toBe('Recorded.');
	expect(h.store.task(lead.id)!.outcome).toBe('passed');
	h.svc.hub.forget(token);
	expect(callTool(url, headers, 'task_result', { outcome: 'passed', summary: 'ok' })).rejects.toThrow();
});

test('readers share a worktree without changing it', async () => {
	const h = harness();
	const root = h.store.create();
	const lead = await h.wait(await h.svc.startTask(root.id, h.repo, '', 'Lead', 'subread Review'));
	expect(lead.status).toBe('waiting');
	const pending = JSON.stringify(h.conv.pending(lead.conversationId));
	expect([pending.includes('Start a read-only sub-task: Review'), pending.includes('read-only in ' + lead.worktree)]).toEqual([true, true]);
	await h.decide(lead, { approved: true });
	const reader = await h.until('no reader', () => { const c = h.store.tasks().find(c => c.parent === lead.conversationId); return c?.status === 'review' && !h.conv.isActive(c.conversationId) && c; });
	expect([reader.readOnly, reader.worktree, reader.branch]).toEqual([true, lead.worktree, lead.branch]);
	// It runs in the agent's read-only mode, and its edit inside the worktree is refused without asking, where a writer's is allowed.
	const f = h.fakes.agents.find(f => f.prompts[0] === 'edit')!;
	expect([f.mode, h.reply(reader)]).toEqual(['', 'skipped']);
	expect(h.reply(await h.start('edit'))).toBe('done allow');
	// Agents with no read-only mode cannot read, and readers lend no worktree.
	expect(h.svc.startReader(root.id, lead, 'dsh', '', 'look')).rejects.toThrow('cannot work read-only');
	expect(h.svc.startReader(root.id, reader, '', '', 'look')).rejects.toThrow();
});

test('tasks report how they ended', async () => {
	const h = harness();
	const root = h.store.create();
	const tasks: Task[] = [];
	for (const prompt of ['result passed', 'result rework', 'result maybe']) tasks.push(await h.svc.startTask(root.id, h.repo, '', prompt, prompt));
	for (const [i, t] of tasks.entries()) tasks[i] = await h.wait(t);
	expect([tasks[0]!.outcome, tasks[0]!.result, tasks[1]!.outcome]).toEqual(['passed', 'found passed', 'rework']);
	// An outcome Mob does not know is refused, and the agent is told why.
	expect(tasks[2]!.outcome).toBeUndefined();
	expect(h.reply(tasks[2]!)).toContain('passed, rework or blocked');
	const note = await h.until('no summary', () => h.store.history(root.id).filter(m => m.command).map(textOf)[0]);
	// The summary says how each ended, with what it reported in place of its last words.
	expect(['**Done, passed**', '**Done, needs rework**', 'found rework'].map(s => note.includes(s))).toEqual([true, true, true]);
	expect(note).not.toContain('Recorded.');
	// More work forgets what the agent said of the last.
	const again = await h.say(tasks[0]!, 'hello');
	expect([again.outcome, again.result]).toEqual([undefined, undefined]);
});


test('a review squad', async () => {
	const seen: string[] = [];
	const validator: llm.Model = {
		ref: { provider: 'test', model: 'validator' } as llm.Ref,
		info: { id: 'validator', name: 'validator', tools: true, known: false } as llm.Info,
		async stream(req, emit) {
			seen.push(req.messages[req.messages.length - 1]!.text);
			await emit('text', 'P1: a bug; reworking.');
			return { text: 'P1: a bug; reworking.', reasoning: '', signature: '', calls: [] };
		},
	};
	const h = harness({ default: () => 'test/validator', resolve: () => validator, setDefault: () => validator.ref, list: async () => [] });
	const origin = h.store.create();
	await h.svc.addProject(h.repo, 'mob');
	const work = await h.wait(await h.svc.startTask(origin.id, 'mob', '', 'Work', 'hello'));
	// Mob's own review of the finished work ends first.
	await h.until('the review did not end', () => seen.length > 0 && !h.conv.isActive(origin.id));
	seen.length = 0;
	const squad = h.tool('task_review');
	for (const [input, want] of [
		[{ task: work.id, aspects: ['style'] }, 'no aspect'],
		[{ task: work.id, aspects: ['constructor'] }, 'no aspect'],
		[{ task: work.id, aspects: ['__proto__'] }, 'no aspect'],
		[{ task: work.id, aspects: ['correctness', 'tests', 'docs', 'hygiene'] }, 'at most 3'],
		[{ task: work.id, agent: 'dsh' }, 'cannot work read-only'],
		[{ task: 'nope' }, 'no task'],
	] as const) expect(squad.run(toolCall(input))).rejects.toThrow(want);
	// A sub-task of the work's own waits for the owner meanwhile.
	const helper = await h.wait(await h.svc.startTask(work.conversationId, 'mob', '', 'Helper', 'run'));
	expect(helper.status).toBe('waiting');
	const notices: { conversationId: string; text: string }[] = [];
	closers.push(h.conv.notices(n => notices.push(n)));
	// Each reviewer ends before the call that started it returns.
	h.svc.launched = async r => {
		if (r.readOnly) await h.until('a reviewer did not end', () => { const c = h.store.task(r.id)!; return c.status !== 'running' && c.status !== 'waiting' && !h.conv.isActive(c.conversationId); });
	};
	const input = JSON.stringify({ task: work.id, project: 'mob', agent: 'codex', aspects: ['correctness', 'tests'] });
	const approve = () => squad.approved!({ conversationId: origin.id, approvalId: '', input, store: h.store, owner: true });
	// Of two approvals decided together, one starts a squad.
	const outs = await Promise.allSettled([approve(), approve()]);
	expect(outs.map(o => o.status).sort()).toEqual(['fulfilled', 'rejected']);
	const out = (outs.find(o => o.status === 'fulfilled') as PromiseFulfilledResult<{ reviewers: unknown[] }>).value;
	expect(out.reviewers).toHaveLength(2);
	// Once both reviewers end, Mob's model gets their reports, and the owner its conclusion.
	await h.until('no squad notice', () => notices.length > 0 && !h.conv.isActive(origin.id));
	expect(seen).toHaveLength(1);
	expect(seen[0]).toContain('review squad for coding task ' + work.id);
	expect(seen[0]!.split('Done, needs rework')).toHaveLength(3);
	expect(['Review correctness: Work', 'Review tests: Work', 'found a bug in'].map(s => seen[0]!.includes(s))).toEqual([true, true, true]);
	// One notice: the conclusion, not each reviewer's words.
	expect(notices).toHaveLength(1);
	expect(notices[0]!.text).toStartWith('**Task reviewed by 2 agents:** codex · Work');
	expect(notices[0]!.text).toContain('P1: a bug');
	// The reports went to Mob, not to the agent that did the work, without waiting for its own sub-task.
	const told = () => h.store.history(work.conversationId).filter(m => m.role === 'user').map(textOf).find(t => t.startsWith('Automatic update from Mob'));
	expect(told()).toBeUndefined();
	// The squad is done, so another may start, and its reviewers' agents have ended.
	expect(h.svc.squads.has(work.id)).toBe(false);
	expect((out.reviewers as { task: string }[]).filter(r => h.svc.running(r.task))).toEqual([]);
	expect(h.svc.running(work.id)).toBeDefined();
	// Once its own sub-task ends, the agent hears of it, and not of the reviewers.
	await h.decide(helper, { approved: true });
	const summary = await h.until('the worker was not told its sub-task ended', told);
	expect([summary.includes('Helper'), summary.includes('Review correctness')]).toEqual([true, false]);
});
