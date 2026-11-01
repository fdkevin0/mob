// The runner connects a local Mob service to the account-scoped encrypted
// relay. The relay sees only envelopes: requests from the owner's browser are
// opened here and answered by the local service, and the answers are sealed
// with the pairing key, which never leaves this machine and the browser.

import { open, relayKey, seal, base64, type Envelope, type RelayReply as Reply, type RelayRequest } from '@mob/core/relay';
import { sleep } from '@mob/core/sleep';
import { secureURL } from '@mob/core/url';
export type Credentials = { url: string; id: string; token: string; key: string };

/** Request is what the browser asks the local service, as it sealed it. */
export type Request = RelayRequest;

/** Handler answers a request the runner checked. */
export type Handler = (req: globalThis.Request) => Promise<Response>;

/** origin permits TLS in production and loopback HTTP for local development. */
export function origin(raw: string) {
	let u: URL;
	try { u = new URL(raw); } catch { throw new Error('runner URL must be an HTTPS origin'); }
	if (!u.host || u.username || u.password || u.search || raw.includes('?') || u.hash || raw.includes('#') || (u.pathname !== '/' && u.pathname !== '')) throw new Error('runner URL must be an HTTPS origin');
	if (!secureURL(u)) throw new Error('runner URL requires HTTPS except on loopback');
	return u.protocol + '//' + u.host;
}

/** failure is the runner's own answer, as plain text. */
const failure = (status: number, message: string) => new Response(message + '\n', { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });

/** header looks a header up in a request as the browser sealed it. */
const header = (headers: Record<string, string[]> | null | undefined, name: string) =>
	Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() === name.toLowerCase()).flatMap(([, v]) => v);

/** serve checks req and answers it with handler: only the local API, and never what only the owner at this computer may do. */
export async function serve(handler: Handler, req: Request, signal: AbortSignal): Promise<Response> {
	const path = req.path;
	let pathname = '';
	try {
		if (!path.startsWith('/') || path.startsWith('//')) throw new Error();
		pathname = decodeURIComponent(new URL(path, 'http://runner').pathname);
		if (new URL(path, 'http://runner').host !== 'runner') throw new Error();
	} catch { return failure(400, 'invalid runner request'); }
	if (!pathname.startsWith('/api/') || path.includes('..') || pathname.includes('..') || pathname.includes('\\') || path.includes('\\') || (req.body ?? '').length > 1 << 20 || (req.method !== 'GET' && req.method !== 'POST')) return failure(400, 'invalid runner request');
	// Remote peers cannot mint local access tokens or shut down the service.
	for (const local of ['/api/pairing', '/api/token']) if (pathname === local || pathname.startsWith(local + '/')) return failure(403, 'local-only endpoint');
	if (pathname.startsWith('/api/runtime') && req.method !== 'GET') return failure(403, 'local-only endpoint');
	const headers = new Headers();
	for (const name of ['Content-Type', 'Accept', 'Last-Event-ID']) for (const v of header(req.headers, name)) headers.append(name, v);
	return handler(new globalThis.Request('http://runner' + path, { method: req.method, headers, body: req.method === 'POST' ? req.body : undefined, signal }));
}

/** localHandler forwards only to the local service and adds its token here. */
export function localHandler(origin: string, token: string): Handler {
	return async req => {
		const u = new URL(req.url);
		const headers = new Headers(req.headers);
		headers.set('Authorization', 'Bearer ' + token);
		let res: Response;
		try {
			res = await fetch(origin + u.pathname + u.search, { method: req.method, headers, body: req.method === 'POST' ? await req.text() : undefined, redirect: 'manual', signal: req.signal });
		} catch { return failure(502, 'local Mob unavailable'); }
		const out = new Headers();
		for (const name of ['Content-Type', 'X-Vercel-Ai-Ui-Message-Stream']) { const v = res.headers.get(name); if (v !== null) out.set(name, v); }
		return new Response(res.body, { status: res.status, headers: out });
	};
}

/** requestIdle ends a request that produces nothing for six minutes, like the relay's idle limit, even if a browser disappears without a cancellation reaching the runner. */
const requestIdle = 6 * 60_000;
/** chunk bounds the body each frame carries. */
const chunk = 16 << 10;
/** slots is how many requests run at once: more than the relay's 32 pending requests, to absorb the moment between the relay forgetting a request and its handler here returning. */
const slots = 64;
const maxPayload = 2 << 20;
const readWait = 90_000;
const pingEvery = 30_000;
/** canonical are the response headers the browser reads, spelled as it looks them up. */
const canonical = ['Content-Type', 'X-Content-Type-Options', 'X-Vercel-Ai-Ui-Message-Stream'];

/** Answer seals a response into frames, the first with its status and headers. */
class Answer {
	private seq = 0;
	private sent = false;
	failure = '';
	constructor(private k: CryptoKey, private runner: string, private e: Envelope, private send: (v: unknown) => void, private touched: () => void) {}

	async emit(status: number, headers: Record<string, string[]> | undefined, body: string, final: boolean) {
		const out: Reply = { status: 0, body };
		if (!this.sent) { out.status = status; out.headers = headers; }
		if (final && this.failure) out.error = this.failure;
		const sealed = await seal(this.k, this.runner, 'response', { v: this.e.v, session: this.e.session, id: this.e.id, seq: this.seq++, final }, out);
		this.send(sealed);
		this.sent = true;
		this.touched();
	}

	/** stream answers with res: its status and headers at once, then its body, then the final frame. */
	async stream(res: Response) {
		const headers: Record<string, string[]> = {};
		for (const name of canonical) { const v = res.headers.get(name); if (v !== null) headers[name] = [v]; }
		await this.emit(res.status, headers, '', false);
		if (res.body) {
			try {
				// Bodies are bytes, not necessarily UTF-8; base64 keeps split multibyte characters whole.
				for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
					for (let i = 0; i < part.length; i += chunk) await this.emit(res.status, headers, base64(part.subarray(i, i + chunk)), false);
				}
			} catch (e) {
				// Never authenticate a truncated local response as a successful completion.
				this.failure ||= (e as Error).message || 'local response ended early';
			}
		}
		await this.emit(res.status, headers, '', true);
	}
}

/**
 * connect serves the relay's requests over one connection until it ends,
 * and returns why it ended. Requests it started end with it.
 */
export async function connect(base: string, credentials: Credentials, k: CryptoKey, handler: Handler, status: (line: string) => void, signal?: AbortSignal): Promise<Error> {
	const url = 'ws' + base.slice('http'.length) + '/api/runners/' + encodeURIComponent(credentials.id) + '/connect';
	const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + credentials.token, Origin: base } } as unknown as string[]);
	const opened = await new Promise<boolean>(resolve => {
		const timer = setTimeout(() => { ws.close(); resolve(false); }, 15_000);
		ws.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
		ws.addEventListener('close', () => { clearTimeout(timer); resolve(false); }, { once: true });
		ws.addEventListener('error', () => {}, { once: true });
	});
	if (!opened) return new Error('relay connection failed; check network and pairing');
	let ended!: (e: Error) => void;
	const done = new Promise<Error>(r => { ended = r; });
	const active = new Map<string, AbortController>();
	const close = (why: Error) => {
		ended(why);
		try { ws.close(); } catch { /* closed */ }
	};
	ws.addEventListener('close', e => close(new Error(e.reason || `connection closed (${e.code})`)));
	const stop = () => close(new Error('stopped'));
	signal?.addEventListener('abort', stop, { once: true });
	const send = (v: unknown) => {
		if (ws.readyState !== WebSocket.OPEN) throw new Error('connection closed');
		ws.send(JSON.stringify(v));
	};
	const session = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
	send({ type: 'hello', session });
	status('Runner connected; end-to-end encryption enabled');
	const ping = setInterval(() => { try { send({ type: 'ping' }); } catch { close(new Error('ping failed')); } }, pingEvery);
	let quiet = setTimeout(() => close(new Error('relay went quiet')), readWait);
	const seen = new Map<string, number>();
	let running = 0;

	/** answer runs one checked request and seals its answer; a failed send means the socket itself is broken. */
	const answer = async (e: Envelope, run: (a: Answer, abort: AbortSignal) => Promise<void>) => {
		const controller = new AbortController();
		active.set(e.id, controller);
		let idle = setTimeout(() => controller.abort(), requestIdle);
		const a = new Answer(k, credentials.id, e, send, () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), requestIdle); });
		try { await run(a, controller.signal); } catch { close(new Error('send failed')); } finally {
			clearTimeout(idle);
			active.delete(e.id);
			controller.abort();
		}
	};
	// A request that is authenticated but not run gets its own sealed error, so one bad request never takes down the others sharing this connection.
	const reject = (e: Envelope, code: number, message: string) => answer(e, a => a.stream(failure(code, message)));

	ws.addEventListener('message', async ev => {
		clearTimeout(quiet);
		quiet = setTimeout(() => close(new Error('relay went quiet')), readWait);
		const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString();
		if (text.length > maxPayload) return close(new Error('frame too large'));
		let raw: Record<string, unknown>;
		try { raw = JSON.parse(text); } catch { return close(new Error('invalid frame')); }
		if (!raw.v) {
			// Heartbeat replies, and cancellations for requests whose browser left.
			if (raw.type === 'cancel' && typeof raw.id === 'string') active.get(raw.id)?.abort();
			return;
		}
		const e = raw as unknown as Envelope;
		// Frames that do not authenticate cannot be answered; drop them.
		if (e.session !== session || e.seq !== 0 || e.final !== true || typeof e.id !== 'string' || e.id.length !== 36) return;
		let req: Request;
		try { req = await open<Request>(k, credentials.id, 'request', e); } catch { return; }
		const now = Date.now();
		for (const [id, expires] of seen) if (expires < now) seen.delete(id);
		// Never answer a replay: the original's response is the only one.
		if (seen.has(e.id)) return;
		if (!(req.expires >= now && req.expires <= now + 60_000)) return void reject(e, 408, 'request expired before it ran; check the browser clock');
		if (seen.size >= 10_000) return close(new Error('request rate limit'));
		// Recorded before any answer, so a request refused as busy cannot run later.
		seen.set(e.id, req.expires);
		if (running >= slots) return void reject(e, 503, 'runner busy; the request did not run');
		running++;
		void answer(e, async (a, abort) => a.stream(await serve(handler, req, abort).catch(() => failure(502, 'local Mob unavailable')))).finally(() => { running--; });
	});

	const why = await done;
	clearInterval(ping);
	clearTimeout(quiet);
	signal?.removeEventListener('abort', stop);
	for (const c of active.values()) c.abort();
	return why;
}

/** run reconnects until signal aborts. The handler stays local; only sealed envelopes leave it. */
export async function run(credentials: Credentials, handler: Handler, status: (line: string) => void, signal: AbortSignal) {
	const base = origin(credentials.url);
	const k = await relayKey(credentials.key);
	while (!signal.aborted) {
		const err = await connect(base, credentials, k, handler, status, signal);
		if (signal.aborted) return;
		status(`Runner disconnected (${err.message}); reconnecting`);
		await sleep(2000, signal).catch(() => {});
	}
}
