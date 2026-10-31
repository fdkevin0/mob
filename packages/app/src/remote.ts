// The relay receives only envelopes. Pairing keys never enter a request URL, header or body.
import { base64, newRelayKey, open, seal, unbase64, type Envelope, type RelayReply as Reply } from '@mob/core/relay';

export { base64, open, seal, unbase64, type Envelope };
export const newKey = newRelayKey;

export async function cloud<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/runners${path}`, { ...init, credentials: 'same-origin', cache: 'no-store' });
	if (!response.ok)
		throw new Error(response.status === 401 ? 'Sign in to the website again.' : `Runner request failed (HTTP ${response.status}).`);
	return response.json();
}

export function encryptedFetch(runner: string, rawKey: string): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const { session } = await cloud<{ session: string | null }>(`/${runner}`, { signal: request.signal });
		if (!session || !/^[a-f0-9]{64}$/.test(session)) throw new Error('Runner is offline.');
		const id = crypto.randomUUID();
		const headers: Record<string, string[]> = {};
		for (const name of ['Content-Type', 'Accept', 'Last-Event-ID']) {
			const value = request.headers.get(name);
			if (value) headers[name] = [value];
		}
		const url = new URL(request.url);
		const prefix = `/api/runners/${runner}`;
		if (url.origin !== location.origin || !url.pathname.startsWith(prefix + '/api/')) throw new Error('Invalid runner API path');
		const envelope = await seal(
			rawKey,
			runner,
			'request',
			{ v: 1, session, id, seq: 0, final: true },
			{
				method: request.method,
				path: url.pathname.slice(prefix.length) + url.search,
				headers,
				body: await request.text(),
				expires: Date.now() + 45_000,
			},
		);
		const response = await fetch(`/api/runners/${runner}/relay`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(envelope),
			credentials: 'same-origin',
			signal: request.signal,
		});
		if (!response.ok || !response.body)
			throw new Error(`Encrypted relay unavailable (HTTP ${response.status}). Check saved history before repeating an action.`);
		const reader = response.body.getReader();
		let buffer = '',
			sequence = 0,
			finished = false;
		const decoder = new TextDecoder();
		async function next(): Promise<{ reply: Reply; final: boolean }> {
			while (!buffer.includes('\n')) {
				const { done, value } = await reader.read();
				if (done) throw new Error('Encrypted response is incomplete. Check saved history before repeating an action.');
				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > 3 * 1024 * 1024) throw new Error('Encrypted frame too large');
			}
			const end = buffer.indexOf('\n');
			const e: Envelope = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (e.id !== id || e.session !== session || e.seq !== sequence) throw new Error('Encrypted response was reordered or replayed');
			const reply = await open<Reply>(rawKey, runner, 'response', e);
			if (!reply || typeof reply.body !== 'string') throw new Error('Invalid encrypted response');
			sequence++;
			// The runner authenticates a failed local response as failed, never as complete.
			if (reply.error) throw new Error(`Runner response failed (${reply.error}). Check saved history before repeating an action.`);
			return { reply, final: e.final };
		}
		try {
			const first = await next();
			const status = first.reply.status;
			if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('Invalid encrypted HTTP status');
			const responseHeaders = new Headers();
			for (const name of ['Content-Type', 'X-Vercel-Ai-Ui-Message-Stream']) {
				const entry = Object.entries(first.reply.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
				if (entry) for (const value of entry[1]) responseHeaders.append(name, value);
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					if (first.reply.body) controller.enqueue(unbase64(first.reply.body));
					if (first.final) {
						finished = true;
						controller.close();
						void reader.cancel();
					}
				},
				async pull(controller) {
					if (finished) return;
					try {
						const { reply, final } = await next();
						if (reply.body) controller.enqueue(unbase64(reply.body));
						if (final) {
							finished = true;
							controller.close();
							await reader.cancel();
						}
					} catch (error) {
						finished = true;
						controller.error(error);
						await reader.cancel();
					}
				},
				cancel: () => reader.cancel(),
			});
			// Null-body statuses must still receive an authenticated completion.
			if ([204, 205, 304].includes(status)) {
				const drain = body.getReader();
				while (!(await drain.read()).done) {
					/* verify completion */
				}
				return new Response(null, { status, headers: responseHeaders });
			}
			return new Response(body, { status, headers: responseHeaders });
		} catch (error) {
			await reader.cancel();
			throw error;
		}
	};
}
