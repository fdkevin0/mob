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

test('a denial without a reason ends its stream', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	let approval = '';
	await service.execute({ id: c.id, text: '/remember x', requestId: newID() }, e => { if (e.approvalId) approval = e.approvalId; });
	const running = await service.start({ id: c.id, text: '', requestId: '', approval: { id: approval, approved: false }, owner: true });
	const chunks: unknown[] = [];
	await running.follow(0, (_, e) => { chunks.push(encodeEvent(e)); });
	expect(chunks).toEqual([{ type: 'finish', finishReason: 'stop' }]);
	s.close();
});

test('a turn reports what its prompt takes of the window, and the service keeps it until the conversation moves on', async () => {
	const s = open();
	// A model with a known window that says how many tokens each prompt was.
	class Counted extends DemoModel {
		override readonly info = { ...new DemoModel().info, context: 100000, output: 8000 };
		override async stream(...args: Parameters<DemoModel['stream']>) {
			const result = await super.stream(...args);
			result.usage = { inputTokens: 1200, outputTokens: 30 };
			return result;
		}
	}
	const models: Models = { ...demoModels, resolve: () => new Counted() };
	const service = new ConversationService(s, models);
	const c = s.create();
	const fresh = service.context(newID(), true)!;
	expect([fresh.window, fresh.reserve, fresh.limit, fresh.measured]).toEqual([100000, 8000, 92000, false]);
	expect(fresh.parts!.messages).toBe(0);
	expect(fresh.parts!.tools).toBeGreaterThan(0);
	const chunks: Record<string, any>[] = [];
	await service.execute({ id: c.id, text: 'hello', requestId: newID() }, e => { chunks.push(encodeEvent(e)); });
	const reported = chunks.filter(k => k.type === 'data-context');
	expect(reported.map(k => k.id)).toEqual(['context', 'context']);
	expect(reported[0].data.measured).toBe(false);
	const last = reported.at(-1)!.data;
	expect([last.measured, last.used, last.limit]).toEqual([true, 1230, 92000]);
	const p = last.parts;
	expect(Math.abs(p.system + p.tools + p.summary + p.messages + p.outputs - 1230)).toBeLessThanOrEqual(3);
	expect(service.context(c.id, true)).toEqual(last);
	// Another message is newer than the reply the snapshot describes, so the next turn is estimated.
	s.command(c.id, newID(), '/usage', 'usage');
	expect(service.context(c.id, true)).toEqual(last);
	s.begin(c.id, newID(), 'and more', 'demo/echo');
	const next = service.context(c.id, true)!;
	expect(next.measured).toBe(false);
	expect(next.parts!.messages).toBeGreaterThan(0);
	// /compact adds only commands but changes the summary, so the next turn is estimated with it.
	const compacted = new ConversationService(s, models);
	await compacted.execute({ id: c.id, text: 'hello again', requestId: newID() }, () => {});
	const before = compacted.context(c.id, true)!;
	expect(before.measured).toBe(true);
	await compacted.execute({ id: c.id, text: '/compact', requestId: newID() }, () => {});
	const after = compacted.context(c.id, true)!;
	expect(after.measured).toBe(false);
	expect(after.summarized).toBeGreaterThan(0);
	expect(after.used).toBeLessThan(before.used);
	s.close();
});

test('a message said again replaces it and everything after it', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	await service.execute({ id: c.id, text: 'first', requestId: 'r1' }, () => {});
	await service.execute({ id: c.id, text: '/remember tea', requestId: 'r2' }, () => {});
	const pending = s.history(c.id).at(-1)!.parts.find(p => p.state === 'approval-requested');
	expect(pending).toBeTruthy();
	s.summarize(c.id, { text: 'they said first', through: s.history(c.id)[1].id });
	await service.execute({ id: c.id, text: 'second', requestId: 'r3', replace: 'r2' }, () => {});
	expect(s.history(c.id).map(m => (m.role === 'user' ? textOf(m) : m.role))).toEqual(['first', 'assistant', 'second', 'assistant']);
	expect(s.waiting().has(c.id)).toBe(false);
	// The summary covered only what stayed.
	expect(s.summary(c.id).text).toBe('they said first');
	await service.execute({ id: c.id, text: 'again', requestId: 'r4', replace: 'r1' }, () => {});
	expect(s.history(c.id).map(m => (m.role === 'user' ? m.id : m.role))).toEqual(['r4', 'assistant']);
	expect(s.summary(c.id)).toEqual({ text: '', through: '' });
	// A title taken from the first message follows it.
	expect(s.list().find(x => x.id === c.id)?.title).toBe('again');
	await expect(service.execute({ id: c.id, text: 'x', requestId: 'r5', replace: 'missing' }, () => {})).rejects.toThrow('not in this conversation');
	await expect(service.execute({ id: c.id, text: 'x', requestId: 'r6', replace: s.history(c.id)[1].id }, () => {})).rejects.toThrow('not in this conversation');
	s.rename(c.id, 'Mine');
	await service.execute({ id: c.id, text: 'renamed', requestId: 'r7', replace: 'r4' }, () => {});
	expect(s.list().find(x => x.id === c.id)?.title).toBe('Mine');
	s.close();
});
