import { afterEach, expect, it, vi } from 'vitest';
import { ConversationClient, MobClient, type Snapshot } from './index';

const initial: Snapshot = { messages: [], active: false, model: 'demo/echo' };
const connection = { url: 'http://localhost', token: 'first-token' };
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
});

it('runs event-free tui commands and publishes replies without browser globals', async () => {
	expect(typeof globalThis.window).toBe('undefined');
	expect(typeof globalThis.document).toBe('undefined');
	let history = initial;
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			const path = String(url);
			if (path.endsWith('/commands/run')) {
				const body = JSON.parse(String(init?.body));
				expect(body.client).toBe('tui');
				return Response.json(body.text === '/list' ? { handled: true, markdown: 'One conversation' } : { handled: false });
			}
			if (path.endsWith('/chat')) {
				const body = JSON.parse(String(init?.body));
				const text = `Received: ${body.text}`;
				history = { ...initial, messages: [{ id: 'reply', role: 'assistant', parts: [{ type: 'text', text }] }] };
				const chunks = [
					{ type: 'start', messageId: 'reply' },
					{ type: 'text-start', id: 'text' },
					{ type: 'text-delta', id: 'text', delta: text },
					{ type: 'text-end', id: 'text' },
					{ type: 'finish' },
				];
				return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
					headers: { 'Content-Type': 'text/event-stream' },
				});
			}
			return Response.json(history);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	cleanups.push(session.start());
	await session.submit('/list');
	expect(session.getSnapshot().commandResult).toBe('One conversation');
	await session.submit('/unknown 中文\nsecond line');
	expect(session.getSnapshot().messages.at(-1)?.parts).toContainEqual(
		expect.objectContaining({ text: 'Received: /unknown 中文\nsecond line' }),
	);
	expect(session.getSnapshot().busy).toBe(false);
	expect(session.getSnapshot().input).toBe('');
});

it('preserves a newer draft when a send fails, and restores an empty draft', async () => {
	let reject!: (error: Error) => void;
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/chat'))
				return new Promise<Response>((_, fail) => {
					reject = fail;
				});
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	cleanups.push(session.start());
	const sending = session.submit('original 中文 draft');
	await vi.waitFor(() => expect(reject).toBeDefined());
	session.setInput('next draft');
	reject(new Error('offline'));
	await sending;
	expect(session.getSnapshot().input).toBe('next draft');
	expect(session.getSnapshot().error?.message).toBe('offline');

	const retry = session.submit('restore this');
	await vi.waitFor(() => expect(session.getSnapshot().streaming).toBe(true));
	reject(new Error('still offline'));
	await retry;
	expect(session.getSnapshot().input).toBe('restore this');
});

it('reports the rejected credential without platform-specific notification machinery', async () => {
	const rejected: string[] = [];
	const client = new MobClient(connection, {
		fetch: async () => new Response('unauthorized', { status: 401 }),
		onUnauthorized: (token) => rejected.push(token),
	});
	await expect(client.listConversations()).rejects.toThrow('unauthorized');
	expect(rejected).toEqual(['first-token']);
});

it('ignores a snapshot from the previous attachment after start cleanup/start', async () => {
	let resolveOld!: (response: Response) => void;
	let reads = 0;
	const client = new MobClient(connection, {
		fetch: async () => {
			if (++reads === 1)
				return new Promise<Response>((resolve) => {
					resolveOld = resolve;
				});
			return Response.json({ ...initial, model: 'demo/current' });
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	const detach = session.start();
	detach();
	cleanups.push(session.start());
	await vi.waitFor(() => expect(session.getSnapshot().model).toBe('demo/current'));
	resolveOld(Response.json({ ...initial, model: 'demo/stale' }));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(session.getSnapshot().model).toBe('demo/current');
});

it('clears an interrupted follow after idle reconciliation, but keeps command failures', async () => {
	let history: Snapshot = { ...initial, active: true };
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/stream')) throw new Error('lost SSE connection');
			if (String(url).endsWith('/commands/run')) return new Response('command refused', { status: 403 });
			return Response.json(history);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial: history, clientType: 'tui' });
	cleanups.push(session.start());
	await vi.waitFor(() => expect(session.getSnapshot().failure).toBe('lost SSE connection'));
	history = { ...initial, messages: [{ id: 'finished', role: 'assistant', parts: [{ type: 'text', text: 'Final persisted reply' }] }] };
	await vi.waitFor(
		() => {
			expect(session.getSnapshot().busy).toBe(false);
			expect(session.getSnapshot().messages).toEqual(history.messages);
			expect(session.getSnapshot().failure).toBe('');
		},
		{ timeout: 3000 },
	);
	await session.submit('/refused');
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(session.getSnapshot().failure).toBe('command refused');
	expect(session.getSnapshot().input).toBe('/refused');
});
