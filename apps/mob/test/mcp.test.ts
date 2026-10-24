import { expect, test } from 'bun:test';
import { ToolRegistry, type ApprovedCall, type ToolCall } from '@mob/core';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, exposure, fingerprint, validate, type Server, type Servers } from '../src/mcp/config';
import { Hub, localName, toolName } from '../src/mcp/hub';
import type { Settings } from '../src/mcp/oauth';
import { testServer } from './fixtures/mcp-server';

const memory = (): Settings & { values: Map<string, string> } => {
	const values = new Map<string, string>();
	return { values, setting: <T>(k: string) => values.has(k) ? JSON.parse(values.get(k)!) as T : undefined, saveSetting: (k, v) => { values.set(k, JSON.stringify(v)); } };
};

const until = async (what: () => boolean, label: () => string) => {
	for (const deadline = Date.now() + 20_000; Date.now() < deadline; await Bun.sleep(20)) if (what()) return;
	throw new Error('timed out: ' + label());
};

/** approve runs a tool's call as if the owner approved what it asked. */
async function approve(hub: Hub, name: string, input: Record<string, unknown>) {
	const tool = hub.tools().find(t => t.name === name)!;
	let asked: unknown;
	await tool.run({ input, requestApproval: async (i: unknown) => { asked = i; throw new Error('asked'); } } as unknown as ToolCall).catch(() => {});
	return tool.approved!({ input: JSON.stringify(asked), conversationId: 'c', approvalId: 'a', owner: true } as unknown as ApprovedCall);
}

test('validate', () => {
	const cases: [Servers, boolean][] = [
		[{ github: { command: 'npx', args: ['-y', 'server'], env: ['TOKEN=x'] } }, true],
		[{ docs: { url: 'https://example.com/mcp', headers: { authorization: 'Bearer x' } } }, true],
		[{ both: { command: 'x', url: 'https://example.com' } }, false],
		[{ none: {} }, false],
		[{ a__b: { command: 'x' } }, false],
		[{ fs_: { command: 'x' } }, false],
		[{ _fs: { command: 'x' } }, false],
		[{ 'my_fs-2': { command: 'x' } }, true],
		[{ ['a'.repeat(33)]: { command: 'x' } }, false],
		[{ 'Bad Name': { command: 'x' } }, false],
		[{ ftp: { url: 'ftp://example.com' } }, false],
		[{ env: { command: 'x', env: ['NOVALUE'] } }, false],
		[{ mixed: { url: 'https://example.com', args: ['x'] } }, false],
		[{ mixed: { command: 'x', headers: { a: 'b' } } }, false],
		[{ shown: { command: 'x', exposure: 'direct', toolExposure: { 'delete_*': 'hidden' } } }, true],
		[{ shown: { command: 'x', exposure: 'always' } }, false],
		[{ shown: { command: 'x', toolExposure: { '[': 'hidden' } } }, false],
		[{ shown: { command: 'x', toolExposure: { 'get_*': 'loud' } } }, false],
		[{ o: { url: 'https://example.com', oauth: true, headers: { Authorization: 'x' } } }, false],
	];
	for (const [servers, ok] of cases) {
		let err: unknown;
		try { validate(servers); } catch (e) { err = e; }
		expect([JSON.stringify(servers), !err]).toEqual([JSON.stringify(servers), ok]);
	}
	expect(decode({ fs: { command: 'x', tool_exposure: { a: 'direct' } } })).toEqual({ fs: { command: 'x', toolExposure: { a: 'direct' } } });
	expect(() => decode({ fs: { command: 'x', cmd: 'y' } })).toThrow('unknown field cmd');
});

test('exposure, tool names, fingerprints and local names', () => {
	const s: Server = { exposure: 'direct', toolExposure: { '*_issue': 'deferred', 'delete_*': 'hidden', delete_issue: 'direct', 'get_*': 'deferred', 'get_?ssue': 'hidden' } };
	expect(['search', 'create_issue', 'delete_repo', 'delete_issue', 'get_issue'].map(t => exposure(s, t))).toEqual(['direct', 'deferred', 'hidden', 'direct', 'hidden']);
	expect(exposure({}, 'any')).toBe('deferred');
	expect(toolName('fs', 'read_file')).toBe('mcp__fs__read_file');
	const dotted = toolName('fs', 'read.file');
	expect(dotted.startsWith('mcp__fs__read_file_') && dotted.length <= 64).toBe(true);
	expect(toolName('server', 'x'.repeat(80))).toHaveLength(64);
	expect(toolName('server', 'x'.repeat(80))).not.toBe(toolName('server', 'x'.repeat(81)));
	const base: Server = { url: 'https://example.com/mcp', headers: { authorization: 'Bearer a' } };
	expect(fingerprint(base)).not.toBe(fingerprint({ ...base, headers: { authorization: 'Bearer b' } }));
	expect(fingerprint({ command: 'a', args: ['b c'] })).not.toBe(fingerprint({ command: 'a', args: ['b', 'c'] }));
	expect(fingerprint({ command: 'a', args: [] })).toBe(fingerprint({ command: 'a' }));
	expect(fingerprint({ url: 'https://x' })).not.toBe(fingerprint({ url: 'https://x', oauth: true }));
	expect(localName('https://mcp.cloudflare.com/mcp', {})).toBe('cloudflare');
	expect(localName('https://docs.mcp.cloudflare.com/mcp', { 'cloudflare-docs': { command: 'x' } })).toBe('cloudflare-docs-2');
	expect(localName('https://api.example.io/v1/sse', {})).toBe('example');
});

test('tool names stay apart in the registry', () => {
	const hub = new Hub();
	const tools: Record<string, string[]> = { fs: ['_read_file', 'read_file', 'read.file', 'a__b', 'x'.repeat(80)], fs_a: ['b', 'read_file'], 'fs-a': ['_b', 'x'.repeat(80)], fs_a_b: ['c'] };
	const servers = Object.fromEntries(Object.keys(tools).map(n => [n, { command: 'x' }]));
	validate(servers);
	hub.configure(servers);
	(hub as any).states = new Map(Object.entries(tools).map(([n, ts]) => [n, { server: { command: 'x' }, tools: ts.map(name => ({ name, inputSchema: { type: 'object' } })), status: '' }]));
	const registry = new ToolRegistry();
	registry.registerSource(() => hub.tools());
	expect(new Set(registry.list().map(t => t.name)).size).toBe(Object.values(tools).flat().length);
});

test('a command server offers its tools without Mob’s variables', async () => {
	const hub = new Hub();
	process.env.MOB_SECRET = 'leak';
	hub.configure({ fs: { command: process.execPath, args: [join(import.meta.dir, 'fixtures', 'mcp-server.ts')], env: ['EXTRA=yes'] } });
	const stop = new AbortController();
	const serving = hub.serve(hub.configured(), stop.signal, () => {});
	try {
		await until(() => hub.status() === 'fs: 3 tools', () => hub.status());
		expect(hub.tools().map(t => t.name).sort()).toEqual(['mcp__fs__echo', 'mcp__fs__env', 'mcp__fs__fail']);
		expect(await approve(hub, 'mcp__fs__echo', { text: 'hi' })).toBe('echo: hi');
		expect(JSON.parse(await approve(hub, 'mcp__fs__env', {}) as string)).toEqual({ secret: '', extra: 'yes' });
		expect(approve(hub, 'mcp__fs__fail', {})).rejects.toThrow('it failed');
		expect(hub.describe()).toContain('`mcp__fs__echo`');
	} finally {
		stop.abort();
		await serving;
		delete process.env.MOB_SECRET;
	}
});

const dsh = join(import.meta.dir, '../../dsh');

test.skipIf(!existsSync(join(dsh, 'node_modules/@deepseek-ai/cordis')) && !existsSync(join(dsh, '../../node_modules/@deepseek-ai/cordis')))('DSH plugins run through the MCP bridge only once approved, and are disposed when it stops', async () => {
	const fixture = mkdtempSync(join(tmpdir(), 'mob-dsh-'));
	const called = join(fixture, 'called'), disposed = join(fixture, 'disposed'), config = join(fixture, 'plugins.json');
	writeFileSync(config, JSON.stringify([{ module: join(dsh, 'tests/fixtures/noisy.ts'), config: { called, disposed } }]));
	const hub = new Hub();
	hub.configure({ dsh: { command: process.execPath, args: [join(dsh, 'src/main.ts'), config] } });
	const stop = new AbortController();
	const serving = hub.serve(hub.configured(), stop.signal, () => {});
	try {
		await until(() => hub.status() === 'dsh: 1 tools', () => hub.status());
		const [tool] = hub.tools();
		expect(tool!.name).toBe('mcp__dsh__noisy');
		expect(tool!.approved).toBeDefined();
		let asked = false;
		await tool!.run({ input: {}, requestApproval: async () => { asked = true; throw new Error('asked'); } } as unknown as ToolCall).catch(() => {});
		expect(asked).toBe(true);
		expect(existsSync(called)).toBe(false);
		expect(await approve(hub, 'mcp__dsh__noisy', {})).toBe('ok');
		expect(readFileSync(called, 'utf8')).toBe('called');
	} finally {
		stop.abort();
		await serving;
	}
	await until(() => existsSync(disposed), () => 'DSH plugin cleanup did not finish');
	expect(readFileSync(disposed, 'utf8')).toBe('disposed');
	rmSync(fixture, { recursive: true, force: true });
}, 60_000);

/** oauthServer is an MCP server behind a minimal OAuth authorization server that accepts only the token it last issued. */
function oauthServer() {
	const o = { token: '', issued: 0, registers: 0, redirects: [] as string[] };
	const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
	const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req): Promise<Response> => {
		const u = new URL(req.url), base: string = `http://127.0.0.1:${server.port}`;
		if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return Response.json({ resource: base + '/mcp', authorization_servers: [base] });
		if (u.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'] });
		if (u.pathname === '/register') { o.registers++; const m = await req.json() as Record<string, unknown>; return Response.json({ ...m, client_id: 'mob-client' }, { status: 201 }); }
		if (u.pathname === '/authorize') {
			const q = u.searchParams;
			if (q.get('client_id') !== 'mob-client' || !q.get('code_challenge') || q.get('resource') !== base + '/mcp') return new Response('bad request', { status: 400 });
			o.redirects.push(q.get('redirect_uri')!);
			return Response.redirect(`${q.get('redirect_uri')}?code=the-code&state=${q.get('state')}`, 302);
		}
		if (u.pathname === '/token') {
			const f = new URLSearchParams(await req.text());
			const grant = f.get('grant_type');
			if ((grant === 'authorization_code' && (f.get('code') !== 'the-code' || !f.get('code_verifier'))) || (grant === 'refresh_token' && f.get('refresh_token') !== 'the-refresh')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
			o.issued++;
			o.token = 'token-' + 'x'.repeat(o.issued);
			return Response.json({ access_token: o.token, token_type: 'Bearer', refresh_token: 'the-refresh', expires_in: 3600 });
		}
		if (u.pathname === '/mcp') {
			if (!o.token || req.headers.get('Authorization') !== 'Bearer ' + o.token) return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
			const id = req.headers.get('mcp-session-id');
			let t = id ? transports.get(id) : undefined;
			if (!t) {
				t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: sid => { transports.set(sid, t!); } });
				await testServer().connect(t);
			}
			return t.handleRequest(req);
		}
		return new Response('not found', { status: 404 });
	} });
	return { o, url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true) };
}

test('an OAuth sign-in is kept, and can be pasted from another device', async () => {
	const { o, url, stop } = oauthServer();
	const settings = memory();
	const run = async (sign: (link: string, hub: Hub) => Promise<void>) => {
		const hub = new Hub(settings);
		hub.configure({ docs: { url, oauth: true } });
		const stopping = new AbortController();
		const serving = hub.serve(hub.configured(), stopping.signal, () => {});
		try {
			await until(() => hub.status().includes('sign in to connect: ') || hub.status() === 'docs: 3 tools', () => hub.status());
			const link = hub.status().split('sign in to connect: ')[1];
			if (link) await sign(link, hub);
			await until(() => hub.status() === 'docs: 3 tools', () => hub.status());
			expect(await approve(hub, 'mcp__docs__echo', { text: 'signed' })).toBe('echo: signed');
		} finally { stopping.abort(); await serving; }
	};
	// The browser follows the link back to Mob.
	await run(async link => { await fetch(link); });
	expect(o.registers).toBe(1);
	expect(JSON.parse(settings.values.get('mcp_oauth')!).docs.tokens.access_token).toBe(o.token);
	// A restart uses the kept token without signing in.
	let asked = false;
	await run(async () => { asked = true; });
	expect(asked).toBe(false);
	// A refused token signs in again; the address the browser reached is pasted instead.
	o.token = 'revoked';
	settings.saveSetting('mcp_oauth', { docs: { ...JSON.parse(settings.values.get('mcp_oauth')!).docs, tokens: { access_token: 'old', token_type: 'Bearer' } } });
	await run(async (link, hub) => {
		const res = await fetch(link, { redirect: 'manual' });
		const back = res.headers.get('location')!;
		expect(() => hub.finishSignIn('http://127.0.0.1:1/callback?code=x')).toThrow('no sign-in is waiting');
		expect(hub.finishSignIn(back)).toBe('docs');
		expect(() => hub.finishSignIn(back)).toThrow('already finished');
	});
	// The kept client and its redirect address are reused.
	expect(o.registers).toBe(1);
	expect(new Set(o.redirects).size).toBe(1);
	stop();
}, 30_000);

test('the catalog lists, installs and removes remote servers', async () => {
	const settings = memory();
	const page = { servers: [
		{ server: { name: 'com.example/docs', description: 'Docs', version: '2', remotes: [{ type: 'streamable-http', url: 'https://docs.example.com/mcp' }, { type: 'sse', url: 'https://docs.example.com/sse' }] } },
		{ server: { name: 'com.example/keyed', description: 'Keyed', remotes: [{ type: 'streamable-http', url: 'https://keyed.example.com/mcp', headers: [{ name: 'X-Key', isRequired: true }] }] } },
		{ server: { name: 'com.example/old', description: 'Old', remotes: [{ type: 'streamable-http', url: 'https://old.example.com/mcp' }] }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } } },
		{ server: { name: 'org.other/x', description: 'Other', remotes: [{ type: 'streamable-http', url: 'https://other.example.com/mcp' }] } },
	] };
	let asked = 0;
	const fetcher = (async (url: string) => { asked++; expect(url).toContain('search=com.example%2F'); return Response.json(page); }) as unknown as typeof fetch;
	const hub = new Hub(settings, fetcher);
	let reconnects = 0;
	hub.changed = async () => { reconnects++; };
	hub.configure({ cf: { url: 'https://mcp.cloudflare.com/mcp' } });
	hub.configureRegistry({ url: 'https://registry.example.com', namespaces: ['com.example/*'] });
	expect(hub.listings().map(l => l.name)).toEqual(['cloudflare-docs', 'cloudflare-browser', 'cloudflare-radar']);
	await until(() => hub.listings().length === 5, () => JSON.stringify(hub.listings().map(l => l.url)));
	expect(asked).toBe(1);
	const entries = hub.entries();
	expect(entries.find(e => e.name === 'com.example/keyed (keyed.example.com)')?.use).toContain('needs the X-Key header');
	const install = hub.installTool();
	const ask = async (url: string) => {
		let input: unknown;
		await install.run({ input: { url }, requestApproval: async (i: unknown) => { input = i; throw new Error('asked'); } } as unknown as ToolCall).catch(e => { if ((e as Error).message !== 'asked') throw e; });
		return input as Record<string, unknown>;
	};
	expect(ask('https://keyed.example.com/mcp')).rejects.toThrow('X-Key');
	expect(ask('https://nowhere.example.com/mcp')).rejects.toThrow('no server in the catalog');
	const request = await ask('https://docs.example.com/mcp');
	expect(request).toMatchObject({ server: 'example-docs', name: 'com.example/docs', version: '2' });
	expect(install.scope!(JSON.stringify(request))).toBe('https://docs.example.com/mcp');
	const { setTimings } = await import('../src/mcp/hub');
	setTimings({ settle: 0 });
	const result = await install.approved!({ input: JSON.stringify(request), approvalId: 'ap', conversationId: 'c', owner: true } as unknown as ApprovedCall) as { installed: string };
	expect(result.installed).toBe('example-docs');
	expect(reconnects).toBe(1);
	expect(hub.configured()['example-docs']).toEqual({ url: 'https://docs.example.com/mcp', oauth: true });
	expect(hub.listings().map(l => l.url)).not.toContain('https://docs.example.com/mcp');
	expect(hub.describe()).toContain('example-docs (installed)');
	// config.yaml taking its URL shadows the install.
	hub.configure({ mine: { url: 'https://docs.example.com/mcp' } });
	expect(hub.shadowedInstalls()).toEqual(['example-docs']);
	expect(hub.installed('example-docs')).toBe(false);
	hub.configure({});
	await hub.remove('example-docs');
	expect(hub.configured()).toEqual({});
	expect(hub.remove('example-docs')).rejects.toThrow('not an installed server');
});
