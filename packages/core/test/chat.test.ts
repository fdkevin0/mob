import { expect, test } from 'bun:test';
import { getEventListeners } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService, DemoModel, Store, defaultTools, searchHistory, emptyHooks, encodeEvent, newID, OverflowError, prompt, rank, run, textOf, words, type Event, type Models } from '../src';
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

test('the owner may approve a call with input changed, when its tool can revise it', async () => {
	const s = open();
	const c = s.create();
	const m = s.begin(c.id, 'request-1', '/remember 喜欢中文', 'demo/echo');
	const events: Event[] = [];
	await run(new AbortController().signal, s, new DemoModel(), { tools: defaultTools(), hooks: emptyHooks(), owner: false }, c.id, m, '', e => { events.push(e); });
	const approval = events.find(e => e.kind === 'approval-requested')!.approvalId!;
	const service = new ConversationService(s, demoModels);
	const decide = (input: unknown) => service.execute({ id: c.id, text: '', requestId: '', approval: { id: approval, approved: true, input }, owner: true }, () => {});
	// remember cannot be changed as it is approved: the approval still waits.
	await expect(decide({ fact: '喜欢英文' })).rejects.toThrow('remember cannot be changed as it is approved');
	expect(s.pendingApproval(c.id, approval).input).toBe(JSON.stringify({ fact: '喜欢中文' }));
	// A tool that revises checks the change, and carries out what it returns.
	const remember = service.tools.list().find(t => t.name === 'remember')!;
	remember.revise = async (_input, changed) => {
		const fact = String((changed as { fact?: unknown }).fact ?? '').trim();
		if (!fact) throw new Error('fact is empty');
		return { fact };
	};
	await expect(decide({ fact: ' ' })).rejects.toThrow('fact is empty');
	await decide({ fact: ' 喜欢英文 ' });
	expect(s.memories(c.id, false)).toEqual(['喜欢英文']);
	// The call shows what was approved.
	expect(s.history(c.id)[1].parts[0].input).toEqual({ fact: '喜欢英文' });
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

test('transcript commands are answered and recorded; choosing a model is not', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	const shown = await service.commands.run({ client: 'web', conversationId: c.id, text: '/model' }, true);
	expect(shown.markdown).toContain('This conversation uses demo/echo');
	expect((await service.commands.run({ client: 'web', conversationId: c.id, text: '/model demo/echo' }, true)).markdown).toContain('Switched this conversation to demo/echo');
	expect((await service.commands.run({ client: 'web', conversationId: c.id, text: '/models' }, true)).markdown).toContain('**Current model:** `demo/echo`');
	expect(s.history(c.id)).toEqual([]);
	expect(s.conversationModel(c.id)).toBe('demo/echo');
	expect((await service.commands.run({ client: 'web', conversationId: c.id, text: '/model demo/echo' }, false)).markdown).toContain('Only the owner');
	const chunks: Record<string, unknown>[] = [];
	await service.execute({ id: c.id, text: '/compact', requestId: newID(), owner: true }, e => { chunks.push(encodeEvent(e)); });
	expect(chunks.find(c => c.type === 'text-delta')?.delta).toContain('nothing new to summarize');
	expect(s.history(c.id)[1].command).toBe(true);
	const result = await service.commands.run({ client: 'web', conversationId: c.id, text: '/new' }, true);
	expect(result.action?.kind).toBe('open-conversation');
	expect(await service.commands.complete({ client: 'web', text: '/mo' }, true)).toEqual([
		{ value: '/model', label: '/model [NAME | default [NAME]]', detail: "Show or switch this conversation's model" },
		{ value: '/models', label: '/models [FILTER]', detail: 'List available models' },
	]);
	s.close();
});

test('setModel starts a conversation not started yet and follows the default when empty', () => {
	const s = open();
	const service = new ConversationService(s, { ...demoModels, resolve: q => { if (!q.startsWith('demo')) throw new Error('no model matches "' + q + '"'); return new DemoModel(); } });
	const id = newID();
	expect(service.model(id)).toBe('demo/echo');
	expect(service.setModel(id, 'demo/echo')).toBe('demo/echo');
	expect(s.conversationModel(id)).toBe('demo/echo');
	expect(s.list()).toEqual([]);
	expect(service.setModel(id, '')).toBe('demo/echo');
	expect(s.conversationModel(id)).toBe('');
	expect(() => service.setModel(id, 'nope/none')).toThrow(expect.objectContaining({ status: 400 }));
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

test('a reply records its model, usage and timing, and streams them as metadata', async () => {
	const s = open();
	const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
	// A model that waits before its first words and writes for a while after them.
	class Timed extends DemoModel {
		override async stream(...[req, emit]: Parameters<DemoModel['stream']>) {
			await pause(40);
			await emit('text', 'Hello ');
			await pause(60);
			await emit('text', 'there');
			return { text: 'Hello there', reasoning: '', signature: '', calls: [], usage: { inputTokens: 900, outputTokens: 12 } };
		}
	}
	const service = new ConversationService(s, { ...demoModels, resolve: () => new Timed() });
	const c = s.create();
	const chunks: Record<string, any>[] = [];
	await service.execute({ id: c.id, text: 'hi', requestId: newID() }, e => { chunks.push(encodeEvent(e)); });
	expect(chunks[0]).toMatchObject({ type: 'start', messageMetadata: { model: 'demo/echo', stats: { startedAt: expect.any(Number) } } });
	const end = chunks.find(k => k.type === 'message-metadata')!.messageMetadata;
	expect(end.usage).toMatchObject({ inputTokens: 900, outputTokens: 12 });
	const stats = end.stats;
	expect(stats.firstTokenMs).toBeGreaterThanOrEqual(35);
	expect(stats.generationMs).toBeGreaterThanOrEqual(55);
	expect(stats.generationMs).toBeLessThan(stats.finishedAt - stats.startedAt);
	expect([stats.timedOutput, stats.requests, stats.toolMs]).toEqual([12, 1, 0]);
	// The history says the same as the stream did.
	const reply = s.history(c.id)[1];
	expect(reply.metadata).toMatchObject({ model: 'demo/echo', usage: end.usage, stats });
	const ledger = s.exportConversation(c.id).usage;
	expect(ledger).toHaveLength(1);
	expect(ledger[0].firstTokenMs).toBeGreaterThanOrEqual(35);
	expect(ledger[0].firstTokenMs).toBeLessThan(ledger[0].durationMs);
	// Stats move with the conversation.
	const moved = s.importConversation(s.exportConversation(c.id));
	expect(s.history(moved.id)[1].stats).toEqual(stats);
	s.close();
});

test('a reply counts a prompt sent again after the provider refused it as too long', async () => {
	const s = open();
	const c = s.create();
	let calls = 0;
	// A model that answers at once, except that it refuses the second turn's first prompt.
	class Refusing extends DemoModel {
		override async stream(...[, emit]: Parameters<DemoModel['stream']>) {
			if (++calls === 2) throw new OverflowError('prompt is too long');
			await emit('text', 'ok');
			return { text: 'ok', reasoning: '', signature: '', calls: [], usage: { inputTokens: 10, outputTokens: 1 } };
		}
	}
	const service = new ConversationService(s, { ...demoModels, resolve: () => new Refusing() });
	await service.execute({ id: c.id, text: 'earlier '.repeat(4000), requestId: newID() }, () => {});
	await service.execute({ id: c.id, text: 'and now', requestId: newID() }, () => {});
	expect(calls).toBe(3);
	expect(s.history(c.id).at(-1)!.stats?.requests).toBe(2);
	s.close();
});

// A summary's request counts whether or not the provider reported its usage.
test.each([true, false])('a reply counts and times the requests that summarized older messages for it (summary usage reported: %p)', async (reported) => {
	const s = open();
	const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
	let calls = 0, summaries = 0;
	// A small window, so older messages are summarized before the model answers.
	class Small extends DemoModel {
		override readonly info = { ...new DemoModel().info, context: 12000, output: 1000 };
		override async stream(...[req, emit]: Parameters<DemoModel['stream']>) {
			calls++;
			const summarizing = req.system.startsWith('You keep the summary');
			if (summarizing) summaries++;
			await pause(20);
			await emit('text', summarizing ? 'what was said' : 'ok');
			await pause(10);
			const usage = summarizing && !reported ? undefined : { inputTokens: 10, outputTokens: 3 };
			return { text: summarizing ? 'what was said' : 'ok', reasoning: '', signature: '', calls: [], usage };
		}
	}
	const service = new ConversationService(s, { ...demoModels, resolve: () => new Small() });
	const c = s.create();
	const say = (i: number) => service.execute({ id: c.id, text: `part ${i} ` + 'word '.repeat(4000), requestId: newID() }, () => {});
	for (let i = 0; i < 3; i++) await say(i);
	calls = summaries = 0;
	await say(3);
	expect(summaries).toBeGreaterThan(0);
	const reply = s.history(c.id).at(-1)!;
	expect(reply.stats?.requests).toBe(calls);
	const measured = reported ? calls : calls - summaries;
	expect(reply.stats?.timedOutput).toBe(3 * measured);
	const rows = s.exportConversation(c.id).usage.filter(u => u.messageId === reply.id);
	expect(rows).toHaveLength(measured);
	for (const row of rows) expect(row.firstTokenMs).toBeGreaterThanOrEqual(15);
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
	// A refused or stopped replacement deletes nothing.
	await service.execute({ id: c.id, text: 'later', requestId: 'r8' }, () => {});
	const kept = s.history(c.id).map(m => m.id);
	await expect(service.execute({ id: c.id, text: 'dup', requestId: 'r7', replace: 'r8' }, () => {})).rejects.toThrow('request already accepted');
	await expect(service.execute({ id: c.id, text: 'dup', requestId: 'r8', replace: 'r8' }, () => {})).rejects.toThrow('request already accepted');
	await expect(service.execute({ id: c.id, text: 'dup', requestId: 'r8', replace: 'r7' }, () => {})).rejects.toThrow('request already accepted');
	await expect(service.execute({ id: c.id, text: '/compact', requestId: 'r9', replace: 'r8' }, () => {})).rejects.toThrow('cannot replace');
	const stop = new AbortController();
	stop.abort();
	await expect(service.start({ id: c.id, text: 'stopped', requestId: 'r10', replace: 'r7' }, stop.signal)).rejects.toThrow();
	expect(s.history(c.id).map(m => m.id)).toEqual(kept);
	s.close();
});


test('turns release shared cancellation listeners after completion and failure', async () => {
	const s = open();
	const service = new ConversationService(s, demoModels);
	const c = s.create();
	const stop = new AbortController();
	for (let i = 0; i < 3; i++) {
		const running = await service.start({ id: c.id, text: '/compact', requestId: newID(), owner: true }, stop.signal);
		await running.whenDone();
		expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
	}
	await expect(service.execute({ id: c.id, text: 'hello', requestId: newID() }, () => { throw new Error('reader failed'); }, { signal: stop.signal })).rejects.toThrow('reader failed');
	expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
	const running = await service.start({ id: c.id, text: 'hello', requestId: newID() }, stop.signal);
	stop.abort();
	await running.whenDone();
	expect(running.signal.aborted).toBe(true);
	expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
	await service.close();
	s.close();
});

test('history_search finds the original words of messages a summary stands in for', async () => {
	const s = open();
	const c = s.create();
	const said: { name: string; tools: string[]; result?: string }[] = [];
	// A small window, so older messages are summarized; the model searches once, then answers.
	class Recalling extends DemoModel {
		override readonly info = { ...new DemoModel().info, context: 12000, output: 1000 };
		override async stream(...[req]: Parameters<DemoModel['stream']>) {
			const result = { text: '', reasoning: '', signature: '', calls: [] as { id: string; name: string; arguments: string }[] };
			if (req.system.startsWith('You keep the summary')) return { ...result, text: 'they talked about paths' };
			const last = req.messages.at(-1)!;
			said.push({ name: last.role, tools: (req.tools ?? []).map(t => t.name), result: last.role === 'tool' ? last.text : undefined });
			if (last.role === 'user' && last.text.startsWith('recall') && req.tools?.some(t => t.name === 'history_search')) {
				return { ...result, calls: [{ id: newID(), name: 'history_search', arguments: JSON.stringify({ query: 'config path' }) }] };
			}
			return { ...result, text: 'ok' };
		}
	}
	const service = new ConversationService(s, { ...demoModels, resolve: () => new Recalling() });
	await service.execute({ id: c.id, text: 'the config path is /etc/mob/zebra.yaml', requestId: newID() }, () => {});
	expect(said.at(-1)!.tools).not.toContain('history_search');
	for (let i = 0; i < 3; i++) await service.execute({ id: c.id, text: `part ${i} ` + 'word '.repeat(4000), requestId: newID() }, () => {});
	await service.execute({ id: c.id, text: 'recall the config path', requestId: newID() }, () => {});
	expect(s.summary(c.id).text).toBe('they talked about paths');
	const found = said.at(-1)!;
	expect(found.name).toBe('tool');
	expect(found.result).toContain('/etc/mob/zebra.yaml');
	s.close();
});

test('searchHistory ranks excerpts of text and tool calls, leaving out commands', () => {
	const messages = [
		{ id: 'a', role: 'user', parts: [{ type: 'text', text: 'deploy to 北京 region please' }] },
		{ id: 'b', role: 'assistant', parts: [{ type: 'tool-sandbox', toolCallId: 'x', state: 'output-available', input: { command: 'make' }, output: { stderr: 'error: missing libfoo.so' } }] },
		{ id: 'c', role: 'user', command: true, parts: [{ type: 'text', text: '/usage libfoo' }] },
	];
	expect(searchHistory(messages, 'libfoo error', 5).results.map(r => r.message)).toEqual(['b']);
	expect(searchHistory(messages, '北京', 5).results[0].text).toBe('User: deploy to 北京 region please');
	expect(searchHistory(messages, 'a', 5).results.map(r => r.message)).toEqual(['a']);
	expect(searchHistory(messages, 'nothing here', 5).results).toEqual([]);
	// A long message is cut into overlapping excerpts.
	const long = { id: 'l', role: 'assistant', parts: [{ type: 'text', text: 'x '.repeat(2000) + 'needle' }] };
	const r = searchHistory([long], 'needle', 5).results;
	expect(r).toHaveLength(1);
	expect(r[0].text.endsWith('needle')).toBe(true);
});
