import { afterEach, expect, it, vi } from 'vitest';
import { retryOpen, sharedRunner, type Serving, type Takeover } from './leader';
import type { FromWorker, Shared, ToWorker } from './protocol';

// A browser's Web Locks and BroadcastChannel, shared by fake tabs in one test.
function browser() {
	type Waiter = { tab: string; name: string; grant: () => void };
	const held = new Map<string, string>();
	const queue: Waiter[] = [];
	const channels = new Map<string, { onmessage: ((event: MessageEvent<Shared>) => void) | null }>();
	const next = () => {
		for (const w of [...queue]) {
			if (held.has(w.name)) continue;
			queue.splice(queue.indexOf(w), 1);
			w.grant();
		}
	};
	const locks = (tab: string) => ({
		request(name: string, ...args: unknown[]) {
			const options = (args.length > 1 ? args[0] : {}) as { ifAvailable?: boolean };
			const callback = args[args.length - 1] as (lock: object | null) => unknown;
			return new Promise((resolve) => {
				const grant = () => {
					held.set(name, tab);
					void Promise.resolve(callback({ name })).finally(() => {
						if (held.get(name) === tab) held.delete(name);
						next();
					}).then(resolve, resolve);
				};
				if (!held.has(name)) grant();
				else if (options.ifAvailable) void Promise.resolve(callback(null)).then(resolve);
				else queue.push({ tab, name, grant });
			});
		},
	}) as unknown as LockManager;
	return {
		tab(id: string, start: (token: string, takeover?: Takeover) => Promise<{ server: Serving; persistent: boolean }>) {
			const posted: FromWorker[] = [];
			const channel = {
				onmessage: null as ((event: MessageEvent<Shared>) => void) | null,
				postMessage(m: Shared) {
					for (const [other, c] of channels) if (other !== id) setTimeout(() => c.onmessage?.({ data: structuredClone(m) } as MessageEvent<Shared>));
				},
			};
			channels.set(id, channel);
			const receive = sharedRunner({ tab: id, post: (m) => posted.push(m), channel, locks: locks(id), start, leaderWait: 60_000 });
			receive({ type: 'init', token: 't' });
			return {
				posted,
				receive,
				// Closing a tab ends its worker: its messages stop and its locks go.
				close() {
					channels.delete(id);
					for (const [name, tab] of held) if (tab === id) held.delete(name);
					for (const w of [...queue]) if (w.tab === id) queue.splice(queue.indexOf(w), 1);
					next();
				},
			};
		},
		// What another tab sees on the channel.
		listen() {
			const heard: Shared[] = [];
			channels.set('listener', { onmessage: (event) => heard.push(event.data) });
			return { heard, ask: (m: Shared) => { for (const [other, c] of channels) if (other !== 'listener') setTimeout(() => c.onmessage?.({ data: m } as MessageEvent<Shared>)); } };
		},
	};
}

const server = (name: string): Serving => ({ busy: false, fetch: async () => new Response(name) });
const request = (id: number): ToWorker => ({ type: 'request', id, url: 'http://localhost/api/config', method: 'GET', headers: [], body: null });
const text = (posted: FromWorker[]) => new TextDecoder().decode(posted.find((m): m is Extract<FromWorker, { type: 'chunk' }> => m.type === 'chunk')?.chunk);

afterEach(() => vi.useRealTimers());

it('asks the pool to start over when retrying, so a cached failure does not repeat', async () => {
	const open = vi.fn(async (again: boolean) => {
		if (open.mock.calls.length === 1) throw new Error('the closed tab still holds the files');
		return again;
	});
	await expect(retryOpen(open, 10, 0)).resolves.toBe(true);
	expect(open.mock.calls).toEqual([[false], [true]]);
	await expect(retryOpen(async () => { throw new Error('no'); }, 3, 0)).rejects.toThrow('no');
});

it('serves a follower tab from the leader', async () => {
	const b = browser();
	const leader = b.tab('a', async () => ({ server: server('from a'), persistent: true }));
	const follower = b.tab('b', async () => { throw new Error('a follower does not start'); });
	await vi.waitFor(() => expect(follower.posted).toContainEqual({ type: 'ready', persistent: true }));
	follower.receive(request(1));
	await vi.waitFor(() => expect(follower.posted.some((m) => m.type === 'end')).toBe(true));
	expect(text(follower.posted)).toBe('from a');
	expect(leader.posted).toContainEqual({ type: 'ready', persistent: true });
});

it('gives up a failed takeover: it stops answering, tells its page, and the next tab leads', async () => {
	const b = browser();
	const a = b.tab('a', async () => ({ server: server('from a'), persistent: true }));
	const takeovers: (Takeover | undefined)[] = [];
	const failing = b.tab('b', async (_token, takeover) => { takeovers.push(takeover); throw new Error('the database is still held'); });
	const c = b.tab('c', async () => ({ server: server('from c'), persistent: true }));
	await vi.waitFor(() => expect(c.posted).toContainEqual({ type: 'ready', persistent: true }));
	await vi.waitFor(() => expect(failing.posted).toContainEqual({ type: 'ready', persistent: true }));
	const listener = b.listen();
	a.close();
	// b was first in line; it knew the database was saved, so it gave up instead of serving an empty one.
	await vi.waitFor(() => expect(failing.posted.some((m) => m.type === 'lost')).toBe(true));
	expect(takeovers).toEqual([{ persistent: true }]);
	await vi.waitFor(() => expect(listener.heard).toContainEqual({ type: 'leader', tab: 'c', persistent: true }));
	// Another tab's request is answered by c alone, with no stale error from b.
	listener.ask({ type: 'request', from: 'x', id: 7, url: 'http://localhost/api/config', method: 'GET', headers: [], body: null });
	await vi.waitFor(() => expect(listener.heard.some((m) => m.type === 'end' && m.to === 'x')).toBe(true));
	expect(listener.heard.filter((m) => m.type === 'head' && m.to === 'x')).toHaveLength(1);
	expect(listener.heard.some((m) => m.type === 'error')).toBe(false);
	// b's page asks again through the new leader rather than its failed runner.
	failing.receive(request(2));
	await vi.waitFor(() => expect(failing.posted.some((m) => m.type === 'end' && m.id === 2)).toBe(true));
});
