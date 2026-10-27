// The browser runner: Mob's core service in a dedicated worker, on sqlite-wasm.
// The database lives in the origin private file system, which only a worker
// can open synchronously; the page reaches the API through browserFetch.
import init from '@sqlite.org/sqlite-wasm';
import { ProviderRegistry, Server, Store, type ProvidersFile, type ProvidersStorage } from '@mob/core';
import { openWasm } from '@mob/core/sqlite/wasm';
import { chromeBridge } from './chrome';
import { lockName, openSaved, sharedRunner, type Takeover } from './leader';
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

// saved says whether the pool's files exist, so this browser has kept conversations before.
async function saved() {
	try {
		const files = (await (await navigator.storage.getDirectory()).getDirectoryHandle('mob')) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
		for await (const _ of files.keys()) return true;
	} catch { /* no files, or no file system at all */ }
	return false;
}

async function start(token: string, takeover?: Takeover) {
	const sqlite3 = await init();
	// The pool caches a failed install, so a retry asks it to start over (an option its types leave out).
	const pool = await openSaved(again => sqlite3.installOpfsSAHPoolVfs({ name: 'mob', directory: '/mob', ...{ forceReinitIfPreviouslyFailed: again } }), saved, takeover);
	const db = pool ? new pool.OpfsSAHPoolDb('/mob.sqlite') : new sqlite3.oo1.DB(':memory:');
	const persistent = !!pool;
	const store = new Store(openWasm(db), 'web').open();
	// Chrome's built-in model answers through the page; every other provider is fetched as usual.
	const providers = new ProviderRegistry(storedProviders(store), undefined, false, chrome.fetcher((input, init) => fetch(input, init)));
	const server = new Server({ store, providers, token, version: 'web' }, [providerPlugin(providers, undefined, location.origin)]);
	return { server, persistent };
}

const receive = sharedRunner({
	tab: crypto.randomUUID(),
	post,
	channel: typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(lockName) as BroadcastChannel & { postMessage(m: Shared): void },
	locks: navigator.locks,
	start,
});

self.onmessage = (event: MessageEvent<ToWorker>) => {
	const m = event.data;
	if (receive(m)) return;
	switch (m.type) {
		case 'chrome-text':
		case 'chrome-end':
		case 'chrome-error':
			chrome.receive(m);
			return;
	}
};
