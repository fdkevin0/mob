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
