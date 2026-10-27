import { afterEach, expect, it, vi } from 'vitest';
import { base64, encryptedFetch, newKey, open, seal, type Envelope } from './remote';

const runner = '11111111-1111-4111-8111-111111111111';
const session = 'a'.repeat(64);
afterEach(() => vi.unstubAllGlobals());

it('authenticates content, routing, direction and completion', async () => {
	const key = newKey();
	const envelope = await seal(key, runner, 'request', { v: 1, session, id: runner, seq: 0, final: true }, { text: 'private prompt' });
	expect(JSON.stringify(envelope)).not.toContain('private prompt');
	expect(await open(key, runner, 'request', envelope)).toEqual({ text: 'private prompt' });
	for (const patch of [{ id: 'other' }, { session: 'other' }, { seq: 1 }, { final: false }, { data: 'AAAA' }]) {
		await expect(open(key, runner, 'request', { ...envelope, ...patch })).rejects.toThrow();
	}
	await expect(open(key, runner, 'response', envelope)).rejects.toThrow();
	await expect(open(newKey(), runner, 'request', envelope)).rejects.toThrow();
});

it('encrypts API paths and bodies and reconstructs a verified UTF-8 stream', async () => {
	const key = newKey();
	const seen: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith('/relay')) return Response.json({ session });
			seen.push(String(init?.body));
			const e: Envelope = JSON.parse(String(init?.body));
			const request = await open(key, runner, 'request', e);
			expect(request).toMatchObject({ method: 'POST', path: '/api/chat', body: 'private prompt' });
			const text = new TextEncoder().encode('data: 你好\n\ndata: [DONE]\n\n');
			const first = await seal(
				key,
				runner,
				'response',
				{ ...e, seq: 0, final: false },
				{ status: 201, headers: { 'Content-Type': ['text/event-stream'] }, body: base64(text.slice(0, 7)) },
			);
			const last = await seal(key, runner, 'response', { ...e, seq: 1, final: true }, { status: 0, body: base64(text.slice(7)) });
			return new Response(JSON.stringify(first) + '\n' + JSON.stringify(last) + '\n');
		}),
	);
	const response = await encryptedFetch(runner, key)(`${location.origin}/api/runners/${runner}/api/chat`, {
		method: 'POST',
		headers: { Authorization: 'Bearer local-secret' },
		body: 'private prompt',
	});
	expect(response.status).toBe(201);
	expect(response.headers.get('Content-Type')).toBe('text/event-stream');
	expect(await response.text()).toBe('data: 你好\n\ndata: [DONE]\n\n');
	for (const secret of ['private prompt', '/api/chat', 'local-secret', key]) expect(seen.join('')).not.toContain(secret);
});

it.each(['truncated', 'reordered', 'forged-final'])('rejects a %s stream', async (mode) => {
	const key = newKey();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith('/relay')) return Response.json({ session });
			const e: Envelope = JSON.parse(String(init?.body));
			const frame = await seal(
				key,
				runner,
				'response',
				{ ...e, seq: mode === 'reordered' ? 1 : 0, final: false },
				{ status: 200, body: '' },
			);
			if (mode === 'forged-final') frame.final = true;
			return new Response(JSON.stringify(frame) + '\n');
		}),
	);
	await expect(
		(async () => {
			const response = await encryptedFetch(runner, key)(`${location.origin}/api/runners/${runner}/api/config`);
			await response.text();
		})(),
	).rejects.toThrow();
});

it('fails a stream the runner marks as incomplete', async () => {
	const key = newKey();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			if (!url.endsWith('/relay')) return Response.json({ session });
			const e: Envelope = JSON.parse(String(init?.body));
			const first = await seal(
				key,
				runner,
				'response',
				{ ...e, seq: 0, final: false },
				{ status: 200, body: base64(new TextEncoder().encode('part')) },
			);
			const last = await seal(key, runner, 'response', { ...e, seq: 1, final: true }, { status: 0, body: '', error: 'unexpected EOF' });
			return new Response(JSON.stringify(first) + '\n' + JSON.stringify(last) + '\n');
		}),
	);
	const response = await encryptedFetch(runner, key)(`${location.origin}/api/runners/${runner}/api/chat`);
	await expect(response.text()).rejects.toThrow('unexpected EOF');
});
