import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { deployed, pair } from '../src/runner';
import { connect, key, localHandler, open, seal, serve, type Credentials, type Envelope, type Handler } from '../src/runner/relay';

const rawKey = Buffer.alloc(32, 7).toString('base64');
const id = '00000000-0000-4000-8000-000000000001';
const token = 'r'.repeat(72);
const credentials = (url: string): Credentials => ({ url, id, token, key: rawKey });

type Reply = { status: number; headers?: Record<string, string[]>; body: string; error?: string };

/** Relay is a fake relay: it accepts one runner and lets a test send requests through it as the browser would. */
class Relay {
	server: ReturnType<typeof Bun.serve>;
	socket?: ServerWebSocket<unknown>;
	session = '';
	auth = '';
	frames = new Map<string, Envelope[]>();
	private waiters: (() => void)[] = [];
	private hello?: () => void;
	ready = new Promise<void>(r => { this.hello = r; });

	constructor() {
		this.server = Bun.serve({
			port: 0, hostname: '127.0.0.1',
			fetch: (req, server) => { this.auth = req.headers.get('Authorization') ?? ''; return server.upgrade(req, { data: undefined }) ? undefined : new Response('no', { status: 400 }); },
			websocket: {
				open: ws => { this.socket = ws; },
				message: (_ws, text) => {
					const m = JSON.parse(String(text));
					if (m.type === 'hello') { this.session = m.session; this.hello?.(); return; }
					if (!m.v) return;
					this.frames.set(m.id, [...(this.frames.get(m.id) ?? []), m]);
					for (const w of this.waiters.splice(0)) w();
				},
			},
		});
	}
	get url() { return `http://127.0.0.1:${this.server.port}`; }

	async request(rid: string, req: { method?: string; path: string; body?: string; expires?: number; headers?: Record<string, string[]> }, k: CryptoKey) {
		const e = await seal(k, id, 'request', { v: 1, session: this.session, id: rid, seq: 0, final: true }, { method: req.method ?? 'GET', path: req.path, headers: req.headers ?? null, body: req.body ?? '', expires: req.expires ?? Date.now() + 30_000 });
		this.socket!.send(JSON.stringify(e));
		return e;
	}

	/** answer waits for a request's final frame and opens every frame of it. */
	async answer(rid: string, k: CryptoKey, ms = 5000) {
		const deadline = Date.now() + ms;
		while (!this.frames.get(rid)?.some(f => f.final)) {
			if (Date.now() > deadline) throw new Error('no answer for ' + rid);
			await new Promise<void>(r => { this.waiters.push(r); setTimeout(r, 50); });
		}
		const replies = await Promise.all(this.frames.get(rid)!.map(f => open<Reply>(k, id, 'response', f)));
		return { status: replies[0]!.status, headers: replies[0]!.headers, body: replies.map(r => Buffer.from(r.body, 'base64').toString()).join(''), error: replies.at(-1)!.error };
	}
	stop() { this.server.stop(true); }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

async function harness(handler: Handler) {
	const relay = new Relay();
	const k = await key(rawKey);
	const abort = new AbortController();
	const ended = connect(relay.url, credentials(relay.url), k, handler, () => {}, abort.signal);
	await relay.ready;
	cleanups.push(() => { abort.abort(); relay.stop(); });
	return { relay, k, abort, ended };
}

const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('runner', () => {
	test('encryption authenticates routing and content', async () => {
		const k = await key(rawKey);
		const e = await seal(k, id, 'request', { v: 1, session: 's', id: rid(1), seq: 0, final: true }, { hello: 'world' });
		expect(await open<{ hello: string }>(k, id, 'request', e)).toEqual({ hello: 'world' });
		for (const tampered of [{ ...e, id: rid(2) }, { ...e, seq: 1 }, { ...e, final: false }, { ...e, session: 't' }, { ...e, data: Buffer.from('x' + Buffer.from(e.data, 'base64').toString('latin1'), 'latin1').toString('base64') }]) {
			await expect(open(k, id, 'request', tampered)).rejects.toThrow('authentication failed');
		}
		await expect(open(k, 'other', 'request', e)).rejects.toThrow();
		await expect(open(k, id, 'response', e)).rejects.toThrow();
		await expect(key(Buffer.alloc(16).toString('base64'))).rejects.toThrow();
	});

	test('streams an encrypted answer and never answers a replay or an expired request', async () => {
		let calls = 0;
		const { relay, k } = await harness(async req => {
			calls++;
			expect(req.headers.get('Authorization')).toBeNull();
			return new Response(`${req.method} ${new URL(req.url).pathname} ${req.method === 'POST' ? await req.text() : ''}`, { headers: { 'Content-Type': 'text/plain', 'Set-Cookie': 'no=1' } });
		});
		expect(relay.auth).toBe('Bearer ' + token);
		const e = await relay.request(rid(1), { method: 'POST', path: '/api/chat', body: 'hi', headers: { 'Content-Type': ['application/json'], Cookie: ['x'] } }, k);
		const a = await relay.answer(rid(1), k);
		expect(a).toMatchObject({ status: 200, body: 'POST /api/chat hi' });
		expect(a.headers).toEqual({ 'Content-Type': ['text/plain'] });
		relay.socket!.send(JSON.stringify(e));
		await relay.request(rid(2), { path: '/api/x', expires: Date.now() - 1 }, k);
		expect((await relay.answer(rid(2), k)).status).toBe(408);
		await Bun.sleep(100);
		expect(relay.frames.get(rid(1))!.filter(f => f.final).length).toBe(1);
		expect(calls).toBe(1);
	});

	test('rejects local authority and paths outside the API', async () => {
		const handler: Handler = async () => new Response('ran');
		const signal = new AbortController().signal;
		const status = async (method: string, path: string) => (await serve(handler, { method, path, body: '', expires: 0 }, signal)).status;
		expect(await status('GET', '/api/conversations')).toBe(200);
		expect(await status('GET', '/api/pairing')).toBe(403);
		expect(await status('POST', '/api/token/rotate')).toBe(403);
		expect(await status('POST', '/api/runtime/shutdown')).toBe(403);
		expect(await status('GET', '/api/runtime')).toBe(200);
		for (const path of ['/', '/index.html', '//evil.test/api/x', 'http://evil.test/api/x', '/api/../token', '/api/%2e%2e/token', '/api/a\\b']) expect(await status('GET', path)).toBe(400);
		expect(await status('DELETE', '/api/x')).toBe(400);
	});

	test('the local token never leaves the runner', async () => {
		const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new Response(req.headers.get('Authorization'), { headers: { 'Content-Type': 'text/plain', Authorization: 'leak', 'Set-Cookie': 'a=b' } }) });
		cleanups.push(() => local.stop(true));
		const { relay, k } = await harness(localHandler(`http://127.0.0.1:${local.port}`, 'local-secret'));
		await relay.request(rid(1), { path: '/api/x' }, k);
		const a = await relay.answer(rid(1), k);
		// The local service saw the token; the answer carries only allowed headers.
		expect(a.body).toBe('Bearer local-secret');
		expect(a.headers).toEqual({ 'Content-Type': ['text/plain'] });
		for (const f of relay.frames.get(rid(1))!) expect(JSON.stringify(f)).not.toContain('local-secret');
	});

	test('a disconnect cancels running requests', async () => {
		let aborted = false;
		const { relay, k, ended } = await harness(req => new Promise(() => { req.signal.addEventListener('abort', () => { aborted = true; }); }));
		await relay.request(rid(1), { path: '/api/slow' }, k);
		await Bun.sleep(100);
		relay.socket!.close();
		expect((await ended).message).toBeTruthy();
		await Bun.sleep(50);
		expect(aborted).toBe(true);
	});

	test('a cancel ends only that request', async () => {
		const aborted: string[] = [];
		const { relay, k } = await harness(req => {
			const path = new URL(req.url).pathname;
			if (path === '/api/quick') return Promise.resolve(new Response('quick'));
			return new Promise(() => { req.signal.addEventListener('abort', () => aborted.push(path)); });
		});
		await relay.request(rid(1), { path: '/api/a' }, k);
		await relay.request(rid(2), { path: '/api/b' }, k);
		await Bun.sleep(100);
		relay.socket!.send(JSON.stringify({ type: 'cancel', id: rid(1) }));
		await Bun.sleep(100);
		expect(aborted).toEqual(['/api/a']);
		await relay.request(rid(3), { path: '/api/quick' }, k);
		expect((await relay.answer(rid(3), k)).body).toBe('quick');
	});

	test('a truncated local response fails only that request', async () => {
		const { relay, k } = await harness(async req => {
			if (new URL(req.url).pathname === '/api/ok') return new Response('fine');
			let n = 0;
			return new Response(new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new TextEncoder().encode('partial')); else c.error(new Error('broken')); } }));
		});
		await relay.request(rid(1), { path: '/api/broken' }, k);
		const broken = await relay.answer(rid(1), k);
		expect(broken.body).toBe('partial');
		expect(broken.error).toBeTruthy();
		await relay.request(rid(2), { path: '/api/ok' }, k);
		expect(await relay.answer(rid(2), k)).toMatchObject({ body: 'fine', error: undefined });
	});

	test('pairing sends only the one-time code and keeps the key local', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'mob-runner-'));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		let sent = '';
		const cloud = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => { sent = await req.text(); return Response.json({ id, token, key: 'cloud-key', url: 'https://evil.test' }); } });
		cleanups.push(() => cloud.stop(true));
		const url = `http://127.0.0.1:${cloud.port}`;
		const code = 'c'.repeat(72);
		await pair(dir, JSON.stringify({ url, id, code, key: rawKey }));
		expect(JSON.parse(sent)).toEqual({ code });
		expect(JSON.parse(readFileSync(join(dir, 'runner.json'), 'utf8'))).toEqual({ url, id, token, key: rawKey });
		await expect(pair(dir, JSON.stringify({ url, id: rid(9), code, key: rawKey }))).rejects.toThrow('does not match');
		await expect(pair(dir, JSON.stringify({ url: 'http://evil.test', id, code, key: rawKey }))).rejects.toThrow('HTTPS');
		await expect(pair(dir, 'nope')).rejects.toThrow('invalid pairing JSON');
	});

	test('reads deployed credentials from the environment', () => {
		expect(deployed(JSON.stringify({ url: 'https://usemob.app/', id, token, key: rawKey }))).toEqual({ url: 'https://usemob.app', id, token, key: rawKey });
		expect(() => deployed(JSON.stringify({ url: 'https://usemob.app', id, token: 'short', key: rawKey }))).toThrow('invalid runner credentials');
		expect(() => deployed('{')).toThrow('invalid pairing JSON');
		expect(() => deployed(JSON.stringify({ url: 'https://usemob.app/path', id, token, key: rawKey }))).toThrow('origin');
	});
});
