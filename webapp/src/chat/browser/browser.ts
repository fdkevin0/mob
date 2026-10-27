// The page side of the browser runner: one worker per tab, reached as a fetch;
// the workers of all tabs share one database (see runner.worker.ts).
// The client sees an ordinary Mob service at browserURL.
import type { Connection } from '../api';
import { promptChrome } from './chrome';
import type { FromWorker, ToWorker } from './protocol';

type Pending = { head: (r: Response) => void; fail: (e: Error) => void; stream?: ReadableStreamDefaultController<Uint8Array> };

let started: { worker: Worker; ready: Promise<{ persistent: boolean }>; pending: Map<number, Pending> } | undefined;
let next = 0;
// busy is set while this tab's runner leads and runs a turn: closing or reloading the tab asks first.
let busy = false;
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

function start(token: string) {
	const worker = new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module', name: 'mob-runner' });
	const pending = new Map<number, Pending>();
	const prompts = new Map<number, AbortController>();
	const ready = new Promise<{ persistent: boolean }>((resolve, reject) => {
		worker.addEventListener('error', e => reject(new Error(e.message || 'The browser runner could not start.')), { once: true });
		worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
			const m = event.data;
			if (m.type === 'ready') { resolve({ persistent: m.persistent }); return; }
			if (m.type === 'failed') { reject(new Error(m.error)); return; }
			if (m.type === 'busy') { busy = m.busy; return; }
			if (m.type === 'chrome') {
				const abort = new AbortController();
				prompts.set(m.id, abort);
				promptChrome(m.messages, abort.signal, text => post({ type: 'chrome-text', id: m.id, text }))
					.then(() => post({ type: 'chrome-end', id: m.id }), e => post({ type: 'chrome-error', id: m.id, error: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : undefined }))
					.finally(() => prompts.delete(m.id));
				return;
			}
			if (m.type === 'chrome-abort') { prompts.get(m.id)?.abort(); return; }
			const p = pending.get(m.id);
			if (!p) return;
			switch (m.type) {
				case 'head':
					p.head(new Response(m.status === 204 || m.status === 304 ? null : new ReadableStream<Uint8Array>({
						start: c => { p.stream = c; },
						cancel: () => { pending.delete(m.id); post({ type: 'abort', id: m.id }); },
					}), { status: m.status, headers: m.headers }));
					if (m.status === 204 || m.status === 304) pending.delete(m.id);
					return;
				case 'chunk': p.stream?.enqueue(m.chunk); return;
				case 'end': pending.delete(m.id); p.stream?.close(); return;
				case 'error': pending.delete(m.id); p.fail(new Error(m.error)); p.stream?.error(new Error(m.error)); return;
			}
		});
	});
	const post = (m: ToWorker) => worker.postMessage(m, m.type === 'request' && m.body ? [m.body] : []);
	post({ type: 'init', token });
	// Storage the browser may clear under pressure would lose conversations without warning.
	void navigator.storage?.persist?.().catch(() => false);
	return { worker, ready, pending };
}

/** startBrowser starts this tab's runner, once, and resolves when it serves; after a failure, the next call tries again. */
export function startBrowser(connection: Connection) {
	if (!started) {
		const run = start(connection.token);
		started = run;
		run.ready.catch(() => {
			run.worker.terminate();
			if (started === run) started = undefined;
		});
	}
	return started.ready;
}

/** browserFetch serves fetch calls from the runner in this tab. */
export const browserFetch: typeof fetch = async (input, init) => {
	const request = new Request(input, init);
	const { worker, ready, pending } = started ?? (() => { throw new Error('The browser runner has not started.'); })();
	await ready;
	request.signal.throwIfAborted();
	const id = ++next;
	const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
	return new Promise<Response>((resolve, reject) => {
		const abort = () => {
			const p = pending.get(id);
			pending.delete(id);
			worker.postMessage({ type: 'abort', id } satisfies ToWorker);
			const reason = request.signal.reason instanceof Error ? request.signal.reason : new DOMException('The request was aborted.', 'AbortError');
			p?.fail(reason);
			try { p?.stream?.error(reason); } catch { /* already closed */ }
		};
		pending.set(id, { head: resolve, fail: reject });
		request.signal.addEventListener('abort', abort, { once: true });
		const message: ToWorker = { type: 'request', id, url: request.url, method: request.method, headers: [...request.headers], body };
		worker.postMessage(message, body ? [body] : []);
	});
};
