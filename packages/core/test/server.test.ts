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
	const listed = { data: [{ id: 'a/no-tools:free', supported_parameters: ['temperature'] }, { id: 'z/tools:free', supported_parameters: ['tools'] }] };
	const registry = new ProviderRegistry(memoryProviders({ providers: [{ id: 'openrouter', preset: 'openrouter', key: 'k' }] }), undefined, false, async () => Response.json(listed));
	const [group] = await registry.list('');
	expect(group.models.map(m => [m.id, m.tools])).toEqual([['a/no-tools:free', false], ['z/tools:free', true]]);
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
	expect(list.find(c => c.id === other.id)).toMatchObject({ active: false, waiting: false });
});
