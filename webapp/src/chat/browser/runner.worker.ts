// The browser runner: Mob's core service in a dedicated worker, on sqlite-wasm.
// The database lives in the origin private file system, which only a worker
// can open synchronously; the page reaches the API through browserFetch.
import init from '@sqlite.org/sqlite-wasm';
import { ProviderRegistry, Server, Store, type ProvidersFile, type ProvidersStorage } from '@mob/core';
import { openWasm } from '@mob/core/sqlite/wasm';
import type { FromWorker, ToWorker } from './protocol';
import { browserProviders, providerPlugin } from './providers';

// The page's DOM types describe a worker's self closely enough for these two.
declare const self: { postMessage(message: FromWorker, transfer: Transferable[]): void; onmessage: ((event: MessageEvent<ToWorker>) => void) | null };

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);
const providersKey = 'providers.json';

// providers.json is a setting of the browser's own database.
function storedProviders(store: Store): ProvidersStorage {
	const read = () => store.setting<ProvidersFile>(providersKey) ?? browserProviders();
	return {
		read,
		update: change => { const f = change(read()); store.saveSetting(providersKey, f); return f; },
	};
}

// One tab at a time owns the database: the pool's file handles are exclusive.
async function ownDatabase() {
	if (!navigator.locks) return;
	await new Promise<void>((resolve, reject) => {
		void navigator.locks.request('mob-browser-runner', { ifAvailable: true }, lock => {
			if (!lock) { reject(new Error('Mob is already open in this browser in another tab. Close that tab, then reload this one.')); return undefined; }
			resolve();
			// The lock is held for as long as this worker lives.
			return new Promise(() => {});
		});
	});
}

async function start(token: string) {
	await ownDatabase();
	const sqlite3 = await init();
	let db, persistent = true;
	try {
		const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'mob', directory: '/mob' });
		db = new pool.OpfsSAHPoolDb('/mob.sqlite');
	} catch (e) {
		// Without OPFS, such as in some private windows, conversations last until the tab closes.
		console.warn('Mob keeps this tab’s conversations in memory: ' + String(e));
		db = new sqlite3.oo1.DB(':memory:');
		persistent = false;
	}
	const store = new Store(openWasm(db), 'web').open();
	const providers = new ProviderRegistry(storedProviders(store));
	const server = new Server({ store, providers, token, version: 'web' }, [providerPlugin(providers)]);
	return { server, persistent };
}

let ready: Promise<Server> | undefined;
const running = new Map<number, AbortController>();

async function serve(server: Server, m: Extract<ToWorker, { type: 'request' }>) {
	const abort = new AbortController();
	running.set(m.id, abort);
	try {
		const response = await server.fetch(new Request(m.url, { method: m.method, headers: m.headers, body: m.body, signal: abort.signal }));
		post({ type: 'head', id: m.id, status: response.status, headers: [...response.headers] });
		if (response.body) {
			const reader = response.body.getReader();
			abort.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true });
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = value.slice();
				post({ type: 'chunk', id: m.id, chunk }, [chunk.buffer]);
			}
		}
		post({ type: 'end', id: m.id });
	} catch (e) {
		post({ type: 'error', id: m.id, error: e instanceof Error ? e.message : String(e) });
	} finally {
		running.delete(m.id);
	}
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
	const m = event.data;
	switch (m.type) {
		case 'init': {
			if (ready) return;
			const started = start(m.token);
			ready = started.then(s => s.server);
			started.then(s => post({ type: 'ready', persistent: s.persistent }), e => post({ type: 'failed', error: e instanceof Error ? e.message : String(e) }));
			return;
		}
		case 'request':
			if (!ready) { post({ type: 'error', id: m.id, error: 'The browser runner has not started.' }); return; }
			ready.then(server => serve(server, m), e => post({ type: 'error', id: m.id, error: e instanceof Error ? e.message : String(e) }));
			return;
		case 'abort':
			running.get(m.id)?.abort();
			return;
	}
};
