import type { Connection, Conversation, Snapshot } from './api';

// The browser keeps what each Mob showed last, so the workspace opens with it at once and then catches up.
// By default only the conversation list (titles) is kept; messages are kept only when the owner turns that on
// for this device. Everything here is a cache: any failure, such as a private window, just means no cache.

const dbName = 'mob-cache';
const storeName = 'entries';
const messagesKey = 'mob-cache-messages';
/** keptConversations is how many conversations' messages are kept per Mob. */
export const keptConversations = 20;

type Entry = { key: string; scope: string; kind: 'list' | 'snapshot'; id?: string; at: number; value: unknown };

/** cacheScope names the Mob a connection reaches, so two runners never share a cache. */
export function cacheScope(connection: Connection) {
	return connection.runner ? `runner:${connection.runner.id}` : `local:${connection.url}`;
}

/** keepsMessages reports whether this device keeps messages, not only titles. */
export function keepsMessages() {
	try {
		return localStorage.getItem(messagesKey) === '1';
	} catch {
		return false;
	}
}

/** setKeepsMessages turns keeping messages on or off; turning it off forgets the messages already kept. */
export async function setKeepsMessages(on: boolean) {
	try {
		if (on) localStorage.setItem(messagesKey, '1');
		else localStorage.removeItem(messagesKey);
	} catch {
		/* the setting lasts for this page only */
	}
	if (!on) await remove((entry) => entry.kind === 'snapshot');
}

// forgotten holds the Mobs this browser signed out of: writes still on their way, such as a closing
// conversation handing over its messages, are dropped instead of putting back what was forgotten.
const forgotten = new Set<string>();

/** resume lets a Mob be kept again once this browser connects to it anew. */
export function resume(scope: string) {
	forgotten.delete(scope);
}

// stamp orders writes, even several within one millisecond, so the least recent are the ones dropped.
let last = 0;
const stamp = () => (last = Math.max(Date.now(), last + 1));

let opening: Promise<IDBDatabase | undefined> | undefined;
function database() {
	opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') return resolve(undefined);
			const request = indexedDB.open(dbName, 1);
			request.onupgradeneeded = () => {
				const store = request.result.createObjectStore(storeName, { keyPath: 'key' });
				store.createIndex('scope', 'scope');
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(undefined);
			request.onblocked = () => resolve(undefined);
		} catch {
			resolve(undefined);
		}
	});
	return opening;
}

function done<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T | undefined> {
	try {
		const db = await database();
		if (!db) return undefined;
		const transaction = db.transaction(storeName, mode);
		const result = await work(transaction.objectStore(storeName));
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		return result;
	} catch {
		return undefined;
	}
}

async function remove(match: (entry: Entry) => boolean, scope?: string) {
	await withStore('readwrite', async (store) => {
		const entries = (await done(scope ? store.index('scope').getAll(scope) : store.getAll())) as Entry[];
		for (const entry of entries) if (match(entry)) store.delete(entry.key);
	});
}

export async function readList(scope: string) {
	const entry = await withStore('readonly', (store) => done(store.get(`${scope}|list`)));
	return (entry as Entry | undefined)?.value as Conversation[] | undefined;
}

export async function writeList(scope: string, list: Conversation[]) {
	if (forgotten.has(scope)) return;
	// Only what the list shows is kept.
	const value = list.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
	await withStore('readwrite', async (store) => {
		store.put({ key: `${scope}|list`, scope, kind: 'list', at: stamp(), value } satisfies Entry);
	});
}

export async function readSnapshot(scope: string, id: string) {
	if (!keepsMessages()) return undefined;
	const entry = await withStore('readonly', (store) => done(store.get(`${scope}|snapshot|${id}`)));
	const snapshot = (entry as Entry | undefined)?.value as Snapshot | undefined;
	// Whether a turn runs is only known from Mob itself; a kept snapshot never claims one does.
	return snapshot && { ...snapshot, active: false };
}

/** writeSnapshot keeps a conversation's messages, when this device keeps messages, dropping the least recent beyond the limit. */
export async function writeSnapshot(scope: string, id: string, snapshot: Snapshot) {
	if (!keepsMessages() || forgotten.has(scope)) return;
	await withStore('readwrite', async (store) => {
		store.put({ key: `${scope}|snapshot|${id}`, scope, kind: 'snapshot', id, at: stamp(), value: snapshot } satisfies Entry);
		const kept = ((await done(store.index('scope').getAll(scope))) as Entry[])
			.filter((entry) => entry.kind === 'snapshot')
			.sort((a, b) => b.at - a.at);
		for (const entry of kept.slice(keptConversations)) store.delete(entry.key);
	});
}

/** forget removes everything kept for a Mob, as when this browser signs out of it. */
export async function forget(scope: string) {
	forgotten.add(scope);
	await remove(() => true, scope);
}
