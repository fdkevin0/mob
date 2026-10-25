import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry, Server, Store } from '../src';
import { openBun } from '../src/sqlite/bun';

test('plugin routes answer whether the plugin comes with the server or after it', async () => {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-server-')), 'mob.sqlite'))).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' }, [
		{ name: 'early', routes: [{ method: 'GET', path: 'ping', handle: async () => ({ pong: 'early' }) }] },
	]);
	server.register({ name: 'late', routes: [{ method: 'POST', path: 'ping', handle: async req => ({ pong: await req.text() }) }] });
	const call = (method: string, path: string, body?: string) =>
		server.fetch(new Request('http://127.0.0.1:8787' + path, { method, body, headers: { Authorization: 'Bearer ' + token } }));
	expect(await (await call('GET', '/api/plugins/early/ping')).json()).toEqual({ pong: 'early' });
	expect(await (await call('POST', '/api/plugins/late/ping', 'late')).json()).toEqual({ pong: 'late' });
	expect((await call('GET', '/api/plugins/late/ping')).status).toBe(405);
	expect((await call('GET', '/api/plugins/missing/ping')).status).toBe(404);
});

test('models list which ones are free', async () => {
	const { memoryProviders } = await import('../src');
	const listed = { data: [{ id: 'meta/llama:free' }, { id: 'openai/gpt-x' }] };
	const registry = new ProviderRegistry(memoryProviders({ providers: [{ id: 'openrouter', preset: 'openrouter', key: 'k' }] }), undefined, false, async () => Response.json(listed));
	const [group] = await registry.list('');
	expect(group.models.map(m => [m.id, m.free ?? false])).toEqual([['meta/llama:free', true], ['openai/gpt-x', false]]);
});

test('a first run starts on the demo model, and OpenCode Zen lists only its paid models', async () => {
	const { memoryProviders } = await import('../src');
	expect(new ProviderRegistry(memoryProviders()).default()).toBe('demo/echo');
	const asked: Headers[] = [];
	const registry = new ProviderRegistry(memoryProviders({ providers: [{ id: 'opencode', preset: 'opencode', key: 'k' }] }), undefined, false, async (_, init) => {
		asked.push(new Headers(init?.headers));
		return Response.json({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'big-pickle' }, { id: 'claude-x' }] });
	});
	const [group] = await registry.list('');
	expect(group.models.map(m => m.id)).toEqual(['claude-x']);
	expect(asked[0].get('x-opencode-client')).toBeNull();
});

test('the first provider added takes over from the demo default, and a model listed without tools says so', async () => {
	const { adoptDefault, initialProviders, memoryProviders } = await import('../src');
	const f = initialProviders();
	adoptDefault(f, { id: 'openrouter', preset: 'openrouter', key: 'k' }, ['a/x', 'b/y']);
	expect(f.default).toBe('openrouter/a/x');
	adoptDefault(f, { id: 'deepseek', preset: 'deepseek', key: 'k' }, ['deepseek-chat']);
	expect(f.default).toBe('openrouter/a/x');
	const none = initialProviders();
	adoptDefault(none, { id: 'work', chat: 'https://llm.example/v1' }, []);
	expect(none.default).toBeUndefined();
	const zen = initialProviders();
	const zenRegistry = new ProviderRegistry(memoryProviders(zen), undefined, false, async () => Response.json({ data: [{ id: 'big-pickle' }, { id: 'mimo-v2.6-flash-free' }, { id: 'claude-x' }] }));
	const zenProvider = { id: 'opencode', preset: 'opencode', key: 'k' };
	adoptDefault(zen, zenProvider, await zenRegistry.fetch(zenProvider));
	expect(zen.default).toBe('opencode/claude-x');
	const listed = { data: [{ id: 'a/no-tools:free', supported_parameters: ['temperature'] }, { id: 'z/tools:free', supported_parameters: ['tools'] }] };
	const registry = new ProviderRegistry(memoryProviders({ providers: [{ id: 'openrouter', preset: 'openrouter', key: 'k' }] }), undefined, false, async () => Response.json(listed));
	const [group] = await registry.list('');
	expect(group.models.map(m => [m.id, m.tools])).toEqual([['a/no-tools:free', false], ['z/tools:free', true]]);
});

test('the web saves a model provider, which becomes the default', async () => {
	const { memoryProviders } = await import('../src');
	const registry = new ProviderRegistry(memoryProviders({ providers: [] }), undefined, false, async () => Response.json({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }));
	const token = 't'.repeat(64);
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-server-')), 'mob.sqlite'))).open();
	const server = new Server({ store, providers: registry, token, version: 'test' });
	const save = (body: unknown) => server.fetch(new Request('http://127.0.0.1:8787/api/providers', { method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }));
	expect(await (await save({ preset: 'deepseek', key: '' })).text()).toContain('Enter an API key.');
	expect((await save({ preset: 'nowhere', key: 'k' })).status).toBe(400);
	expect((await save({ preset: 'deepseek', key: 'k', extra: 1 })).status).toBe(400);
	expect(await (await save({ preset: 'deepseek', key: ' sk-1 ', model: 'deepseek-reasoner' })).json()).toEqual({ default: 'deepseek/deepseek-reasoner', models: 2 });
	expect(registry.providers()).toMatchObject({ default: 'deepseek/deepseek-reasoner', providers: [{ id: 'deepseek', preset: 'deepseek', key: 'sk-1' }] });
	// A local server needs no key.
	expect(await (await save({ preset: 'ollama', key: '' })).json()).toEqual({ default: 'ollama/deepseek-chat', models: 2 });
	expect((await save({ preset: '', url: '', key: 'k' })).status).toBe(400);
});

test('the conversation list marks conversations waiting for a decision, and says when that changes', async () => {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-server-')), 'mob.sqlite'))).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const call = (method: string, path: string, body?: unknown) =>
		server.fetch(new Request('http://127.0.0.1:8787' + path, { method, body: body && JSON.stringify(body), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }));
	const listed: string[] = [];
	store.changes.subscribe(c => { if (c.list && c.conversation) listed.push(c.conversation); });
	const { id } = await (await call('POST', '/api/conversations')).json() as { id: string };
	const other = store.create();
	listed.length = 0;
	await (await call('POST', '/api/chat', { id, text: '/remember 喜欢中文', requestId: 'r'.repeat(20) })).text();
	expect(listed.filter(c => c === id).length).toBeGreaterThanOrEqual(3);
	const list = await (await call('GET', '/api/conversations')).json() as { id: string; active: boolean; waiting: boolean }[];
	expect(list.find(c => c.id === id)).toMatchObject({ active: false, waiting: true });
	// A conversation nothing was said in has nothing to list.
	expect(list.find(c => c.id === other.id)).toBeUndefined();
});

test('a client starts a conversation with its first message, and the owner renames and deletes it', async () => {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-server-')), 'mob.sqlite'))).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const call = (method: string, path: string, body?: unknown) =>
		server.fetch(new Request('http://127.0.0.1:8787' + path, { method, body: body && JSON.stringify(body), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }));
	const list = async () => (await (await call('GET', '/api/conversations')).json() as { id: string; title: string }[]);
	const id = 'a'.repeat(32);
	// Before its first message the conversation is empty and listed nowhere.
	expect(await (await call('GET', `/api/conversations/${id}`)).json()).toMatchObject({ messages: [], active: false });
	expect((await call('GET', '/api/conversations/not-an-id')).status).toBe(404);
	expect(await list()).toEqual([]);
	await (await call('POST', '/api/chat', { id, text: '/remember 喜欢中文', requestId: 'r'.repeat(20) })).text();
	expect((await list()).map(c => c.id)).toEqual([id]);

	expect((await call('POST', `/api/conversations/${id}/rename`, { title: '   ' })).status).toBe(400);
	expect((await call('POST', `/api/conversations/${'b'.repeat(32)}/rename`, { title: 'Nowhere' })).status).toBe(404);
	expect(await (await call('POST', `/api/conversations/${id}/rename`, { title: ' Chinese\n replies ' })).json()).toEqual({ id, title: 'Chinese replies' });
	expect((await list())[0].title).toBe('Chinese replies');

	// A fact the owner approved outlives the conversation that saved it.
	store.saveFact('f'.repeat(32), id, 'kept everywhere', true);
	store.saveFact('g'.repeat(32), id, 'only here', false);
	expect(await (await call('POST', `/api/conversations/${id}/delete`)).json()).toEqual({ deleted: true });
	expect(await list()).toEqual([]);
	expect(store.history(id)).toEqual([]);
	expect(store.facts().map(f => f.text)).toEqual(['kept everywhere']);
	const plain = store.create();
	store.command(plain.id, 'p'.repeat(20), '/help', 'help');
	await call('POST', `/api/conversations/${plain.id}/delete`);
	expect(store.exists(plain.id)).toBe(false);
	expect((await call('POST', `/api/conversations/${plain.id}/delete`)).status).toBe(404);
});

test('a conversation not written in yet has its context estimated, and an unknown one is not found', async () => {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-server-')), 'mob.sqlite'))).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const get = (path: string) => server.fetch(new Request('http://127.0.0.1:8787' + path, { headers: { Authorization: 'Bearer ' + token } }));
	const { context } = await (await get('/api/conversations/' + 'a'.repeat(32) + '/context')).json() as { context: { model: string; window: number; used: number; measured: boolean } };
	// The demo model has no known window, so only its tokens are shown.
	expect([context.model, context.window, context.measured]).toEqual(['demo/echo', 0, false]);
	expect(context.used).toBeGreaterThan(0);
	expect((await get('/api/conversations/nope/context')).status).toBe(404);
});

test('a chat request can say an earlier message again', async () => {
	const store = new Store(openBun(join(mkdtempSync(join(tmpdir(), 'mob-server-')), 'mob.sqlite'))).open();
	const token = 't'.repeat(64);
	const server = new Server({ store, providers: new ProviderRegistry(undefined, undefined, true), token, version: 'test' });
	const call = (method: string, path: string, body?: unknown) =>
		server.fetch(new Request('http://127.0.0.1:8787' + path, { method, body: body && JSON.stringify(body), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }));
	const id = 'c'.repeat(32);
	await (await call('POST', '/api/chat', { id, text: 'first', requestId: 'r1' })).text();
	await (await call('POST', '/api/chat', { id, text: 'edited', requestId: 'r2', replace: 'r1' })).text();
	const { messages } = await (await call('GET', `/api/conversations/${id}`)).json() as { messages: { id: string; role: string }[] };
	expect(messages.map(m => m.role === 'user' ? m.id : m.role)).toEqual(['r2', 'assistant']);
	expect((await call('POST', '/api/chat', { id, text: 'again', requestId: 'r3', replace: 'r1' })).status).toBe(404);
	expect((await call('POST', '/api/chat', { id, text: 'again', requestId: 'r4', replace: 7 })).status).toBe(400);
});
