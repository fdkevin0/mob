// Sending model requests: stall detection, retries before a response begins,
// and recognising a prompt longer than the model's window.

import { sleep } from '../sleep';
export const limits = {
	// How long a model request may wait for its response to start, and then for
	// each further piece of it. A reply that keeps arriving is never cut off.
	stallTimeout: 2 * 60_000,
	// How many times send repeats a request that failed before its response
	// began, for reasons that may pass; retryDelay is the first wait, doubled
	// each time unless the server says how long to wait, up to maxRetryDelay.
	retries: 3,
	retryDelay: 1000,
	maxRetryDelay: 60_000,
};

/** StalledError ends a model request that stopped responding. */
export class StalledError extends Error {
	constructor() { super('model stopped responding'); }
}

/** OverflowError is a provider refusing a prompt longer than the model's context window. */
export class OverflowError extends Error {
	readonly overflow = true;
}
export const isOverflow = (e: unknown) => e instanceof OverflowError;

// overflow phrases are how providers word a prompt too long for the window.
const phrases = ['context_length_exceeded', 'context length', 'context window', 'maximum context', 'prompt is too long', 'input is too long', 'too many tokens', 'too many input tokens', 'reduce the length'];

/** overflow reports whether a refusal with status and body is for a prompt longer than the model's window. */
export function overflow(status: number, body: string) {
	if (status === 413) return true;
	if (status !== 400 && status !== 422) return false;
	const text = body.toLowerCase();
	return phrases.some(p => text.includes(p));
}

// retryable are the statuses a later attempt may not see; 529 is Anthropic's overloaded.
const retryable = [408, 429, 500, 502, 503, 504, 529];

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** after is how long a Retry-After header asks to wait, in seconds or until a date, or delay without one. */
export function after(header: string | null, delay: number) {
	const value = (header ?? '').trim();
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const at = Date.parse(value);
	return Number.isNaN(at) ? delay : Math.max(at - Date.now(), 0);
}

// send sends a model request without following redirects. It fails with
// StalledError if the response does not start, or stops arriving, within
// stallTimeout. A request that failed before its response began is sent again
// up to retries times, never once a response is streaming, so a retry cannot
// repeat text the caller has already shown.
export async function send(fetcher: Fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	let delay = limits.retryDelay;
	for (let attempt = 0; ; attempt++) {
		let response: Response | undefined, error: unknown, wait = delay, again = false;
		try {
			response = await sendOnce(fetcher, url, init, signal);
			if (retryable.includes(response.status)) {
				const raw = (await response.text()).slice(0, 64 << 10);
				const headers = response.headers;
				response = new Response(raw, { status: response.status, statusText: response.statusText, headers });
				// An exhausted quota stays exhausted.
				again = !(response.status === 429 && raw.includes('insufficient_quota'));
				wait = Math.min(after(headers.get('retry-after'), delay), limits.maxRetryDelay);
			}
		} catch (e) {
			error = e;
			// A stalled request already waited stallTimeout; a cancelled one was meant.
			again = !(e instanceof StalledError) && !signal?.aborted;
		}
		if (!again || attempt >= limits.retries || signal?.aborted) {
			if (error !== undefined) throw error;
			return response!;
		}
		await sleep(wait, signal);
		delay = Math.min(delay * 2, limits.maxRetryDelay);
	}
}

async function sendOnce(fetcher: Fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	let stalled = false;
	const abort = () => controller.abort(signal?.reason);
	signal?.addEventListener('abort', abort, { once: true });
	let timer = setTimeout(() => { stalled = true; controller.abort(new StalledError()); }, limits.stallTimeout);
	const reset = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; controller.abort(new StalledError()); }, limits.stallTimeout); };
	const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
	let response: Response;
	try {
		response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
	} catch (e) {
		done();
		if (stalled) throw new StalledError();
		throw e;
	}
	reset();
	if (!response.body) { done(); return response; }
	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(stream) {
			try {
				const { value, done: end } = await reader.read();
				if (end) { done(); stream.close(); return; }
				reset();
				stream.enqueue(value);
			} catch (e) {
				done();
				stream.error(stalled ? new StalledError() : e);
			}
		},
		cancel(reason) { done(); controller.abort(reason); return reader.cancel(reason); },
	});
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * statusError reads a vendor's short error message, so "model not found" or
 * "invalid key" reaches the user instead of a bare status code. Vendors may
 * echo the credential, so every secret sent with the request is masked first.
 */
export async function statusError(response: Response, secrets: string[]): Promise<Error> {
	const raw = (await response.text().catch(() => '')).slice(0, 8192);
	let message = '';
	try {
		const body = JSON.parse(raw) as { error?: unknown };
		if (typeof body.error === 'string') message = body.error;
		else if (body.error && typeof body.error === 'object' && typeof (body.error as { message?: unknown }).message === 'string') message = (body.error as { message: string }).message;
	} catch { /* not JSON */ }
	for (const secret of secrets) {
		if (!secret) continue;
		// Masking every occurrence of a short value would leave nothing
		// readable, and the value could still be recovered; drop it all.
		if (secret.length < 4) message = '';
		else message = message.split(secret).join('••••');
	}
	message = message.trim().replace(/[\x00-\x1f\x7f]/g, ' ');
	const chars = [...message];
	if (chars.length > 200) message = chars.slice(0, 200).join('') + '…';
	const text = message ? `model returned HTTP ${response.status}: ${message}` : `model returned HTTP ${response.status}`;
	return overflow(response.status, raw) ? new OverflowError(text) : new Error(text);
}

/** secrets are the credentials a request carries: its key and header values. */
export const secrets = (key: string, headers: Record<string, string> = {}) => [key, ...Object.values(headers)];
