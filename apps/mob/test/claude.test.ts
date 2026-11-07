import { expect, test } from 'bun:test';
import type { Options as SDKOptions, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Task } from '@mob/core';
import { call, claudeRuntime, usage } from '../src/agents/claude';
import { preset } from '../src/agents/presets';
import type { Choice, PermissionRequest, Update } from '../src/agents/runtime';

/** Fake is Claude Code as the SDK shows it: it answers each prompt the test's way. */
class Fake {
	options!: SDKOptions;
	prompts: string[] = [];
	interrupted = 0;
	failInit = false;
	private out: SDKMessage[] = [];
	private wake?: () => void;
	private closed = false;
	/** answer runs for each prompt. */
	answer: (f: Fake, text: string) => Promise<void> = async (f, text) => {
		f.send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'got ' + text } } } as never);
		f.result();
	};
	runs = 0;

	query = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: SDKOptions }) => {
		this.options = options;
		this.runs++;
		const f = this;
		void (async () => {
			for await (const m of prompt) {
				const text = String(m.message.content);
				f.prompts.push(text);
				await f.answer(f, text);
			}
		})();
		return {
			initializationResult: () => f.failInit && options.resume ? Promise.reject(new Error('No conversation found')) : Promise.resolve({}),
			interrupt: async () => { f.interrupted++; f.result({ subtype: 'error_during_execution', is_error: true, errors: [] }); },
			close: () => { f.closed = true; f.wake?.(); },
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const m = f.out.shift();
					if (m) { yield m; continue; }
					if (f.closed) return;
					await new Promise<void>(r => (f.wake = r));
				}
			},
		} as never;
	};

	send(m: SDKMessage) { this.out.push(m); this.wake?.(); }

	/** result ends the prompt, having cost cost in all so far. */
	result(extra: Record<string, unknown> = {}, cost = 0.5) {
		this.send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '', total_cost_usd: cost, modelUsage: { 'claude-test': { costUSD: cost, contextWindow: 200000 } }, ...extra } as never);
	}
}

async function open(t: Partial<Task> = {}, choice: Choice = 'allow', confined = false) {
	const fake = new Fake();
	const updates: Update[] = [], asked: PermissionRequest[] = [], created: string[] = [];
	const task = { id: 'task', worktree: '/work', session: '', readOnly: false, ...t } as Task;
	const session = await claudeRuntime(fake.query as never).open({
		preset: preset('claude'), task, confined,
		servers: () => [{ name: 'mob', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } }],
		handler: { update: u => { updates.push(u); }, permission: async r => { asked.push(r); return choice; } },
		created: id => created.push(id),
	}, new AbortController().signal);
	return { fake, session, updates, asked, created };
}

test('a prompt streams text and ends with what it used', async () => {
	const { fake, session, updates, created } = await open();
	fake.answer = async (f, text) => {
		f.send({ type: 'system', subtype: 'init', model: 'claude-test' } as never);
		f.send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'got ' + text } } } as never);
		// One request, in two messages that each carry its usage.
		const message = { id: 'msg1', model: 'claude-test', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 40 } };
		f.send({ type: 'assistant', parent_tool_use_id: null, message } as never);
		f.send({ type: 'assistant', parent_tool_use_id: null, message } as never);
		f.result({}, 0.25);
	};
	const end = await session.prompt('hello');
	expect([session.id, created]).toEqual([fake.options.sessionId!, [fake.options.sessionId!]]);
	expect(fake.prompts).toEqual(['hello']);
	expect(updates).toEqual([{ type: 'model', model: 'claude-test' }, { type: 'text', text: 'got hello' }, { type: 'context', used: 1040, size: 200000 }]);
	expect(end).toEqual({ reason: 'end_turn', err: undefined, signedOut: false, usage: [{ model: 'claude-test', usage: { inputTokens: 1000, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 90, cost: 0.25 } }] });
	// Claude Code's arguments follow Mob's own command; Mob's tools need no asking; edits in the worktree none either.
	expect([fake.options.cwd, fake.options.permissionMode, fake.options.allowDangerouslySkipPermissions]).toEqual(['/work', 'acceptEdits', false]);
	expect(await fake.options.canUseTool!('mcp__mob__task_result', { outcome: 'passed' }, { signal: new AbortController().signal, toolUseID: 'r' } as never)).toEqual({ behavior: 'allow', updatedInput: { outcome: 'passed' } });
	expect(fake.options.mcpServers).toEqual({ mob: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer x' } } });
	// The next prompt's cost is what the session cost since.
	fake.answer = async f => f.result({}, 0.75);
	expect((await session.prompt('again')).usage).toEqual([{ model: 'claude-test', usage: { inputTokens: 0, outputTokens: 0, cost: 0.5 } }]);
	session.close();
});

test('tool calls show and ask Mob first', async () => {
	const { fake, session, updates, asked } = await open({}, 'reject');
	let denied: unknown;
	fake.answer = async f => {
		const input = { command: 'rm -rf /', description: 'clean' };
		f.send({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', model: 'claude-test', content: [{ type: 'tool_use', id: 'call1', name: 'Bash', input }, { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'step', status: 'in_progress' }] } }] } } as never);
		denied = await f.options.canUseTool!('Bash', input, { signal: new AbortController().signal, toolUseID: 'call1' } as never);
		f.send({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'refused', is_error: true }] } } as never);
		f.result();
	};
	await session.prompt('go');
	expect(asked).toEqual([{ id: 'call1', title: 'rm -rf /', kind: 'execute', locations: [], input: { command: 'rm -rf /', description: 'clean' } }]);
	expect(denied).toEqual({ behavior: 'deny', message: 'The owner declined this call.' });
	expect(updates.filter(u => u.type !== 'context')).toEqual([
		{ type: 'tool', start: true, id: 'call1', title: 'rm -rf /', kind: 'execute', locations: [], input: { command: 'rm -rf /', description: 'clean' }, status: 'pending', content: undefined },
		{ type: 'plan', entries: [{ content: 'step', status: 'in_progress' }] },
		{ type: 'tool', start: false, id: 'call1', status: 'failed', content: [{ type: 'text', text: 'refused' }], output: 'refused' },
	]);
	session.close();
});

test('a confined agent works with full permission, a reader asks before edits', async () => {
	const confined = await open({}, 'allow', true);
	expect([confined.fake.options.permissionMode, confined.fake.options.allowDangerouslySkipPermissions, confined.fake.options.canUseTool]).toEqual(['bypassPermissions', true, undefined]);
	confined.session.close();
	const reader = await open({ readOnly: true }, 'allow', true);
	expect([reader.fake.options.permissionMode, reader.fake.options.allowDangerouslySkipPermissions]).toEqual(['default', false]);
	reader.session.close();
});

test('a session is resumed, or started afresh when Claude Code no longer has it', async () => {
	const resumed = await open({ session: 'old' });
	expect([resumed.fake.options.resume, resumed.session.id, resumed.created]).toEqual(['old', 'old', []]);
	// A resumed session reports what it cost before too, so its first prompt has no cost of its own.
	expect((await resumed.session.prompt('hi')).usage).toEqual([]);
	resumed.session.close();
	const fake = new Fake();
	fake.failInit = true;
	const created: string[] = [];
	const s = await claudeRuntime(fake.query as never).open({
		preset: preset('claude'), task: { id: 't', worktree: '/work', session: 'gone', readOnly: false } as Task, confined: false,
		servers: () => [], handler: { update: () => {}, permission: async () => 'allow' }, created: id => created.push(id),
	}, new AbortController().signal);
	expect([fake.runs, fake.options.resume, created]).toEqual([2, undefined, [s.id]]);
	s.close();
});

test('cancelling and signing in end prompts as Mob reads them', async () => {
	const { fake, session } = await open();
	fake.answer = async () => {};
	const pending = session.prompt('long');
	await Bun.sleep(5);
	session.cancel();
	expect([(await pending).reason, fake.interrupted]).toEqual(['cancelled', 1]);
	fake.answer = async f => f.result({ is_error: true, result: 'Not logged in · Please run /login' });
	const out = await session.prompt('x');
	expect([out.signedOut, String(out.err)]).toEqual([true, 'Error: Not logged in · Please run /login']);
	session.close();
});

test('calls show their files and changes', () => {
	expect(call('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })).toEqual({ title: 'Edit /w/a.ts', kind: 'edit', locations: ['/w/a.ts'], content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b' }] });
	expect(call('Grep', { pattern: 'TODO' })).toEqual({ title: 'Grep TODO', kind: 'search', locations: [], content: undefined });
	expect(call('mcp__mob__task_result', { outcome: 'passed' })).toEqual({ title: 'mcp__mob__task_result', kind: 'other', locations: [], content: undefined });
	expect(usage({ input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 })).toEqual({ inputTokens: 6, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 3 });
});
