// Every Mob tab in a browser shares one runner. The pool's file handles are
// exclusive, so the runner of one tab leads: it holds the lock, owns the
// database and serves every tab over the channel. The others follow, and wait
// for the lock to lead in turn when the leader's tab closes. The worker
// (runner.worker.ts) gives this its browser APIs, so tests can give it fakes.
import type { FromWorker, Shared, ToWorker } from './protocol';

/** Serving is what a runner needs of the server it starts. */
export type Serving = { fetch(request: Request): Promise<Response>; readonly busy: boolean };
/** Takeover is set when a runner starts after another tab's closed; persistent says whether that one kept its database. */
export type Takeover = { persistent: boolean };
type Channel = { postMessage(m: Shared): void; onmessage: ((event: MessageEvent<Shared>) => void) | null };

export const lockName = 'mob-browser-runner';
// Each runner holds a lock of its own tab's while it lives, so the leader learns when a follower's tab closed.
const tabLock = (id: string) => `mob-browser-tab-${id}`;
const held = () => new Promise<never>(() => {});
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * retryOpen opens the database pool, trying again for a while when a takeover
 * finds the files still held by the closing tab. The pool caches a failed
 * install, so later attempts ask it to start over.
 */
export async function retryOpen<T>(open: (again: boolean) => Promise<T>, attempts: number, wait = 200): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await open(attempt > 0);
		} catch (e) {
			if (attempt + 1 >= attempts) throw e;
			await new Promise(resolve => setTimeout(resolve, wait));
		}
	}
}

/**
 * openSaved opens the database pool, or resolves undefined where Mob may keep
 * conversations in memory instead. That is only where this browser never
 * saved any: once it has (saved finds the pool's files), or when taking over
 * from a leader that kept them, every runner, a new one after a failure
 * included, keeps trying and then fails rather than serve an empty database
 * in their place.
 */
export async function openSaved<T>(open: (again: boolean) => Promise<T>, saved: () => Promise<boolean>, takeover?: Takeover): Promise<T | undefined> {
	const keep = takeover?.persistent || await saved();
	try {
		// A runner taking over from a closed tab may find the files still held for a moment while that tab's worker goes away.
		return await retryOpen(open, keep ? 10 : 1);
	} catch (e) {
		if (keep) throw new Error(`Mob could not open the conversations saved in this browser (${errorText(e)}). Close other Mob tabs, then try again.`);
		// Without OPFS, such as in some private windows, conversations last as long as the tab whose runner leads.
		console.warn('Mob keeps this browser’s conversations in memory: ' + errorText(e));
		return undefined;
	}
}

/** sharedRunner runs one tab's side of the shared runner and returns what handles its page's messages. */
export function sharedRunner({ tab, post, channel, locks, start, leaderWait = 15_000 }: {
	tab: string;
	post: (m: FromWorker, transfer?: Transferable[]) => void;
	channel?: Channel;
	locks?: LockManager;
	start: (token: string, takeover?: Takeover) => Promise<{ server: Serving; persistent: boolean }>;
	/** A follower that hears no leader in this long is likely beside a tab of an older Mob, which does not share. */
	leaderWait?: number;
}) {
	const share = (m: Shared) => channel?.postMessage(m);
	let token = '';
	// ready is set while this tab's runner leads, or is starting to.
	let ready: Promise<Serving> | undefined;
	// Whether the database of the runner leading, this one or another tab's, outlives its tab.
	let persistent = true;
	// announced is set once the page was told the runner serves, whichever tab's runner it is.
	let announced = false;
	// Requests from this tab's page passed to the leader, by the page's id.
	const forwarded = new Set<number>();
	// Requests being served, by the asking tab ('' for this one) and its id.
	const running = new Map<string, AbortController>();
	const watched = new Set<string>();
	// The tab whose runner this one last heard lead.
	let leader = '';

	function announce(serving: boolean) {
		if (announced) return;
		announced = true;
		post({ type: 'ready', persistent: serving });
	}

	// failForwarded answers the requests passed to a leader that went away; their callers try again.
	function failForwarded() {
		for (const id of forwarded) post({ type: 'error', id, error: 'The Mob tab that served this one closed. Try again.' });
		forwarded.clear();
	}

	// lead starts this tab's runner, and holds the lock for as long as it serves; one that failed lets another tab try.
	function lead(takeover?: Takeover): Promise<unknown> {
		const started = start(token, takeover);
		const serving = started.then(s => s.server);
		// Its failure is reported below; requests waiting on it get it too.
		serving.catch(() => {});
		ready = serving;
		failForwarded();
		return started.then(s => {
			persistent = s.persistent;
			reportBusy(s.server);
			announce(s.persistent);
			share({ type: 'leader', tab, persistent: s.persistent });
			return held();
		}, e => {
			// A runner that did not start serves nobody: it stops answering, and its page starts over.
			if (ready === serving) ready = undefined;
			if (!announced) { announced = true; post({ type: 'failed', error: errorText(e) }); return; }
			failForwarded();
			post({ type: 'lost', error: `Mob could not take over from the tab that closed: ${errorText(e)}` });
		});
	}

	// The page asks before its tab closes while a turn runs here: other tabs would
	// take over the database, but not the turn. Checked each second; a turn lasts longer.
	function reportBusy(server: Serving) {
		let busy = false;
		setInterval(() => {
			if (server.busy === busy) return;
			busy = server.busy;
			post({ type: 'busy', busy });
		}, 1000);
	}

	async function begin() {
		if (!locks) { void lead(); return; }
		await new Promise<void>(resolve => void locks.request(tabLock(tab), () => { resolve(); return held(); }));
		const first = await new Promise<boolean>(resolve => {
			void locks.request(lockName, { ifAvailable: true }, lock => {
				resolve(!!lock);
				return lock ? lead() : undefined;
			});
		});
		if (first) return;
		if (!channel) {
			announced = true;
			post({ type: 'failed', error: 'Mob is open in another tab, and this browser cannot share it between tabs. Close that tab and try again.' });
			return;
		}
		share({ type: 'hello' });
		setTimeout(() => {
			if (announced) return;
			announced = true;
			post({ type: 'failed', error: 'Mob is open in another tab that has not answered. Reload that tab, then try again here.' });
		}, leaderWait);
		// This tab leads when the leader's tab closes.
		void locks.request(lockName, () => lead({ persistent }));
	}

	// watch ends the requests of a follower whose tab closed, such as its change stream.
	function watch(from: string) {
		if (watched.has(from) || !locks) return;
		watched.add(from);
		void locks.request(tabLock(from), () => {
			watched.delete(from);
			for (const [key, abort] of running) if (key.startsWith(from + ':')) abort.abort();
		});
	}

	type Answer = Extract<FromWorker, { type: 'head' | 'chunk' | 'end' | 'error' }>;
	async function serve(server: Serving, m: Extract<ToWorker, { type: 'request' }>, from = '') {
		const key = `${from}:${m.id}`;
		const answer = (a: Answer) => from ? share({ ...a, to: from }) : post(a, a.type === 'chunk' ? [a.chunk.buffer as ArrayBuffer] : []);
		const abort = new AbortController();
		running.set(key, abort);
		try {
			const response = await server.fetch(new Request(m.url, { method: m.method, headers: m.headers, body: m.body, signal: abort.signal }));
			answer({ type: 'head', id: m.id, status: response.status, headers: [...response.headers] });
			if (response.body) {
				const reader = response.body.getReader();
				abort.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					answer({ type: 'chunk', id: m.id, chunk: value.slice() });
				}
			}
			answer({ type: 'end', id: m.id });
		} catch (e) {
			answer({ type: 'error', id: m.id, error: errorText(e) });
		} finally {
			running.delete(key);
		}
	}

	if (channel) channel.onmessage = (event: MessageEvent<Shared>) => {
		const m = event.data;
		switch (m.type) {
			case 'hello':
				void ready?.then(() => share({ type: 'leader', tab, persistent }), () => {});
				return;
			case 'leader':
				// A new leader means the last one went away with whatever it was serving for this tab.
				if (leader && leader !== m.tab) failForwarded();
				leader = m.tab;
				persistent = m.persistent;
				announce(m.persistent);
				return;
			case 'request':
				if (!ready) return;
				watch(m.from);
				ready.then(server => serve(server, m, m.from), e => share({ type: 'error', to: m.from, id: m.id, error: errorText(e) }));
				return;
			case 'abort':
				running.get(`${m.from}:${m.id}`)?.abort();
				return;
			default: {
				if (m.to !== tab || !forwarded.has(m.id)) return;
				if (m.type === 'end' || m.type === 'error') forwarded.delete(m.id);
				const { to: _, ...answer } = m;
				post(answer, answer.type === 'chunk' ? [answer.chunk.buffer as ArrayBuffer] : []);
			}
		}
	};

	/** receive handles the page's init, requests and aborts; it returns false for any other message. */
	return function receive(m: ToWorker) {
		switch (m.type) {
			case 'init':
				if (token) return true;
				token = m.token;
				void begin();
				return true;
			case 'request':
				if (ready) { ready.then(server => serve(server, m), e => post({ type: 'error', id: m.id, error: errorText(e) })); return true; }
				if (!announced) { post({ type: 'error', id: m.id, error: 'The browser runner has not started.' }); return true; }
				forwarded.add(m.id);
				share({ ...m, from: tab });
				return true;
			case 'abort':
				if (forwarded.delete(m.id)) share({ type: 'abort', from: tab, id: m.id });
				else running.get(`:${m.id}`)?.abort();
				return true;
			default:
				return false;
		}
	};
}
