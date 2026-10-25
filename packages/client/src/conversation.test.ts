import { afterEach, expect, it, vi } from 'vitest';
import { Changes, ConversationClient, MobClient, type Snapshot } from './index';

const initial: Snapshot = { messages: [], active: false, model: 'demo/echo' };
const connection = { url: 'http://localhost', token: 'first-token' };
const cleanups: (() => void)[] = [];

function replyStream(text: string) {
	const chunks = [
		{ type: 'start', messageId: 'server-reply' },
		{ type: 'text-start', id: 'text' },
		{ type: 'text-delta', id: 'text', delta: text },
		{ type: 'text-end', id: 'text' },
		{ type: 'finish' },
	];
	return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
		headers: { 'Content-Type': 'text/event-stream' },
	});
}

afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.useRealTimers();
});

it('publishes successive 2.5-second snapshots while polling every 2 seconds', async () => {
	vi.useFakeTimers();
	let reads = 0;
	let completed = 0;
	const client = new MobClient(connection, {
		fetch: async () => {
			const read = ++reads;
			await new Promise((resolve) => setTimeout(resolve, 2500));
			completed++;
			return Response.json({
				...initial,
				model: `demo/read-${read}`,
				messages: [{ id: `reply-${read}`, role: 'assistant', parts: [{ type: 'text', text: `Completed read ${read}` }] }],
			});
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(7200);
	expect(completed).toBe(3);
	expect(session.getSnapshot().model).toBe('demo/read-3');
	expect(session.getSnapshot().messages).toEqual([
		{ id: 'reply-3', role: 'assistant', parts: [{ type: 'text', text: 'Completed read 3' }] },
	]);
	expect(session.getSnapshot().failure).toBe('');
});

it.each([
	['success', 'success'],
	['success', 'error'],
	['error', 'success'],
	['error', 'error'],
])('keeps a newer published %s when an older idle snapshot %s completes', async (newer, outcome) => {
	vi.useFakeTimers();
	let resolveOld!: (response: Response) => void;
	let rejectOld!: (error: Error) => void;
	let reads = 0;
	const current: Snapshot = {
		...initial,
		model: 'demo/current',
		messages: [{ id: 'new-reply', role: 'assistant', parts: [{ type: 'text', text: 'New history' }] }],
	};
	const client = new MobClient(connection, {
		fetch: async () => {
			if (++reads === 1)
				return new Promise<Response>((resolve, reject) => {
					resolveOld = resolve;
					rejectOld = reject;
				});
			if (newer === 'error') throw new Error('newer snapshot error');
			return Response.json(current);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(2000);
	expect(session.getSnapshot().model).toBe(newer === 'success' ? 'demo/current' : 'demo/echo');
	expect(session.getSnapshot().failure).toBe(newer === 'success' ? '' : 'newer snapshot error');
	if (outcome === 'success') resolveOld(Response.json({ ...initial, model: 'demo/stale' }));
	else rejectOld(new Error('obsolete offline error'));
	await vi.advanceTimersByTimeAsync(0);
	expect(session.getSnapshot().model).toBe(newer === 'success' ? 'demo/current' : 'demo/echo');
	expect(session.getSnapshot().messages).toEqual(newer === 'success' ? current.messages : []);
	expect(session.getSnapshot().failure).toBe(newer === 'success' ? '' : 'newer snapshot error');
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
	let posts = 0;
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/chat'))
				return new Promise<Response>((_, fail) => {
					posts++;
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
	await vi.waitFor(() => expect(posts).toBe(2));
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

it.each(['success', 'error'])('ignores an old snapshot %s after start cleanup/start', async (outcome) => {
	let resolveOld!: (response: Response) => void;
	let rejectOld!: (error: Error) => void;
	let reads = 0;
	const client = new MobClient(connection, {
		fetch: async () => {
			if (++reads === 1)
				return new Promise<Response>((resolve, reject) => {
					resolveOld = resolve;
					rejectOld = reject;
				});
			return Response.json({ ...initial, model: 'demo/current' });
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	const detach = session.start();
	detach();
	cleanups.push(session.start());
	await vi.waitFor(() => expect(session.getSnapshot().model).toBe('demo/current'));
	if (outcome === 'success') resolveOld(Response.json({ ...initial, model: 'demo/stale' }));
	else rejectOld(new Error('old attachment error'));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(session.getSnapshot().model).toBe('demo/current');
	expect(session.getSnapshot().failure).toBe('');
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

it('reconciles an aborted detached send before restoring its original text', async () => {
	let rejectSend!: (error: Error) => void;
	let resolveSnapshot!: (response: Response) => void;
	let requestId = '';
	let reattached = false;
	let posts = 0;
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				posts++;
				requestId = JSON.parse(String(init?.body)).requestId;
				return new Promise<Response>((_, reject) => {
					rejectSend = reject;
				});
			}
			if (reattached)
				return new Promise<Response>((resolve) => {
					resolveSnapshot = resolve;
				});
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	const detach = session.start();
	const text = '原始中文\n第二行';
	const sending = session.submit(text);
	await vi.waitFor(() => expect(requestId).not.toBe(''));
	detach();
	rejectSend(new Error('connection unavailable'));
	await sending;
	expect(session.getSnapshot().input).toBe('');
	reattached = true;
	cleanups.push(session.start());
	await vi.waitFor(() => expect(resolveSnapshot).toBeDefined());
	expect(session.getSnapshot().input).toBe('');
	expect(session.getSnapshot().failure).toBe('');
	expect(session.getSnapshot().busy).toBe(true);
	resolveSnapshot(Response.json(initial));
	await vi.waitFor(() => expect(session.getSnapshot().input).toBe(text));
	expect(session.getSnapshot().failure).toMatch(/recover|not confirmed/i);
	expect(session.getSnapshot().messages).toEqual([]);
	expect(posts).toBe(1);
});

it.each([false, true])('confirms a later accepted ID without removing an edited recovery draft (%s)', async (edited) => {
	vi.useFakeTimers();
	let history = initial;
	let requestId = '';
	let rejectSend!: (error: Error) => void;
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				requestId = JSON.parse(String(init?.body)).requestId;
				return new Promise<Response>((_, reject) => {
					rejectSend = reject;
				});
			}
			return Response.json(history);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	const detach = session.start();
	const text = 'Possibly accepted';
	const sending = session.submit(text);
	await vi.advanceTimersByTimeAsync(0);
	detach();
	rejectSend(new Error('connection lost'));
	await sending;
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(0);
	expect(session.getSnapshot().recovery).toEqual({ requestId, text });
	expect(session.getSnapshot().input).toBe(text);
	if (edited) {
		session.setInput('Editing original text');
		session.setInput(text);
	}
	history = { ...initial, messages: [{ id: requestId, role: 'user', parts: [{ type: 'text', text }] }] };
	await vi.advanceTimersByTimeAsync(2000);
	expect(session.getSnapshot().recovery).toBeUndefined();
	expect(session.getSnapshot().failure).toBe('');
	expect(session.getSnapshot().input).toBe(edited ? text : '');
	expect(session.getSnapshot().messages).toEqual(history.messages);
});

it.each(['success', 'error'])('ignores an old snapshot %s after a local send', async (outcome) => {
	let resolveOld!: (response: Response) => void;
	let rejectOld!: (error: Error) => void;
	let reads = 0;
	let history = initial;
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				const body = JSON.parse(String(init?.body));
				history = {
					...initial,
					messages: [
						{ id: body.requestId, role: 'user', parts: [{ type: 'text', text: body.text }] },
						{ id: 'server-reply', role: 'assistant', parts: [{ type: 'text', text: 'Local result' }] },
					],
				};
				return replyStream('Local result');
			}
			if (++reads === 1)
				return new Promise<Response>((resolve, reject) => {
					resolveOld = resolve;
					rejectOld = reject;
				});
			return Response.json(history);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	await session.submit('Local prompt');
	if (outcome === 'success') resolveOld(Response.json({ ...initial, model: 'demo/stale' }));
	else rejectOld(new Error('pre-send failure'));
	await new Promise((resolve) => setTimeout(resolve, 10));
	expect(session.getSnapshot().messages).toEqual(history.messages);
	expect(session.getSnapshot().model).toBe('demo/echo');
	expect(session.getSnapshot().failure).toBe('');
});

it.each(['running', 'completed'])('reattaches an accepted %s send despite a late aborted response', async (phase) => {
	const text = '原始输入\n已接收';
	let history = initial;
	let releaseSend!: (response: Response) => void;
	let requestId = '';
	let posts = 0;
	const reply = { id: 'server-reply', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'Accepted server result' }] };
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				posts++;
				requestId = JSON.parse(String(init?.body)).requestId;
				return new Promise<Response>((resolve) => {
					releaseSend = resolve;
				});
			}
			if (String(url).endsWith('/stream')) {
				history = { ...initial, messages: [history.messages[0], reply] };
				return replyStream('Accepted server result');
			}
			return Response.json(history);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	const detach = session.start();
	const sending = session.submit(text);
	await vi.waitFor(() => expect(releaseSend).toBeDefined());
	session.setInput('Newer unsent draft');
	detach();
	cleanups.push(session.start());
	expect(session.getSnapshot().busy).toBe(true);
	expect(session.getSnapshot().recovery).toBeUndefined();
	await session.submit('Must not send during reconciliation');
	history = {
		...initial,
		active: phase === 'running',
		messages: [
			{ id: requestId, role: 'user', parts: [{ type: 'text', text }] },
			phase === 'running' ? { ...reply, metadata: { status: 'streaming' }, parts: [{ type: 'text', text: 'Partial' }] } : reply,
		],
	};
	releaseSend(replyStream('Ignore this late aborted response'));
	await sending;
	await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
	expect(session.getSnapshot().messages).toMatchObject(history.messages);
	expect(session.getSnapshot().input).toBe('Newer unsent draft');
	expect(session.getSnapshot().recovery).toBeUndefined();
	expect(session.getSnapshot().failure).toBe('');
	expect(session.getSnapshot().error).toBeUndefined();
	expect(posts).toBe(1);
});

it.each(['', 'Newer draft'])(
	'keeps newer input %j and exposes original recovery despite identical text under another ID',
	async (draft) => {
		const text = '同样的消息\n原文';
		let releaseSend!: (response: Response) => void;
		let requestId = '';
		let posts = 0;
		const history: Snapshot = {
			...initial,
			messages: [
				{ id: 'another-request', role: 'user', parts: [{ type: 'text', text }] },
				{ id: 'another-reply', role: 'assistant', parts: [{ type: 'text', text: 'Other client already completed' }] },
			],
		};
		const client = new MobClient(connection, {
			fetch: async (url, init) => {
				if (String(url).endsWith('/chat')) {
					posts++;
					requestId = JSON.parse(String(init?.body)).requestId;
					return new Promise<Response>((resolve) => {
						releaseSend = resolve;
					});
				}
				return Response.json(history);
			},
		});
		const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
		const detach = session.start();
		const sending = session.submit(text);
		await vi.waitFor(() => expect(releaseSend).toBeDefined());
		session.setInput('User started a new draft');
		session.setInput(draft);
		detach();
		cleanups.push(session.start());
		expect(session.getSnapshot().recovery).toBeUndefined();
		releaseSend(new Response('conversation is busy', { status: 409 }));
		await sending;
		expect(session.getSnapshot().input).toBe(draft);
		expect(session.getSnapshot().recovery).toEqual({ requestId, text });
		expect(session.getSnapshot().failure).toMatch(/not confirmed/i);
		expect(session.getSnapshot().messages).toEqual(history.messages);
		expect(session.getSnapshot().busy).toBe(false);
		expect(posts).toBe(1);
	},
);

it('preserves a Continue draft through detachment and absent-request reconciliation', async () => {
	let rejectSend!: (error: Error) => void;
	let requestId = '';
	let posts = 0;
	const stopped: Snapshot = {
		...initial,
		messages: [
			{ id: 'limit', role: 'assistant', metadata: { status: 'step-limit' }, parts: [{ type: 'text', text: 'Reached tool step limit' }] },
		],
	};
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				posts++;
				const body = JSON.parse(String(init?.body));
				expect(body.text).toBe('Continue');
				requestId = body.requestId;
				return new Promise<Response>((_, reject) => {
					rejectSend = reject;
				});
			}
			return Response.json(stopped);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial: stopped, clientType: 'web' });
	const detach = session.start();
	session.setInput('Unsent Chinese 草稿');
	const continuing = session.proceed();
	await vi.waitFor(() => expect(rejectSend).toBeDefined());
	expect(session.getSnapshot().input).toBe('Unsent Chinese 草稿');
	detach();
	rejectSend(new Error('lost connection'));
	await continuing;
	cleanups.push(session.start());
	await vi.waitFor(() => expect(session.getSnapshot().busy).toBe(false));
	expect(session.getSnapshot().input).toBe('Unsent Chinese 草稿');
	expect(session.getSnapshot().recovery).toEqual({ requestId, text: 'Continue' });
	expect(session.getSnapshot().messages).toEqual(stopped.messages);
	expect(posts).toBe(1);
});

it('keeps delivery unknown until a successful reattachment snapshot, not a snapshot error', async () => {
	vi.useFakeTimers();
	let rejectSend!: (error: Error) => void;
	let reattached = false;
	let available = false;
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/chat'))
				return new Promise<Response>((_, reject) => {
					rejectSend = reject;
				});
			if (reattached && !available) return new Response('snapshot unavailable', { status: 503 });
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	const detach = session.start();
	const sending = session.submit('Keep this unresolved text');
	await vi.advanceTimersByTimeAsync(0);
	detach();
	rejectSend(new Error('aborted transport'));
	await sending;
	reattached = true;
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(0);
	expect(session.getSnapshot().busy).toBe(true);
	expect(session.getSnapshot().input).toBe('Keep this unresolved text');
	expect(session.getSnapshot().recovery).toBeUndefined();
	expect(session.getSnapshot().failure).toMatch(/^snapshot unavailable · Delivery not confirmed yet/);
	available = true;
	await vi.advanceTimersByTimeAsync(2000);
	expect(session.getSnapshot().busy).toBe(false);
	expect(session.getSnapshot().input).toBe('Keep this unresolved text');
	expect(session.getSnapshot().recovery?.text).toBe('Keep this unresolved text');
	expect(session.getSnapshot().failure).toMatch(/not confirmed/i);
});

it.each([false, true])('returns an unverifiable send to the editor while the service is down, then settles it (accepted: %s)', async (accepted) => {
	vi.useFakeTimers();
	let up = true;
	let requestId = '';
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				requestId = JSON.parse(String(init?.body)).requestId;
				up = false;
				throw new TypeError('fetch failed');
			}
			if (!up) throw new TypeError('fetch failed');
			const messages = accepted ? [{ id: requestId, role: 'user', parts: [{ type: 'text', text: 'Lost while down' }] }] : [];
			return Response.json({ ...initial, messages });
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(0);
	await session.submit('Lost while down');
	await vi.advanceTimersByTimeAsync(4000);
	expect(session.getSnapshot().busy).toBe(true);
	expect(session.getSnapshot().input).toBe('Lost while down');
	expect(session.getSnapshot().failure).toMatch(/fetch failed · Delivery not confirmed yet/);
	up = true;
	await vi.advanceTimersByTimeAsync(2000);
	expect(session.getSnapshot().busy).toBe(false);
	expect(session.getSnapshot().input).toBe(accepted ? '' : 'Lost while down');
	expect(session.getSnapshot().recovery).toEqual(accepted ? undefined : { requestId, text: 'Lost while down' });
	expect(session.getSnapshot().failure).toMatch(accepted ? /^$/ : /not confirmed\. Original/);
});

it('keeps text typed while the service is down', async () => {
	vi.useFakeTimers();
	let up = true;
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/chat')) up = false;
			if (!up) throw new TypeError('fetch failed');
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'tui' });
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(0);
	await session.submit('Original');
	session.setInput('');
	session.setInput('Newer draft');
	await vi.advanceTimersByTimeAsync(4000);
	expect(session.getSnapshot().input).toBe('Newer draft');
});

it('keeps unchanged messages as the same objects across reloads', async () => {
	const { reuseMessages } = await import('./conversation');
	const one = { id: 'one', role: 'user' as const, parts: [{ type: 'text' as const, text: 'hi' }] };
	const two = { id: 'two', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'hello' }] };
	const current = [one, two];
	expect(reuseMessages(current, structuredClone(current))).toBe(current);
	const edited = { ...two, parts: [{ type: 'text' as const, text: 'hello there' }] };
	const next = reuseMessages(current, [structuredClone(one), edited]);
	expect(next).not.toBe(current);
	expect(next[0]).toBe(one);
	expect(next[1]).toBe(edited);
});

it('reloads on changes instead of polling while the change stream is live, and polls again when it drops', async () => {
	vi.useFakeTimers();
	let push!: (text: string) => void;
	let end!: () => void;
	const reads: string[] = [];
	const client = new MobClient(connection, {
		fetch: async (input) => {
			const url = String(input);
			if (url.endsWith('/api/events')) {
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						const encoder = new TextEncoder();
						push = (text) => controller.enqueue(encoder.encode(text));
						end = () => controller.close();
					},
				});
				return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
			}
			reads.push(url);
			return Response.json(initial);
		},
	});
	const changes = new Changes(client);
	cleanups.push(changes.start());
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web', changes });
	cleanups.push(session.start());
	await vi.advanceTimersByTimeAsync(10);
	push('retry: 2000\n: ready\n\n');
	await vi.advanceTimersByTimeAsync(10);
	expect(changes.live).toBe(true);
	const settled = reads.length;
	await vi.advanceTimersByTimeAsync(6000);
	expect(reads.length).toBe(settled);
	push('data: {"seq":1,"conversation":"other"}\n\n');
	push('data: {"seq":2,"conversation":"one"}\n\n');
	await vi.advanceTimersByTimeAsync(10);
	expect(reads.length).toBe(settled + 1);
	end();
	await vi.advanceTimersByTimeAsync(10);
	expect(changes.live).toBe(false);
	// The drop itself reloads once, then polling resumes.
	const dropped = reads.length;
	await vi.advanceTimersByTimeAsync(4100);
	expect(reads.length).toBeGreaterThanOrEqual(dropped + 2);
});

it.each([200, 500])('preserves the composer during a directly handled command returning %s', async (status) => {
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/commands/run')) return Response.json(status === 200 ? { handled: true } : { error: 'switch failed' }, { status });
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	session.setInput('Keep my draft');
	await session.submit('/model demo/echo', { preserveInput: true });
	expect(session.getSnapshot().input).toBe('Keep my draft');
	session.setInput('');
	await session.submit('/model default', { preserveInput: true });
	expect(session.getSnapshot().input).toBe('');
});

it('chooses a model as a setting, without sending chat or touching the draft', async () => {
	const posted: { url: string; body: unknown }[] = [];
	let refuse = false;
	const client = new MobClient(connection, {
		fetch: async (url, options) => {
			if (options?.method === 'POST') posted.push({ url: String(url), body: JSON.parse(String(options.body)) });
			if (String(url).endsWith('/model')) return refuse ? Response.json({ error: 'no model matches "x"' }, { status: 400 }) : Response.json({ model: 'demo/echo' });
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	session.setInput('Keep my draft');
	expect(await session.setModel('demo/echo')).toBe(true);
	expect(posted).toEqual([{ url: expect.stringContaining('/conversations/one/model'), body: { model: 'demo/echo' } }]);
	expect(session.getSnapshot()).toMatchObject({ model: 'demo/echo', input: 'Keep my draft', messages: [] });
	refuse = true;
	expect(await session.setModel('x')).toBe(false);
	expect(session.getSnapshot().failure).toContain('no model matches');
});

it('holds Send and a second choice until a slow model choice is saved', async () => {
	const chats: unknown[] = [];
	let save!: () => void;
	const client = new MobClient(connection, {
		fetch: async (url, options) => {
			if (String(url).endsWith('/model')) {
				await new Promise<void>((resolve) => (save = resolve));
				return Response.json(JSON.parse(String(options?.body)));
			}
			if (String(url).endsWith('/chat')) chats.push(JSON.parse(String(options?.body)));
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	session.setInput('Keep my draft');
	const first = session.setModel('demo/echo');
	expect(session.getSnapshot()).toMatchObject({ busy: true, dispatching: true });
	expect(await session.setModel('demo/other')).toBe(false);
	await session.submit();
	expect(chats).toEqual([]);
	await vi.waitFor(() => expect(save).toBeDefined());
	save();
	expect(await first).toBe(true);
	expect(session.getSnapshot()).toMatchObject({ model: 'demo/echo', busy: false, dispatching: false, input: 'Keep my draft' });
});

for (const outcome of ['absent', 'accepted', 'offline'] as const) {
	it.each(['', 'Keep my draft', '/model demo/echo'])('preserves picker draft %j when chat delivery is ' + outcome, async (draft) => {
		let sent: { requestId: string; text: string } | undefined;
		const client = new MobClient(connection, {
			fetch: async (url, options) => {
				if (String(url).endsWith('/commands/run')) return Response.json({ handled: false });
				if (String(url).endsWith('/chat')) {
					sent = JSON.parse(String(options?.body));
					throw new TypeError('connection dropped');
				}
				if (sent && outcome === 'offline') throw new TypeError('history unavailable');
				return Response.json({
					...initial,
					messages: sent && outcome === 'accepted'
						? [{ id: sent.requestId, role: 'user', parts: [{ type: 'text', text: sent.text }] }]
						: [],
				});
			},
		});
		const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
		cleanups.push(session.start());
		session.setInput(draft);
		await session.submit('/model demo/echo', { preserveInput: true });
		expect(sent?.text).toBe('/model demo/echo');
		if (outcome === 'accepted') await vi.waitFor(() => expect(session.getSnapshot().messages).toHaveLength(1));
		else await vi.waitFor(() => expect(session.getSnapshot().failure).toContain('Delivery not confirmed'));
		expect(session.getSnapshot().input).toBe(draft);
		if (outcome === 'offline') expect(session.getSnapshot().failure).not.toContain('kept in the editor');
	});
}

it.each(['', 'Continue'])('keeps the composer %j when Continue cannot be delivered', async (draft) => {
	const client = new MobClient(connection, {
		fetch: async (url) => {
			if (String(url).endsWith('/chat')) throw new TypeError('connection dropped');
			return Response.json(initial);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial, clientType: 'web' });
	cleanups.push(session.start());
	session.setInput(draft);
	await session.proceed();
	expect(session.getSnapshot().recovery?.text).toBe('Continue');
	expect(session.getSnapshot().input).toBe(draft);
});

it('says a message again in place of it and what followed, keeping the draft', async () => {
	const said = (id: string, role: 'user' | 'assistant', text: string) => ({ id, role, parts: [{ type: 'text' as const, text }] });
	let history: Snapshot = { ...initial, messages: [said('u1', 'user', 'first'), said('a1', 'assistant', 'one'), said('u2', 'user', 'second'), said('a2', 'assistant', 'two')] };
	const bodies: Record<string, unknown>[] = [];
	const client = new MobClient(connection, {
		fetch: async (url, init) => {
			if (String(url).endsWith('/chat')) {
				const body = JSON.parse(String(init?.body));
				bodies.push(body);
				history = { ...initial, messages: [...history.messages.slice(0, 2), said(body.requestId, 'user', body.text), said('server-reply', 'assistant', 'edited reply')] };
				return replyStream('edited reply');
			}
			return Response.json(history);
		},
	});
	const session = new ConversationClient({ client, id: 'one', initial: history, clientType: 'web' });
	cleanups.push(session.start());
	session.setInput('unsent draft');
	await session.resend('u2', ' second, edited ');
	expect(bodies.at(-1)).toMatchObject({ id: 'one', replace: 'u2', text: 'second, edited' });
	expect(session.getSnapshot().messages.map((m) => m.parts[0])).toEqual([
		{ type: 'text', text: 'first' },
		{ type: 'text', text: 'one' },
		{ type: 'text', text: 'second, edited' },
		expect.objectContaining({ text: 'edited reply' }),
	]);
	expect(session.getSnapshot().input).toBe('unsent draft');
	// Only the owner's messages are said again.
	await session.resend('a1', 'nope');
	expect(bodies).toHaveLength(1);
});

it('leaves an empty draft alone when the service refuses an edit', async () => {
	const said = (id: string, role: 'user' | 'assistant', text: string) => ({ id, role, parts: [{ type: 'text' as const, text }] });
	const history: Snapshot = { ...initial, messages: [said('u1', 'user', 'first'), said('a1', 'assistant', 'one')] };
	const client = new MobClient(connection, {
		fetch: async (url) => (String(url).endsWith('/chat') ? new Response('conversation is busy; wait or stop the active turn', { status: 409 }) : Response.json(history)),
	});
	const session = new ConversationClient({ client, id: 'one', initial: history, clientType: 'web' });
	cleanups.push(session.start());
	await session.resend('u1', 'first, edited');
	await vi.waitFor(() => expect(session.getSnapshot().messages.map((m) => m.id)).toEqual(['u1', 'a1']));
	expect(session.getSnapshot().input).toBe('');
	expect(session.getSnapshot().failure).not.toBe('');
});
