import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationService, DemoModel, ProviderRegistry, Server, Store, defaultTools, emptyHooks, newID, run, textOf, type Event, type Models } from '../src';
import { openBun } from '../src/sqlite/bun';

const open = () => new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-transfer-')), 'mob.sqlite'))).open();
const demoModels: Models = { default: () => 'demo/echo', resolve: () => new DemoModel(), setDefault: () => new DemoModel().ref, list: async () => [] };

test('a conversation moves to another Mob and back with its transcript, facts and usage', async () => {
	const a = open(), b = open();
	const c = a.create();
	await new ConversationService(a, demoModels).execute({ id: c.id, text: 'hello there', requestId: newID() }, () => {});
	a.saveFact(newID(), c.id, 'likes tea', true);
	a.recordUsage(c.id, a.history(c.id)[1].id, 'demo/echo', { inputTokens: 3, outputTokens: 4 }, 10);
	const moved = b.importConversation(a.exportConversation(c.id));
	expect(moved.id).not.toBe(c.id);
	expect(b.list()[0].title).toBe('hello there');
	expect(b.history(moved.id).map(textOf)).toEqual(a.history(c.id).map(textOf));
	expect(b.memories(moved.id, false)).toEqual(['likes tea']);
	expect(b.conversationUsage(moved.id).get(moved.id)?.outputTokens).toBe(4);
	// Back again: the message IDs are taken, so they are replaced, and the owner's fact is not kept twice.
	const back = a.importConversation(b.exportConversation(moved.id));
	expect(a.history(back.id).map(textOf)).toEqual(a.history(c.id).map(textOf));
	expect(a.facts().filter(f => f.text === 'likes tea')).toHaveLength(1);
	expect(() => b.importConversation({ v: 2 } as never)).toThrow('not a conversation');
	a.close(); b.close();
});

test('a conversation waiting on an approval or a reply does not move', async () => {
	const s = open();
	const c = s.create();
	const m = s.begin(c.id, newID(), '/remember x', 'demo/echo');
	const events: Event[] = [];
	await run(new AbortController().signal, s, new DemoModel(), { tools: defaultTools(), hooks: emptyHooks(), owner: false }, c.id, m, '', e => { events.push(e); });
	expect(events.some(e => e.kind === 'approval-requested')).toBe(true);
	const token = 't'.repeat(64);
	const server = new Server({ store: s, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const call = (method: string, path: string, body?: object) => server.fetch(new Request('http://127.0.0.1' + path, { method, body: body && JSON.stringify(body), headers: { Authorization: 'Bearer ' + token } }));
	const refused = await call('GET', `/api/conversations/${c.id}/export`);
	expect(refused.status).toBe(409);
	expect(await refused.text()).toContain('approval');
	const other = s.create();
	const exported = await (await call('GET', `/api/conversations/${other.id}/export`)).json();
	expect((await call('POST', '/api/conversations/import', exported)).status).toBe(200);
	expect((await call('POST', '/api/conversations/import', { v: 1 })).status).toBe(400);
	await server.close();
	s.close();
});
