import { expect, test } from 'bun:test';
import type { ApprovedCall, ToolCall } from '@mob/core';
import { Cloudflare, type Config } from '../src/cloudflare/cloudflare';
import { readOnly, target, tools } from '../src/cloudflare';

const base: Config = { enabled: true, accountId: 'a'.repeat(32), token: 'secret-token', model: '@cf/chat', embeddingModel: '@cf/embed', index: 'test', databaseId: 'db', namespaceId: 'ns', bucket: '', accessKey: '', secretKey: '' };

function api(result = () => '{"success":true,"result":[]}') {
	const paths: string[] = [];
	const fetcher = (async (url: string, init: RequestInit) => {
		const u = new URL(url);
		expect(u.host).toBe('api.cloudflare.com');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
		paths.push(u.pathname);
		let out = result();
		if (u.pathname.endsWith('/tokens/verify')) out = '{"success":true,"result":{"status":"active"}}';
		else if (u.pathname.includes('/ai/run/@cf/embed')) out = '{"success":true,"result":{"data":[[0.1,0.2]]}}';
		else if (u.pathname.endsWith('/indexes/test/query')) { const b = JSON.parse(String(init.body)); expect([b.vector.length, b.topK]).toEqual([2, 5]); }
		else if (u.pathname.endsWith('/d1/database/db/query')) { const b = JSON.parse(String(init.body)); if (b.params) expect(b.sql).toBe('SELECT ?'); }
		else if (u.pathname.includes('/values/')) out = 'stored value';
		return new Response(out);
	}) as unknown as typeof fetch;
	return { paths, fetcher };
}

test('service requests', async () => {
	const { paths, fetcher } = api();
	const c = new Cloudflare(base, fetcher);
	for (const a of [{ operation: 'test' }, { operation: 'ai.models' }, { operation: 'ai.run', text: 'hello' }, { operation: 'vectorize.indexes' }, { operation: 'vectorize.query', text: 'find a fact' }, { operation: 'd1.databases' }, { operation: 'd1.query', sql: 'SELECT ?', params: ['value'] }, { operation: 'kv.namespaces' }, { operation: 'kv.get', key: 'hello/world' }, { operation: 'r2.buckets' }]) await c.do(a);
	expect(paths).toHaveLength(11);
	expect([1, 3, 6, 8, 10].map(i => paths[i]!.replace('/client/v4/accounts/' + base.accountId, ''))).toEqual(['/ai/models/search', '/vectorize/v2/indexes', '/d1/database', '/storage/kv/namespaces', '/r2/buckets']);
	expect(paths[9]).toEndWith('/values/hello%2Fworld');
	const off = new Cloudflare({ ...base, enabled: false }, fetcher);
	for (const operation of ['ai.models', 'vectorize.indexes', 'd1.databases', 'kv.namespaces', 'r2.buckets']) expect(off.do({ operation })).rejects.toThrow('disabled');
	expect(c.do({ operation: 'r2.get', key: 'private' })).rejects.toThrow('R2 object access requires');
	expect(new Cloudflare({ ...base, index: '../bad' }, fetcher).do({ operation: 'vectorize.query', text: 'x' })).rejects.toThrow('invalid resource');
	expect(paths).toHaveLength(11);
});

test('read-only SQL', () => {
	const cases: [string, boolean][] = [['SELECT 1', true], [' select *\nfrom t; ', true], ['SELECT\t1', true], ['SELECT 1; DELETE FROM t', false], ["SELECT ';'", false], ['WITH x AS (SELECT 1) DELETE FROM t', false], ['/* */ SELECT 1', false], ['PRAGMA table_info(t)', false], ['', false]];
	for (const [sql, want] of cases) expect([sql, readOnly(sql)]).toEqual([sql, want]);
});

test('the tool asks before costly or writing calls and runs what was approved', async () => {
	const { paths, fetcher } = api();
	let config: Config = { ...base, enabled: false };
	const tool = tools(() => config, fetcher)[0]!;
	expect(tool.available!()).toBe(false);
	config = { ...config, enabled: true };
	expect(tool.available!()).toBe(true);
	const run = (input: Record<string, unknown>) => tool.run({ input, requestApproval: async () => { throw new Error('awaiting approval'); } } as unknown as ToolCall);
	expect(run({ operation: 'test' })).rejects.toThrow('unknown');
	await run({ operation: 'd1.databases' });
	for (const operation of ['ai.run', 'vectorize.query', 'd1.query']) expect(run({ operation, argument: 'DELETE FROM t' })).rejects.toThrow('awaiting approval');
	await run({ operation: 'd1.query', argument: ' select * from t; ' });
	expect(paths).toHaveLength(2);
	const approved = { input: JSON.stringify({ operation: 'd1.query', argument: 'SELECT ?', params: [1], target: target(config, 'd1.query') }) } as ApprovedCall;
	config = { ...config, databaseId: 'production' };
	expect(tool.approved!(approved)).rejects.toThrow('configuration changed');
	config = { ...config, databaseId: 'db' };
	await tool.approved!(approved);
	expect(paths.at(-1)).toBe(`/client/v4/accounts/${base.accountId}/d1/database/db/query`);
});
