import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService, DemoModel, Store, defaultTools, emptyHooks, encodeEvent, newID, prompt, rank, run, textOf, words, type Event, type Models } from '../src';
import { openBun } from '../src/sqlite/bun';

const temp = () => join(mkdtempSync(join(tmpdir(), 'mob-core-')), 'chat.sqlite');
const open = (path = temp()) => new Store(openBun(path)).open();
const demoModels: Models = { default: () => 'demo/echo', resolve: () => new DemoModel(), setDefault: () => new DemoModel().ref, list: async () => [] };

test('approval, carrying out, and recovery', async () => {
	const path = temp();
	let s = open(path);
	const c = s.create();
	const m = s.begin(c.id, 'request-1', '/remember 喜欢中文', 'demo/echo');
	const events: Event[] = [];
	await run(new AbortController().signal, s, new DemoModel(), { tools: defaultTools(), hooks: emptyHooks(), owner: false }, c.id, m, '', e => { events.push(e); });
	const approval = events.find(e => e.kind === 'approval-requested')?.approvalId;
	expect(approval).toBeTruthy();
	expect(s.memories(c.id, false)).toEqual([]);
	expect(() => s.decide(newID(), approval!, true, '')).toThrow();
	const service = new ConversationService(s, demoModels);
	const chunks: unknown[] = [];
	await service.execute({ id: c.id, text: '', requestId: '', approval: { id: approval!, approved: true }, owner: true }, e => { chunks.push(encodeEvent(e)); });
	expect(s.memories(c.id, false)).toEqual(['喜欢中文']);
	expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
	expect(() => s.begin(c.id, 'request-1', 'duplicate', '')).toThrow();
	const history = s.history(c.id);
	expect(history[1].parts[0].state).toBe('output-available');
	const n = s.begin(c.id, 'interrupted', 'hello', '');
	n.parts = [{ type: 'text', text: 'partial' }];
	s.save(n, 'streaming', '');
	s.close();
	s = open(path);
	const last = s.history(c.id).at(-1)!;
	expect(textOf(last)).toBe('partial');
	expect(last.metadata?.status).toBe('interrupted');
	s.close();
});

test('a turn streams AI SDK chunks and saves the reply', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	const chunks: Record<string, unknown>[] = [];
	await service.execute({ id: c.id, text: 'hello', requestId: newID() }, e => { chunks.push(encodeEvent(e)); });
	expect(chunks[0].type).toBe('start');
	expect(chunks.map(c => c.type)).toContain('text-delta');
	expect(chunks.at(-1)!.type).toBe('finish');
	const history = s.history(c.id);
	expect(history).toHaveLength(2);
	expect(textOf(history[1])).toContain('Received: hello');
	expect(history[1].metadata?.status).toBe('complete');
	expect(service.isActive(c.id)).toBe(false);
	s.close();
});

test('a busy conversation refuses a second turn, and stop ends the first', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	const running = await service.start({ id: c.id, text: 'a long enough message', requestId: newID() });
	await expect(service.execute({ id: c.id, text: 'again', requestId: newID() }, () => {})).rejects.toMatchObject({ status: 409 });
	expect(service.stop(c.id)).toBe(true);
	await running.whenDone();
	expect(s.history(c.id)[1].metadata?.status).toBe('cancelled');
	s.close();
});

test('transcript commands are answered and recorded', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	const chunks: Record<string, unknown>[] = [];
	await service.execute({ id: c.id, text: '/model', requestId: newID(), owner: true }, e => { chunks.push(encodeEvent(e)); });
	expect(chunks.find(c => c.type === 'text-delta')?.delta).toContain('This conversation uses demo/echo');
	expect(s.history(c.id)[1].command).toBe(true);
	const result = await service.commands.run({ client: 'web', conversationId: c.id, text: '/new' }, true);
	expect(result.action?.kind).toBe('open-conversation');
	expect(await service.commands.complete({ client: 'web', text: '/mo' }, true)).toEqual([
		{ value: '/model', label: '/model [NAME | default [NAME]]', detail: "Show or switch this conversation's model" },
		{ value: '/models', label: '/models [FILTER]', detail: 'List available models' },
	]);
	s.close();
});

test('prompt replays tool calls and keeps within budget', () => {
	const history = [
		{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
		{ id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'calling' }, { type: 'tool-datetime', toolCallId: 'c1', state: 'output-available', input: {}, output: { iso: 'x' } }, { type: 'text', text: 'done' }] },
		{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
	];
	const [messages, , through] = prompt(history, 'none', 0);
	expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
	expect(messages[2].text).toBe('{"iso":"x"}');
	expect(through).toBe('');
	const [fitted, , omitted] = prompt(history, 'none', 3);
	expect(fitted.map(m => m.text)).toEqual(['second']);
	expect(omitted).toBe('a1');
});

test('tool search ranks by BM25 and splits words', () => {
	expect(words('GitHub issues_list 发邮件')).toEqual(['github', 'git', 'hub', 'issue', 'list', '发', '邮', '件']);
	const docs = [
		{ name: 'send_email', fields: [['send_email', 3], ['Send an email message', 1]] as [string, number][] },
		{ name: 'github_issue', fields: [['github_issue', 3], ['Create a GitHub issue', 1]] as [string, number][] },
	];
	expect(rank(docs, 'github issue', 5)).toEqual([1]);
	expect(rank(docs, 'send_email', 5)[0]).toBe(0);
});
