// HTTP helpers for handlers written against the Fetch API, so the same
// server runs in Bun, in a service worker or behind any other host.
import { CommandError } from '../chat/conversation';
import { NotFound } from '../chat/sql';
import { Conflict, StaleApproval } from '../chat/store';

export const json = (status: number, data: unknown) => new Response(JSON.stringify(data) + '\n', { status, headers: { 'Content-Type': 'application/json' } });
export const text = (status: number, message: string) => new Response(message + '\n', { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/** failure maps an error to the status that says why. */
export function failure(err: unknown, fallback = 500): Response {
	if (err instanceof CommandError) return text(err.status, err.message);
	if (err instanceof StaleApproval || err instanceof Conflict) return text(409, err.message);
	if (err instanceof NotFound) return text(404, 'conversation not found');
	if (err instanceof HTTPError) return text(err.status, err.message);
	if (fallback === 500) {
		console.error('request failed:', err);
		return text(500, 'database operation failed');
	}
	return text(fallback, err instanceof Error ? err.message : String(err));
}

export class HTTPError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

/** body reads one JSON object of at most limit bytes, refusing fields not in keys when keys is given. */
export async function body<T>(req: Request, limit = 256 << 10, keys?: string[]): Promise<T> {
	const raw = await req.arrayBuffer().catch(() => { throw new HTTPError(400, 'invalid request'); });
	if (raw.byteLength > limit) throw new HTTPError(413, 'request body too large');
	let value: unknown;
	try { value = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new HTTPError(400, 'invalid request'); }
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HTTPError(400, 'invalid request');
	if (keys && Object.keys(value).some(k => !keys.includes(k))) throw new HTTPError(400, 'invalid request');
	return value as T;
}

/** sse is a server-sent event stream that write feeds until it returns or the client leaves. */
export function sse(headers: Record<string, string>, write: (send: (chunk: string) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Response {
	const encoder = new TextEncoder();
	const controller = new AbortController();
	const end = () => controller.abort();
	signal.addEventListener('abort', end, { once: true });
	const stream = new ReadableStream<Uint8Array>({
		async start(c) {
			const send = (chunk: string) => { if (!controller.signal.aborted) c.enqueue(encoder.encode(chunk)); };
			try { await write(send, controller.signal); } catch { /* the client left or the stream ended */ }
			signal.removeEventListener('abort', end);
			try { c.close(); } catch { /* already closed */ }
		},
		cancel() { controller.abort(); },
	});
	return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', ...headers } });
}

type Handler = (req: Request, params: Record<string, string>, url: URL) => Response | Promise<Response>;

/** Router matches "METHOD /path/{param}" patterns, as Go's ServeMux does. */
export class Router {
	private routes: { method: string; parts: string[]; handler: Handler }[] = [];

	handle(pattern: string, handler: Handler) {
		const [method, path] = pattern.split(' ');
		this.routes.push({ method, parts: path.split('/'), handler });
	}

	match(req: Request, url: URL): Response | Promise<Response> | undefined {
		const parts = url.pathname.split('/');
		let allowed = false;
		for (const r of this.routes) {
			if (r.parts.length !== parts.length) continue;
			const params: Record<string, string> = {};
			const ok = r.parts.every((p, i) => {
				if (p.startsWith('{') && p.endsWith('}')) { if (!parts[i]) return false; params[p.slice(1, -1)] = decodeURIComponent(parts[i]); return true; }
				return p === parts[i];
			});
			if (!ok) continue;
			if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) { allowed = true; continue; }
			return r.handler(req, params, url);
		}
		return allowed ? text(405, 'method not allowed') : undefined;
	}
}
