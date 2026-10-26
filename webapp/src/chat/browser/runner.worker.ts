// The browser runner: Mob's core service in a dedicated worker, on sqlite-wasm.
// The database lives in the origin private file system, which only a worker
// can open synchronously; the page reaches the API through browserFetch.
import init from '@sqlite.org/sqlite-wasm';
import { ProviderRegistry, Server, Store, type ProvidersFile, type ProvidersStorage } from '@mob/core';
import { openWasm } from '@mob/core/sqlite/wasm';
import { chromeBridge } from './chrome';
import type { FromWorker, Shared, ToWorker } from './protocol';
import { browserProviders, providerPlugin } from './providers';

// The page's DOM types describe a worker's self closely enough for these two.
declare const self: { postMessage(message: FromWorker, transfer: Transferable[]): void; onmessage: ((event: MessageEvent<ToWorker>) => void) | null };

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);
const providersKey = 'providers.json';
const chrome = chromeBridge(message => post(message));

// providers.json is a setting of the browser's own database.
function storedProviders(store: Store): ProvidersStorage {
	const read = () => store.setting<ProvidersFile>(providersKey) ?? browserProviders();
	return {
		read,
		update: change => { const f = change(read()); store.saveSetting(providersKey, f); return f; },
	};
}

// Every Mob tab in this browser shares one runner. The pool's file handles are
// exclusive, so the runner of one tab leads: it holds this lock, owns the
// database and serves every tab over the channel. The others follow, and wait
// for the lock to lead in turn when the leader's tab closes.
const lockName = 'mob-browser-runner';
const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('mob-browser-runner');
const share = (m: Shared) => channel?.postMessage(m);
const tab = crypto.randomUUID();
// Each runner holds a lock of its own tab's while it lives, so the leader learns when a follower's tab closed.
const tabLock = (id: string) => `mob-browser-tab-${id}`;
const held = () => new Promise<never>(() => {});
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
// A follower that hears no leader in this long is likely beside a tab of an older Mob, which does not share.
const leaderWait = 15_000;

async function start(token: string, takeover: boolean) {
	const sqlite3 = await init();
	let db, persistent = true;
	try {
		const pool = await openPool(sqlite3, takeover);
		db = new pool.OpfsSAHPoolDb('/mob.sqlite');
	} catch (e) {
		// Without OPFS, such as in some private windows, conversations last until the tab closes.
		console.warn('Mob keeps this browser’s conversations in memory: ' + String(e));
		db = new sqlite3.oo1.DB(':memory:');
		persistent = false;
	}
	const store = new Store(openWasm(db), 'web').open();
	// Chrome's built-in model answers through the page; every other provider is fetched as usual.
	const providers = new ProviderRegistry(storedProviders(store), undefined, false, chrome.fetcher((input, init) => fetch(input, init)));
	const server = new Server({ store, providers, token, version: 'web' }, [providerPlugin(providers, undefined, location.origin)]);
	return { server, persistent };
}

// A runner taking over from a closed tab may find the files still held for a moment while that tab's worker goes away.
async function openPool(sqlite3: Awaited<ReturnType<typeof init>>, takeover: boolean) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await sqlite3.installOpfsSAHPoolVfs({ name: 'mob', directory: '/mob' });
		} catch (e) {
			if (!takeover || attempt >= 10) throw e;
			await new Promise(resolve => setTimeout(resolve, 200));
		}
	}
}

let token = '';
// ready is set while this tab's runner leads.
let ready: Promise<Server> | undefined;
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
function lead(takeover: boolean): Promise<unknown> {
	const started = start(token, takeover);
	ready = started.then(s => s.server);
	failForwarded();
	return started.then(s => {
		persistent = s.persistent;
		announce(s.persistent);
		share({ type: 'leader', tab, persistent: s.persistent });
		return held();
	}, e => {
		if (announced) console.error('Mob could not take over in this tab: ' + errorText(e));
		else { announced = true; post({ type: 'failed', error: errorText(e) }); }
	});
}

async function begin() {
	if (!navigator.locks) { void lead(false); return; }
	await new Promise<void>(resolve => void navigator.locks.request(tabLock(tab), () => { resolve(); return held(); }));
	const first = await new Promise<boolean>(resolve => {
		void navigator.locks.request(lockName, { ifAvailable: true }, lock => {
			resolve(!!lock);
			return lock ? lead(false) : undefined;
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
	void navigator.locks.request(lockName, () => lead(true));
}

// watch ends the requests of a follower whose tab closed, such as its change stream.
function watch(from: string) {
	if (watched.has(from) || !navigator.locks) return;
	watched.add(from);
	void navigator.locks.request(tabLock(from), () => {
		watched.delete(from);
		for (const [key, abort] of running) if (key.startsWith(from + ':')) abort.abort();
	});
}

type Request = Extract<ToWorker, { type: 'request' }>;
type Answer = Extract<FromWorker, { type: 'head' | 'chunk' | 'end' | 'error' }>;

async function serve(server: Server, m: Request, from = '') {
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

self.onmessage = (event: MessageEvent<ToWorker>) => {
	const m = event.data;
	switch (m.type) {
		case 'init':
			if (token) return;
			token = m.token;
			void begin();
			return;
		case 'request':
			if (ready) { ready.then(server => serve(server, m), e => post({ type: 'error', id: m.id, error: errorText(e) })); return; }
			if (!announced) { post({ type: 'error', id: m.id, error: 'The browser runner has not started.' }); return; }
			forwarded.add(m.id);
			share({ ...m, from: tab });
			return;
		case 'abort':
			if (forwarded.delete(m.id)) share({ type: 'abort', from: tab, id: m.id });
			else running.get(`:${m.id}`)?.abort();
			return;
		case 'chrome-text':
		case 'chrome-end':
		case 'chrome-error':
			chrome.receive(m);
			return;
	}
};
